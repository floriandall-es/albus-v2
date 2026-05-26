import logging
import os

from apscheduler.schedulers.background import BackgroundScheduler
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles

from app.core.config import settings
from app.services.meeting_reminders import tick as meeting_reminders_tick
from app.routes import (
    admin_dashboard,
    auth,
    availability,
    categories,
    dms,
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
    schedules,
    servicios,
    shift_swaps,
    slot_dependencies,
    slots,
    stats,
    team,
    team_bulk,
    transplants,
)

app = FastAPI(title="Trivu API", version="0.1.0")

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

# Serve user-uploaded profile photos. The directory is mounted from a
# host volume in prod (/srv/albus/avatars). We create it on startup so
# fresh dev containers don't 500 on the first request.
os.makedirs(settings.avatars_dir, exist_ok=True)
app.mount(
    "/api/avatars",
    StaticFiles(directory=settings.avatars_dir),
    name="avatars",
)


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


@app.on_event("startup")
def _start_background_jobs() -> None:
    global _scheduler
    if os.environ.get("PYTEST_CURRENT_TEST"):
        return
    if _scheduler is not None:
        return
    _scheduler = BackgroundScheduler(daemon=True, timezone="Europe/Madrid")
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
    _scheduler.start()
    logging.getLogger("app").info("Background scheduler started.")


@app.on_event("shutdown")
def _stop_background_jobs() -> None:
    global _scheduler
    if _scheduler is not None:
        _scheduler.shutdown(wait=False)
        _scheduler = None
