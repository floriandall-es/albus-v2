import functools
import logging
import os
import time
from uuid import uuid4

import anyio
from apscheduler.events import EVENT_JOB_ERROR
from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.services.alerting import alert_exception
from app.services.billing_emails import tick as billing_emails_tick
from app.services.meeting_reminders import tick as meeting_reminders_tick
from app.services.pulse import tick as pulse_tick
from app.routes import (
    admin_dashboard,
    admin_promotion,
    auth,
    availability,
    billing,
    categories,
    dms,
    founder,
    health,
    holidays,
    hospital_directory,
    incidents,
    invitations,
    me,
    meetings,
    onboarding,
    periodos,
    public_catalog,
    pulse,
    push,
    realtime,
    schedules,
    servicios,
    shift_swaps,
    slot_dependencies,
    slots,
    stats,
    stripe_webhook,
    team,
    team_bulk,
    transplants,
)

app = FastAPI(title="Trivu API", version="0.1.0")

_request_log = logging.getLogger("app.request")


class RequestContextMiddleware:
    """Pure-ASGI request-ID + 5xx logging.

    Deliberately NOT a Starlette BaseHTTPMiddleware (`@app.middleware`):
    BaseHTTPMiddleware buffers the response, which breaks long-lived
    streaming responses — and we have one (the chat SSE stream at
    /api/realtime/stream). A raw ASGI middleware passes bytes straight
    through, so streaming is unaffected.

    What it does:
      - attaches a request id (honours an inbound X-Request-ID, else a
        fresh short uuid) and echoes it back in the X-Request-ID
        response header so support can correlate a user report with the
        server logs;
      - logs a structured line for any 5xx response or unhandled
        exception (method, path, status, request id, duration).

    The Sentry hook (P1 follow-up) attaches here once a DSN is set.
    """

    def __init__(self, app):
        self.app = app

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        inbound = dict(scope.get("headers") or {}).get(b"x-request-id")
        rid = inbound.decode("latin-1") if inbound else uuid4().hex[:16]
        method = scope.get("method", "?")
        path = scope.get("path", "?")
        start = time.monotonic()
        status_code = 0

        async def send_wrapper(message):
            nonlocal status_code
            if message["type"] == "http.response.start":
                status_code = message.get("status", 0)
                headers = list(message.get("headers") or [])
                headers.append((b"x-request-id", rid.encode("latin-1")))
                message["headers"] = headers
            await send(message)

        try:
            await self.app(scope, receive, send_wrapper)
        except Exception as exc:
            dur_ms = (time.monotonic() - start) * 1000
            _request_log.exception(
                "unhandled_error rid=%s %s %s dur=%.0fms",
                rid, method, path, dur_ms,
            )
            # Push alert (in-house, throttled). Offloaded to a worker
            # thread so the blocking SMTP send never stalls the event
            # loop — important on a single-worker deploy.
            await anyio.to_thread.run_sync(
                functools.partial(
                    alert_exception,
                    key=f"req:{type(exc).__name__}:{path}",
                    subject=f"500 {method} {path}",
                    exc=exc,
                    context=f"request_id={rid} {method} {path}",
                )
            )
            raise
        if status_code >= 500:
            dur_ms = (time.monotonic() - start) * 1000
            _request_log.error(
                "server_error rid=%s %s %s status=%s dur=%.0fms",
                rid, method, path, status_code, dur_ms,
            )


app.add_middleware(RequestContextMiddleware)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_origin_regex=r"https?://([a-z0-9-]+\.)?localhost(:\d+)?",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api")
app.include_router(auth.router, prefix="/api")
app.include_router(me.router, prefix="/api")
app.include_router(categories.router, prefix="/api")
app.include_router(slots.router, prefix="/api")
app.include_router(slot_dependencies.router, prefix="/api")
app.include_router(team.router, prefix="/api")
app.include_router(team_bulk.router, prefix="/api")
app.include_router(admin_promotion.router, prefix="/api")
app.include_router(invitations.router, prefix="/api")
app.include_router(onboarding.router, prefix="/api")
app.include_router(holidays.router, prefix="/api")
app.include_router(availability.router, prefix="/api")
app.include_router(schedules.router, prefix="/api")
app.include_router(shift_swaps.router, prefix="/api")
app.include_router(stats.router, prefix="/api")
app.include_router(incidents.router, prefix="/api")
app.include_router(meetings.router, prefix="/api")
app.include_router(transplants.router, prefix="/api")
app.include_router(hospital_directory.router, prefix="/api")
app.include_router(dms.router, prefix="/api")
app.include_router(admin_dashboard.router, prefix="/api")
app.include_router(servicios.router, prefix="/api")
app.include_router(public_catalog.router, prefix="/api")
app.include_router(periodos.router, prefix="/api")
app.include_router(founder.router, prefix="/api")
app.include_router(stripe_webhook.router, prefix="/api")
app.include_router(billing.router, prefix="/api")
app.include_router(push.router, prefix="/api")
app.include_router(pulse.router, prefix="/api")
app.include_router(realtime.router, prefix="/api")

# Serve user-uploaded profile photos. The directory is mounted from a
# host volume in prod (/srv/albus/avatars). We create it on startup so
# fresh dev containers don't 500 on the first request.
os.makedirs(settings.avatars_dir, exist_ok=True)
app.mount(
    "/api/avatars",
    StaticFiles(directory=settings.avatars_dir),
    name="avatars",
)

# Chat voice notes (migration 0093). NOT mounted as static — clinical
# audio is access-controlled and streamed through
# GET /api/voice-notes/{id}/audio after a membership check. We only
# ensure the directory exists so the first upload doesn't 500.
os.makedirs(settings.voice_notes_dir, exist_ok=True)


# ---------------------------------------------------------------------------
# Background scheduler (migration 0066: meeting reminders)
# ---------------------------------------------------------------------------
#
# APScheduler runs as a daemon thread inside the FastAPI process and
# ticks every 5 minutes. The tick scans all configured meeting
# reminders, computes which ones are due in the last 30 minutes, and
# emails their invitees. Idempotent: an INSERT into
# `meeting_reminders_sent` carries a UNIQUE constraint on
# (meeting_id, instance_date) so a restart-mid-tick or a multi-replica
# deploy can never produce a duplicate email.
#
# Skip starting the scheduler under pytest — tests instantiate the app
# multiple times and we don't want background ticks polluting them.

_scheduler: BackgroundScheduler | None = None


def _on_job_error(event) -> None:
    """APScheduler error listener. Background ticks (meeting reminders,
    billing emails, pulse fan-out) run in a daemon thread; an exception
    there otherwise vanishes into APScheduler's own logger with no
    signal. Surface it loudly with the job id + traceback — this is the
    single place the Sentry capture hooks in once a DSN is set."""
    logging.getLogger("app.scheduler").error(
        "background_job_failed id=%s", event.job_id, exc_info=event.exception
    )
    exc = getattr(event, "exception", None)
    if exc is not None:
        # Runs on APScheduler's worker thread (no event loop), so a
        # direct blocking send is fine here.
        alert_exception(
            key=f"job:{event.job_id}",
            subject=f"Background job failed: {event.job_id}",
            exc=exc,
            context=f"job_id={event.job_id}",
        )


@app.on_event("startup")
def _start_background_jobs() -> None:
    global _scheduler
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(daemon=True, timezone="Europe/Madrid")
    _scheduler.add_listener(_on_job_error, EVENT_JOB_ERROR)
    _scheduler.add_job(
        meeting_reminders_tick,
        trigger="interval",
        minutes=5,
        id="meeting_reminders",
        # Coalesce: if the process was paused (laptop sleep, GC pause,
        # whatever) and we missed several intervals, run the job once
        # rather than catching up N times.
        coalesce=True,
        # Tolerate jobs that overlap a tick by up to 5 min before
        # APScheduler logs a warning.
        misfire_grace_time=300,
        max_instances=1,
    )
    # Migration 0082: daily billing-email tick. Fires trial-ending
    # nudges (days 7/3/1 before trial_end_at) to admins (any model)
    # and members (members_pay). Runs at 09:00 Europe/Madrid — early
    # enough that a Spanish inbox sees it during the morning round,
    # late enough to skip workers on the night shift.
    # Idempotency via the billing_emails_sent table; the same tick
    # firing twice in one day cannot double-send. See
    # app/services/billing_emails.py.
    _scheduler.add_job(
        billing_emails_tick,
        trigger="cron",
        hour=9,
        minute=0,
        id="billing_emails",
        coalesce=True,
        misfire_grace_time=3600,
        max_instances=1,
    )
    # Migration 0090: pulse weekly fan-out. The tick is gated
    # internally — it only fires for tenants with enabled=true
    # AND last_notified_week_iso != current week. Running every
    # 5 minutes is overkill cron-wise but matches the meeting
    # reminders cadence, keeps the moving parts small, and gives
    # us up to a 5-min slip on the "fire at 14:00 Friday"
    # promise (acceptable for a weekly nudge).
    _scheduler.add_job(
        pulse_tick,
        trigger="interval",
        minutes=5,
        id="pulse_weekly",
        coalesce=True,
        misfire_grace_time=300,
        max_instances=1,
    )
    _scheduler.start()
    logging.getLogger("app").info("Background scheduler started.")


@app.on_event("startup")
async def _bind_realtime_loop() -> None:
    """Capture the running event loop for the chat SSE broker so sync
    (threadpool) request handlers can publish events onto it
    thread-safely. Async handler so get_running_loop() returns the
    loop the SSE streams actually run on."""
    import asyncio

    from app.services.realtime import broker

    broker.bind_loop(asyncio.get_running_loop())
    logging.getLogger("app").info("Realtime broker bound to event loop.")


@app.on_event("shutdown")
def _stop_background_jobs() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
