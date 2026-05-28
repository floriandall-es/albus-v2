"""iCalendar (RFC 5545) export for a member's own shifts.

Used by `GET /api/me/shifts.ics` so a user can drop their published
turnos into Apple/Google/Outlook Calendar as a one-shot download.

Design notes
------------
- We emit UTC times (`YYYYMMDDTHHMMSSZ`). The slot's wall-clock
  start/end are interpreted in Europe/Madrid (Trivu's v1 market is
  Spain; future tenants can override once `tenants.timezone` exists)
  and converted to UTC before serialisation. No `VTIMEZONE` block
  needed → smaller payload, every calendar app renders it correctly.
- Slots with no `start_time`/`end_time` become all-day events
  (`DTSTART;VALUE=DATE`).
- Overnight slots (`end <= start`) emit a `DTEND` on the next day.
- UID is stable per assignment id so a re-download UPDATES the
  existing event in the calendar instead of duplicating it.
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

# Europe/Madrid — Trivu v1 market. Hoisted to a constant so the day
# we add a `tenants.timezone` column we only flip this in one place
# (route hands the tenant tz in, defaults to this).
DEFAULT_TZ = ZoneInfo("Europe/Madrid")


@dataclass
class IcsEvent:
    """Input shape for one VEVENT. Route layer builds these out of
    Assignment + Slot + SlotTeamRole rows."""

    assignment_id: int
    shift_date: date
    slot_name: str
    role_label: str | None
    start_time: time | None
    end_time: time | None


def build_member_calendar(
    *,
    events: list[IcsEvent],
    tenant_name: str,
    person_name: str,
    host: str,
    tz: ZoneInfo = DEFAULT_TZ,
    now: datetime | None = None,
) -> str:
    """Render the .ics body. Caller is responsible for the HTTP
    wrapping (Content-Type / Content-Disposition headers)."""
    now_utc = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    stamp = _fmt_utc(now_utc)

    lines: list[str] = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "PRODID:-//Trivu//Schedule Export 1.0//ES",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        # X-WR-* are non-standard but every consumer (Apple, Google,
        # Outlook) reads them — gives the imported calendar a
        # human-friendly name.
        f"X-WR-CALNAME:{_escape(f'Turnos {person_name} — {tenant_name}')}",
        f"X-WR-TIMEZONE:{tz.key}",
    ]
    for ev in events:
        lines.extend(_render_event(ev, host=host, tz=tz, stamp=stamp))
    lines.append("END:VCALENDAR")
    # RFC 5545 requires CRLF line endings. Lots of consumers accept
    # \n but Outlook is famously strict — emit CRLF and be safe.
    return "\r\n".join(lines) + "\r\n"


def _render_event(
    ev: IcsEvent, *, host: str, tz: ZoneInfo, stamp: str
) -> list[str]:
    uid = f"assignment-{ev.assignment_id}@{host}"
    # Role first, slot second when both are present. Calendar apps
    # truncate long titles (especially in the month view: Apple
    # Calendar shows ~10 chars, Google ~15) — leading with the role
    # ("Cirujano principal · Quirófano") means the discriminating
    # bit survives the cut. The slot alone is usually less useful
    # to a clinician glancing at the day ("Quirófano" tells them
    # nothing about WHAT they're doing on it).
    if ev.role_label:
        summary = f"{ev.role_label} · {ev.slot_name}"
    else:
        summary = ev.slot_name

    lines = [
        "BEGIN:VEVENT",
        f"UID:{uid}",
        f"DTSTAMP:{stamp}",
        f"SUMMARY:{_escape(summary)}",
    ]

    if ev.start_time is None or ev.end_time is None:
        # All-day. DTEND is exclusive in RFC 5545, so a single-day
        # event uses next-day DTEND.
        lines.append(f"DTSTART;VALUE=DATE:{_fmt_date(ev.shift_date)}")
        lines.append(
            f"DTEND;VALUE=DATE:{_fmt_date(ev.shift_date + timedelta(days=1))}"
        )
    else:
        start_local = datetime.combine(ev.shift_date, ev.start_time, tzinfo=tz)
        end_date = ev.shift_date
        # Overnight slot: end time <= start time means the shift wraps
        # into the next day.
        if ev.end_time <= ev.start_time:
            end_date = ev.shift_date + timedelta(days=1)
        end_local = datetime.combine(end_date, ev.end_time, tzinfo=tz)
        lines.append(f"DTSTART:{_fmt_utc(start_local.astimezone(timezone.utc))}")
        lines.append(f"DTEND:{_fmt_utc(end_local.astimezone(timezone.utc))}")

    lines.append("END:VEVENT")
    return lines


def _fmt_utc(dt: datetime) -> str:
    return dt.strftime("%Y%m%dT%H%M%SZ")


def _fmt_date(d: date) -> str:
    return d.strftime("%Y%m%d")


def _escape(text: str) -> str:
    """RFC 5545 TEXT escaping: \\, ; , and newlines are special."""
    return (
        text.replace("\\", "\\\\")
        .replace(";", "\\;")
        .replace(",", "\\,")
        .replace("\n", "\\n")
    )
