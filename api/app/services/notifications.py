"""Operational push helpers — shared wrappers around push + email
so each route doesn't have to repeat the "try push first, fall
back to email" plumbing.

Two flavours:

  * try_push_or_email(person, push=..., email=...) — for events
    that already have an email template (swaps, admin promotion,
    etc.). Sends push if the person has active subscriptions;
    otherwise sends email. Mirrors the dms._maybe_notify_unread
    pattern: push is the primary channel, email is the fallback
    so people without push are still reachable.

  * push_only(person, ...) — for events where there's no email
    counterpart (bloqueos, today). Sends push if subscribed,
    silently skips otherwise.

Both helpers tolerate `person=None` and skip pendientes
(hashed_password IS NULL) on the email path — same guards the
existing email call sites use.

URL shape: callers pass a relative path. We prepend
settings.public_base_url here so the path concatenation is in
one place and routes don't sprinkle .rstrip("/") logic
everywhere.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass

from app.core.config import settings
from app.models.person import Person
from app.services.email import send_email, should_email_person
from app.services.push import (
    has_active_subscriptions,
    send_push_to_person,
)


logger = logging.getLogger("app.notifications")


@dataclass
class PushPayload:
    """Common shape every push uses. `tag` controls OS-side
    coalescing (multiple pushes with the same tag collapse into
    one notification on the device — useful for noisy threads
    like "swap response on offer 42")."""

    title: str
    body: str
    # Relative path; the helper prefixes settings.public_base_url.
    path: str
    tag: str


@dataclass
class EmailPayload:
    """Pre-rendered subject + body. Callers build these from the
    relevant email_templates.py helper."""

    subject: str
    body: str


def try_push_or_email(
    person: Person | None,
    *,
    push: PushPayload,
    email: EmailPayload,
) -> None:
    """Push when subscribed; email otherwise. Skips silently when
    person is None or is a pendiente without a hashed password.

    Failures inside push (network blip, push service 5xx) fall
    through to email — same fail-safe as the DM path."""
    if person is None:
        return
    if has_active_subscriptions(person.id):
        sent = send_push_to_person(
            person.id,
            title=push.title,
            body=push.body,
            url=_full_url(push.path),
            tag=push.tag,
        )
        if sent > 0:
            return
        # All push attempts errored or 410'd — fall through to
        # email so the recipient isn't silently missed.
    if not should_email_person(person.hashed_password):
        return
    send_email(person.email, email.subject, email.body)


def push_only(
    person: Person | None,
    *,
    push: PushPayload,
) -> None:
    """Push when subscribed; silently skip when not. Used by event
    types where we deliberately don't want an email — bloqueos
    today. Members without push subscriptions still see the
    state change next time they open the app."""
    if person is None:
        return
    if not has_active_subscriptions(person.id):
        return
    send_push_to_person(
        person.id,
        title=push.title,
        body=push.body,
        url=_full_url(push.path),
        tag=push.tag,
    )


def _full_url(path: str) -> str:
    return f"{settings.public_base_url.rstrip('/')}{path}"
