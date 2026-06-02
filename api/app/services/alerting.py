"""In-house error alerting — the lean alternative to Sentry.

Emails the founder on unhandled 500s and background-job failures,
throttled per error so a repeating fault doesn't flood the inbox.
Pairs with the structured logging in app.main (logs always fire; alerts
are the push notification on top).

Recipient is `settings.ops_alert_email`. Unset → no-op (we still have
the logs), so dev / unconfigured envs stay silent. The throttle is an
in-process dict, which is correct here: prod runs a single uvicorn
worker (the SSE broker requires it), so there's one process to dedupe
against.
"""
from __future__ import annotations

import logging
import time
import traceback

from app.core.config import settings
from app.services.email import send_email

logger = logging.getLogger("app.alerting")

# dedupe key -> last-sent monotonic seconds. Same key re-alerts at most
# once per window; everything in between is logged but not emailed.
_last_sent: dict[str, float] = {}
_THROTTLE_SECONDS = 30 * 60  # 30 min


def alert_error(key: str, subject: str, detail: str) -> None:
    """Email an ops alert, throttled by `key`. Best-effort — never
    raises (send_email already swallows its own errors; we guard the
    rest)."""
    recipient = settings.ops_alert_email
    if not recipient:
        return
    now = time.monotonic()
    last = _last_sent.get(key)
    if last is not None and (now - last) < _THROTTLE_SECONDS:
        return
    _last_sent[key] = now
    try:
        send_email(to=recipient, subject=f"[Trivu] {subject}", body_text=detail)
    except Exception:
        logger.exception("alerting: failed to send alert email")


def alert_exception(
    key: str, subject: str, exc: BaseException, context: str = ""
) -> None:
    """Format `exc`'s traceback and alert. `context` is a free-text
    prefix (request id, route, job id…)."""
    tb = "".join(
        traceback.format_exception(type(exc), exc, exc.__traceback__)
    )
    detail = f"{context}\n\n{tb}" if context else tb
    alert_error(key, subject, detail)
