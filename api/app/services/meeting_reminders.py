"""Meeting reminders worker (migration 0066).

Fires email reminders some number of minutes before each meeting
instance. Runs as a single APScheduler tick inside the FastAPI
process — see app/main.py for the wiring. The whole module is
designed to be safe to call from any context (the API process,
a one-off `python -m` invocation, a test), and idempotent against
restarts / parallel ticks via the UNIQUE(meeting_id, instance_date)
constraint on `meeting_reminders_sent`.

What "due" means
----------------
A reminder is due when *the current tick's window* (now − lookback,
now] contains the instant `instance_start − reminder_minutes_before`.
The lookback (default 30 min) catches the case where the container
restarted mid-tick or the previous tick was slow — we'd rather send
a slightly-late reminder than skip one entirely. The UNIQUE
constraint prevents an actually-late tick from re-emailing a
reminder that already went out.

Timezone
--------
Spain only for now (every customer). Meeting `date` + `start_time`
are stored as naive local values; we localise to Europe/Madrid
before comparing with `now`. If we ever onboard a customer outside
Spain, add `Tenant.timezone` and read it here.
"""

from __future__ import annotations

import logging
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.core.config import settings
from app.db.session import AdminSessionLocal
from app.models import (
    Meeting,
    MeetingAudienceGroup,
    MeetingAudiencePerson,
    MeetingReminderSent,
    Membership,
    Person,
)
from app.services.email import send_email, should_email_person
from app.services.email_templates import meeting_reminder_email

logger = logging.getLogger("app.meeting_reminders")

# Allowed reminder offsets (minutes). Mirrors the Literal in
# api/app/schemas/meeting.py and the CHECK constraint in
# alembic/versions/0066_meeting_reminders.py. Keep in lockstep.
REMINDER_OFFSETS: tuple[int, ...] = (15, 60, 180, 1440, 10080)

# Single tenant timezone for v1. Add Tenant.timezone if/when we go
# international.
_TZ = ZoneInfo("Europe/Madrid")

# How far back we look for "due" reminders on each tick. Should be
# meaningfully larger than the tick interval so a missed tick still
# fires its reminders on the next one.
DEFAULT_LOOKBACK = timedelta(minutes=30)


def _weekday_dates_between(
    weekday: int, from_d: date, to_d: date
) -> list[date]:
    """All dates in [from_d, to_d] whose weekday() matches `weekday`."""
    if to_d < from_d:
        return []
    out: list[date] = []
    cur = from_d
    while cur <= to_d:
        if cur.weekday() == weekday:
            out.append(cur)
        cur += timedelta(days=1)
    return out


def _resolve_recipients(db: Session, m: Meeting) -> list[Person]:
    """Audience snapshot at fire time: the union of
    include_main_team (every active main-team person in the
    tenant), each group's active members, and individually-named
    persons. Filters out pendientes (no password set) and people
    we've been asked not to email."""
    person_ids: set[int] = set()

    # Main team (group_id IS NULL).
    if m.include_main_team:
        rows = (
            db.query(Membership.person_id)
            .filter(
                Membership.tenant_id == m.tenant_id,
                Membership.disabled_at.is_(None),
                Membership.group_id.is_(None),
            )
            .all()
        )
        person_ids.update(r[0] for r in rows)

    # Whole sub-equipos.
    group_ids = [
        r[0]
        for r in db.query(MeetingAudienceGroup.group_id)
        .filter(MeetingAudienceGroup.meeting_id == m.id)
        .all()
    ]
    if group_ids:
        rows = (
            db.query(Membership.person_id)
            .filter(
                Membership.tenant_id == m.tenant_id,
                Membership.disabled_at.is_(None),
                Membership.group_id.in_(group_ids),
            )
            .all()
        )
        person_ids.update(r[0] for r in rows)

    # Individually-named persons.
    named = [
        r[0]
        for r in db.query(MeetingAudiencePerson.person_id)
        .filter(MeetingAudiencePerson.meeting_id == m.id)
        .all()
    ]
    person_ids.update(named)

    if not person_ids:
        return []

    persons = (
        db.query(Person)
        .filter(Person.id.in_(person_ids))
        .all()
    )
    return [p for p in persons if should_email_person(p.hashed_password)]


def _instance_dates_in_window(
    m: Meeting, window_start: date, window_end: date
) -> list[date]:
    """Concrete dates the meeting occurs in [window_start, window_end].

    Ad-hoc meetings produce one date (or zero if outside the window);
    regular templates produce one per matching weekday."""
    if m.kind == "ad_hoc":
        if m.date is None:
            return []
        return [m.date] if window_start <= m.date <= window_end else []
    if m.kind == "regular" and m.weekday is not None:
        return _weekday_dates_between(m.weekday, window_start, window_end)
    return []


def _format_when(reminder_at: datetime, instance_at: datetime) -> str:
    """Human-readable Spanish phrase for the email subject + body
    based on how far in the future the instance is from the reminder
    moment. Examples:

      - "en 15 minutos"      (offset < 60 min)
      - "dentro de 1 hora"   (offset 60-180 min)
      - "mañana a las 10:00" (same wallclock day as reminder + 1)
      - "el lunes 12 de mayo a las 10:00" (longer)
    """
    today = reminder_at.date()
    tomorrow = today + timedelta(days=1)
    days_ahead = (instance_at.date() - today).days
    hhmm = instance_at.strftime("%H:%M")
    if days_ahead == 0:
        # Same day. Differentiate by how soon.
        delta = instance_at - reminder_at
        mins = int(round(delta.total_seconds() / 60))
        if mins < 60:
            return f"en {max(mins, 1)} minutos (hoy a las {hhmm})"
        hrs = mins // 60
        unit = "hora" if hrs == 1 else "horas"
        return f"en {hrs} {unit} (hoy a las {hhmm})"
    if instance_at.date() == tomorrow:
        return f"mañana a las {hhmm}"
    # Further out — name the weekday.
    weekday_es = [
        "lunes",
        "martes",
        "miércoles",
        "jueves",
        "viernes",
        "sábado",
        "domingo",
    ][instance_at.weekday()]
    months_es = [
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
    ]
    day = instance_at.day
    month = months_es[instance_at.month - 1]
    return f"el {weekday_es} {day} de {month} a las {hhmm}"


def _organizer_name(db: Session, m: Meeting) -> str | None:
    if m.organizer_membership_id is None:
        return None
    membership = db.get(Membership, m.organizer_membership_id)
    if not membership:
        return None
    person = db.get(Person, membership.person_id)
    return person.name if person else None


def send_due_reminders(
    db: Session,
    now: datetime | None = None,
    lookback: timedelta = DEFAULT_LOOKBACK,
) -> int:
    """Find every (meeting, instance_date) whose reminder time falls
    in the window (now − lookback, now], hasn't already been sent,
    and email every current invitee.

    Returns the number of (meeting, instance) tuples that were
    emailed in this tick (not the number of individual emails).
    """
    now_utc = (now or datetime.now(tz=ZoneInfo("UTC"))).astimezone(_TZ)
    window_start = now_utc - lookback

    # Pre-filter: only look at meetings with a reminder configured.
    # Then we still need to scan a date window: the furthest future
    # reminder is 1 week (10080 min), so we need to consider instances
    # from `now` up to `now + max_offset + lookback`.
    candidates = (
        db.query(Meeting)
        .filter(Meeting.reminder_minutes_before.isnot(None))
        .all()
    )
    if not candidates:
        return 0

    max_offset_min = max(REMINDER_OFFSETS)
    window_end_date = (
        now_utc + timedelta(minutes=max_offset_min) + lookback
    ).date()
    window_start_date = (window_start - timedelta(days=1)).date()

    sent_count = 0
    for m in candidates:
        try:
            sent_count += _process_meeting(
                db, m, now_utc, window_start, window_start_date, window_end_date
            )
        except Exception:  # noqa: BLE001
            logger.exception(
                "Failed to process reminders for meeting %s", m.id
            )
    return sent_count


def _process_meeting(
    db: Session,
    m: Meeting,
    now_local: datetime,
    window_start: datetime,
    window_start_date: date,
    window_end_date: date,
) -> int:
    offset = int(m.reminder_minutes_before or 0)
    if offset <= 0:
        return 0
    dates = _instance_dates_in_window(m, window_start_date, window_end_date)
    if not dates:
        return 0

    sent = 0
    for d in dates:
        instance_local = datetime.combine(d, m.start_time).replace(tzinfo=_TZ)
        reminder_at = instance_local - timedelta(minutes=offset)
        if not (window_start < reminder_at <= now_local):
            continue
        # Idempotency: try to insert the log row first. If a
        # concurrent tick beat us to it the UNIQUE constraint trips
        # and we skip silently.
        recipients = _resolve_recipients(db, m)
        if not recipients:
            # Still record it so we don't keep re-trying every tick
            # for an audience that resolved to zero people.
            recipient_count = 0
        else:
            recipient_count = len(recipients)

        log = MeetingReminderSent(
            tenant_id=m.tenant_id,
            meeting_id=m.id,
            instance_date=d,
            recipient_count=recipient_count,
        )
        db.add(log)
        try:
            db.commit()
        except IntegrityError:
            db.rollback()
            continue

        if not recipients:
            continue

        organizer_name = _organizer_name(db, m)
        app_url = f"{settings.public_base_url.rstrip('/')}/me/reuniones"
        when_label = _format_when(now_local, instance_local)
        for p in recipients:
            first = (p.first_name or p.name or "").strip() or "hola"
            subject, body = meeting_reminder_email(
                recipient_first_name=first,
                title=m.title,
                when_label=when_label,
                location=m.location,
                organizer_name=organizer_name,
                description=m.description,
                app_url=app_url,
            )
            send_email(to=p.email, subject=subject, body_text=body)
        sent += 1
    return sent


def tick() -> None:
    """APScheduler entry point. Opens an AdminSession (owner role,
    no RLS) because the worker has to scan meetings across every
    tenant in one pass. Logs (rather than re-raises) on failure to
    keep the scheduler alive across transient DB hiccups."""
    try:
        with AdminSessionLocal() as db:
            count = send_due_reminders(db)
            if count:
                logger.info(
                    "meeting reminders: emailed %d instance(s)", count
                )
    except Exception:  # noqa: BLE001
        logger.exception("meeting reminders tick failed")
