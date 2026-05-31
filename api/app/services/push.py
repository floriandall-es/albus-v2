"""Web Push delivery — pywebpush wrapper around the
push_subscriptions table.

Two callers today:
  - app/routes/dms.py::_maybe_notify_unread fans out to every member
    of a conversation when a new message arrives. Push is the first
    attempt; if a recipient has no active subscriptions (or all
    attempts return 410 Gone), the route falls back to the existing
    email path with its 2-day cooldown.

Design notes:
  - Each row in push_subscriptions is one device. A single recipient
    can have many; we attempt all of them in parallel-ish (sequential
    in this file — pywebpush is sync, the per-call cost is small and
    one DM hitting a few subs is not worth the complexity of a thread
    pool). Failures on one device don't abort the others.
  - 410 Gone from the push service means the browser uninstalled or
    cleared data. We delete the row immediately so subsequent
    notifications don't re-try a dead endpoint.
  - Other errors (network blip, push service 500) are logged and
    swallowed; the email fallback in the caller doesn't fire on
    those because *some* subscription succeeded enough to count as
    "push handled". If we ever want belt+braces (push AND email on
    transient failures), revisit here.
  - `tag` field on the payload is the key UX gotcha: browsers
    coalesce notifications with the same tag, so multiple messages
    in the same conversation collapse into one notification on the
    device instead of stacking. Pass `tag="conversation:<id>"` for
    DM/group fan-outs.

Configuration check is lazy: VAPID keys must be set in env for any
push to fire. If they're not (dev without VAPID, or prod boot before
env is filled in), `is_configured()` returns False and `send_push`
silently no-ops — callers don't need to gate every call site, but
they should still call `has_active_subscriptions` to decide whether
to fall back to email.
"""

from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import text

from app.core.config import settings
from app.db.session import AdminSessionLocal


logger = logging.getLogger("app.push")


def is_configured() -> bool:
    """True when VAPID env vars are present. False means push sends
    are silently no-op'd and `send_push_to_person` returns 0."""
    return bool(
        settings.vapid_public_key
        and settings.vapid_private_key
        and settings.vapid_subject
    )


def has_active_subscriptions(person_id: int) -> bool:
    """True when the person has at least one push subscription on
    file. Used by callers (e.g. _maybe_notify_unread) to decide
    whether the push path will cover the recipient, or whether the
    email fallback is needed instead.

    Cheap query — single SELECT EXISTS, indexed by person_id."""
    if not is_configured():
        return False
    with AdminSessionLocal() as adb:
        row = adb.execute(
            text(
                """
                SELECT 1 FROM push_subscriptions
                WHERE person_id = :pid LIMIT 1
                """
            ),
            {"pid": person_id},
        ).first()
    return row is not None


def send_push_to_person(
    person_id: int,
    *,
    title: str,
    body: str,
    url: str,
    tag: str | None = None,
    timestamp_ms: int | None = None,
) -> int:
    """Fan out a push to every subscription the person has.

    Returns the number of subscriptions that accepted the push. 0
    means either VAPID isn't configured, the person has no
    subscriptions, or every subscription was either 410'd (and
    deleted) or errored. Callers use a 0 return as the signal to
    fall back to email.

    `tag` collapses repeat notifications for the same logical
    "thread" on the device — pass `conversation:<id>` for DM fan-outs
    so a noisy chat doesn't stack five separate notifications.

    `timestamp_ms` is the epoch-ms time the underlying event happened
    (e.g. when the message was sent). Platforms that render a
    notification timestamp use it; iOS ignores it. Optional — omit
    and the device stamps "now".
    """
    if not is_configured():
        return 0
    # Lazy import — pywebpush is heavyish + brings in cryptography.
    # Keeps API boot fast when push isn't configured.
    from pywebpush import WebPushException, webpush

    payload = json.dumps(
        {
            "title": title,
            "body": body,
            "url": url,
            "tag": tag,
            "timestamp": timestamp_ms,
        }
    )
    vapid_claims = {"sub": settings.vapid_subject}
    succeeded = 0
    with AdminSessionLocal() as adb:
        rows = adb.execute(
            text(
                """
                SELECT id, endpoint, p256dh, auth
                FROM push_subscriptions
                WHERE person_id = :pid
                """
            ),
            {"pid": person_id},
        ).mappings().all()
        if not rows:
            return 0
        now = datetime.now(timezone.utc)
        dead_sub_ids: list[int] = []
        for sub in rows:
            try:
                webpush(
                    subscription_info={
                        "endpoint": sub["endpoint"],
                        "keys": {
                            "p256dh": sub["p256dh"],
                            "auth": sub["auth"],
                        },
                    },
                    data=payload,
                    vapid_private_key=settings.vapid_private_key,
                    vapid_claims=dict(vapid_claims),
                )
            except WebPushException as exc:
                # 410 Gone = subscription is permanently dead
                # (user uninstalled the PWA, cleared site data,
                # revoked permission). Drop the row so we don't
                # waste retries.
                status = getattr(exc.response, "status_code", None)
                if status == 410:
                    dead_sub_ids.append(sub["id"])
                else:
                    # Transient: network, push service 5xx, payload
                    # too big. Log and move on — the next message
                    # will retry.
                    logger.warning(
                        "push send failed (status=%s) for sub %s: %s",
                        status,
                        sub["id"],
                        exc,
                    )
                continue
            except Exception:  # noqa: BLE001
                # Library-level error (cert issue, bad keys, etc).
                # Same treatment as transient — log and continue.
                logger.exception(
                    "push send raised unexpected error for sub %s",
                    sub["id"],
                )
                continue
            succeeded += 1
            # Stamp last_used_at so the "manage devices" panel can
            # show humans which subscription is alive. Done with a
            # single UPDATE per success — fine at our scale.
            adb.execute(
                text(
                    """
                    UPDATE push_subscriptions
                    SET last_used_at = :ts
                    WHERE id = :id
                    """
                ),
                {"id": sub["id"], "ts": now},
            )
        if dead_sub_ids:
            adb.execute(
                text(
                    "DELETE FROM push_subscriptions "
                    "WHERE id = ANY(:ids)"
                ),
                {"ids": dead_sub_ids},
            )
            logger.info(
                "pruned %d dead push subscriptions",
                len(dead_sub_ids),
            )
        adb.commit()
    return succeeded


__all__: list[Any] = [
    "is_configured",
    "has_active_subscriptions",
    "send_push_to_person",
]
