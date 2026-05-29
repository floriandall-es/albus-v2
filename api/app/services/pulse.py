"""Pulse surveys — question catalogue + Friday fan-out worker.

Two halves:

  * `CORE_QUESTIONS` + `ROTATING_QUESTIONS` — the in-code catalogue.
    Keeping these in code (rather than a DB-backed editor) for v1
    means tweaking copy doesn't need a migration, and the question
    keys are the contract that pulse_responses rows reference. When
    we ship a custom-question editor (v2+), it'll add a JSONB
    override on `pulse_settings`; the catalogue here remains the
    fallback / default.

  * `tick()` — runs from APScheduler. Each tick we check whether
    Friday 14:00 Europe/Madrid has passed in the current ISO week
    and, for every tenant with `enabled=true` and
    `last_notified_week_iso != current_week`, fan out push + email
    asking everyone to answer. Idempotency is the
    `last_notified_week_iso` column: atomic per tenant.

ISO week semantics: ISO 8601 weeks start Monday. The "hard close
Sunday night" UX is implicit — the moment Monday 00:00 hits in
Europe/Madrid, the week_iso changes, and POSTs for the previous
week start returning 410. No explicit `closes_at` timestamp needed.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from datetime import date, datetime
from typing import Literal
from zoneinfo import ZoneInfo

from sqlalchemy import text

from app.core.config import settings
from app.db.session import AdminSessionLocal


logger = logging.getLogger("app.pulse")

# Pulse fires on Friday 14:00 hospital local. Match the existing
# tz hardcode in meeting_reminders.py — Spanish public hospitals
# only for now.
_TZ = ZoneInfo("Europe/Madrid")
_NOTIFICATION_WEEKDAY = 4  # ISO weekday 4 = Friday
_NOTIFICATION_HOUR = 14


@dataclass(frozen=True)
class PulseQuestion:
    """Catalogue entry. `key` is the stable contract referenced by
    pulse_responses; `prompt_es` can evolve freely.

    `scale_type` distinguishes pure 1-N numeric scales ("scale")
    from labelled multi-choice ("choice"). The labels are sent to
    the frontend in `labels_es` for "choice" types; numeric scales
    just render N buttons."""

    key: str
    prompt_es: str
    # "scale" → 1..scale_max numeric buttons.
    # "choice" → scale_max labelled buttons (labels in labels_es).
    scale_type: Literal["scale", "choice"]
    scale_max: int
    labels_es: tuple[str, ...] = ()


# The four questions every Friday. These are the time-series the
# admin's correlation insights are built on — adding/removing one
# breaks historical comparability, so treat the set as stable.
CORE_QUESTIONS: tuple[PulseQuestion, ...] = (
    PulseQuestion(
        key="fairness",
        prompt_es="¿Sientes que el reparto de turnos esta semana ha sido justo contigo?",
        scale_type="scale",
        scale_max=5,
    ),
    PulseQuestion(
        key="workload",
        prompt_es="¿Cómo describirías tu carga esta semana?",
        scale_type="choice",
        scale_max=4,
        labels_es=("Ligera", "Adecuada", "Pesada", "Insostenible"),
    ),
    PulseQuestion(
        key="recovery",
        prompt_es="¿Cómo de descansado/a te sientes ahora mismo?",
        scale_type="scale",
        scale_max=5,
    ),
    PulseQuestion(
        key="predictability",
        prompt_es="¿Cuántos cambios de última hora te han afectado esta semana?",
        scale_type="choice",
        scale_max=4,
        labels_es=("Ninguno", "Pocos", "Bastantes", "Demasiados"),
    ),
)

# Rotating slot — one of these lands as the 5th question, picked by
# ISO week mod len. Keeps surveys feeling less repetitive without
# losing the core 4-question time-series.
ROTATING_QUESTIONS: tuple[PulseQuestion, ...] = (
    PulseQuestion(
        key="team_support",
        prompt_es="¿Has sentido apoyo del equipo cuando lo necesitabas?",
        scale_type="scale",
        scale_max=5,
    ),
    PulseQuestion(
        key="tool_friction",
        prompt_es="¿Trivu te ha facilitado o complicado la semana?",
        scale_type="choice",
        scale_max=4,
        labels_es=(
            "Facilitado mucho",
            "Algo facilitado",
            "Algo complicado",
            "Complicado mucho",
        ),
    ),
    PulseQuestion(
        key="wellbeing",
        prompt_es="En general, ¿cómo estás esta semana?",
        scale_type="scale",
        scale_max=5,
    ),
    PulseQuestion(
        key="recommend",
        prompt_es="¿Recomendarías a un colega unirse a este equipo?",
        scale_type="scale",
        scale_max=5,
    ),
)


def current_week_iso(now: datetime | None = None) -> str:
    """Return today's ISO week as "YYYY-Www". `now` defaults to
    Europe/Madrid clock — all pulse state is computed in hospital
    time, never UTC."""
    if now is None:
        now = datetime.now(tz=_TZ)
    iso_year, iso_week, _ = now.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def week_iso_for(d: date) -> str:
    iso_year, iso_week, _ = d.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def questions_for_week(week_iso: str) -> list[PulseQuestion]:
    """Compose the week's question set: 4 core + 1 rotating picked
    deterministically from the week's ISO number. Deterministic
    means a given week always yields the same rotating question —
    so a member who answers Monday and one who answers Friday see
    the same five things."""
    try:
        week_num = int(week_iso.split("W")[-1])
    except (ValueError, IndexError):
        # Defensive — caller already validated week_iso is current.
        week_num = 0
    rotating = ROTATING_QUESTIONS[week_num % len(ROTATING_QUESTIONS)]
    return [*CORE_QUESTIONS, rotating]


def question_by_key(key: str) -> PulseQuestion | None:
    for q in CORE_QUESTIONS:
        if q.key == key:
            return q
    for q in ROTATING_QUESTIONS:
        if q.key == key:
            return q
    return None


# ---------------------------------------------------------------------------
# Per-tenant overrides (migration 0091)
# ---------------------------------------------------------------------------


def apply_overrides(
    question: PulseQuestion,
    overrides: dict[str, dict] | None,
) -> PulseQuestion | None:
    """Return the question with the tenant's override applied, or
    None if the override disables it. Scale / scale_max / labels
    are never overridden — those are the time-series contract and
    must stay stable across all tenants.

    The `enabled` flag defaults to True when absent. `prompt`
    falls through to the default when absent or empty after trim.
    """
    if not overrides:
        return question
    o = overrides.get(question.key)
    if not o:
        return question
    if o.get("enabled", True) is False:
        return None
    custom_prompt = (o.get("prompt") or "").strip()
    if not custom_prompt:
        return question
    return PulseQuestion(
        key=question.key,
        prompt_es=custom_prompt,
        scale_type=question.scale_type,
        scale_max=question.scale_max,
        labels_es=question.labels_es,
    )


def effective_questions_for_week(
    week_iso: str,
    overrides: dict[str, dict] | None,
) -> list[PulseQuestion]:
    """Return the week's question set after applying tenant
    overrides — the version the member sees in /me/pulso.

    Order matches questions_for_week (core first, then the week's
    rotating slot). Disabled questions are dropped; remaining
    questions keep their (possibly reworded) prompts."""
    base = questions_for_week(week_iso)
    return [
        eq for q in base if (eq := apply_overrides(q, overrides)) is not None
    ]


# ---------------------------------------------------------------------------
# Worker tick — Friday 14:00 fan-out
# ---------------------------------------------------------------------------


def tick(now: datetime | None = None) -> None:
    """Called every 5 minutes by APScheduler. Each call:

      1. Compute the current ISO week + check whether Friday 14:00
         Europe/Madrid has already passed THIS week (it has on
         Fri 14:00+, Sat, Sun; it hasn't Mon-Thu or Fri 00:00-13:59).
      2. For each tenant with `enabled=true` AND
         `last_notified_week_iso != current_week`: fan out push +
         email + atomically stamp `last_notified_week_iso`.

    Notify-once semantics rely on the column update being part of
    the same row's UPDATE statement that switches the value; even
    if two ticks race (multi-replica deploy, manual trigger), only
    one will move the value and only one cohort gets notified.

    The same idempotency means re-enabling a tenant mid-week WON'T
    re-fire for the current week — they'll get the next Friday
    naturally. Acceptable: enabling pulse on Wednesday and
    expecting Friday is the obvious UX.
    """
    if now is None:
        now = datetime.now(tz=_TZ)
    else:
        now = now.astimezone(_TZ)

    # Has Friday 14:00 passed in this ISO week?
    if not _notification_window_open(now):
        return
    week_iso = current_week_iso(now)

    # Find tenants needing a fan-out. Done in one SQL trip via
    # AdminSessionLocal (RLS would force per-tenant loops otherwise).
    with AdminSessionLocal() as adb:
        rows = adb.execute(
            text(
                """
                SELECT id, tenant_id
                FROM pulse_settings
                WHERE enabled = TRUE
                  AND (last_notified_week_iso IS NULL
                       OR last_notified_week_iso <> :week)
                """
            ),
            {"week": week_iso},
        ).mappings().all()
        for row in rows:
            _notify_tenant(adb, row["tenant_id"], week_iso)
            # Stamp idempotency immediately so a crash mid-fan-out
            # doesn't re-notify recipients on the next tick — at
            # most one cohort per week, even at the cost of
            # missing late members on a crash (rare; they can
            # still go to /me/pulso via the home-screen card).
            adb.execute(
                text(
                    """
                    UPDATE pulse_settings
                    SET last_notified_week_iso = :week,
                        updated_at = NOW()
                    WHERE id = :id
                    """
                ),
                {"week": week_iso, "id": row["id"]},
            )
            adb.commit()


def _notification_window_open(now: datetime) -> bool:
    """True when `now` (already in Europe/Madrid) is on or after
    Friday 14:00 of the current ISO week. The ISO week boundary
    means "current week" is Mon-Sun starting this past Monday."""
    iso_weekday = now.isoweekday()  # 1=Mon ... 7=Sun
    if iso_weekday < _NOTIFICATION_WEEKDAY:
        return False
    if iso_weekday == _NOTIFICATION_WEEKDAY and now.hour < _NOTIFICATION_HOUR:
        return False
    return True


def _notify_tenant(adb, tenant_id: int, week_iso: str) -> None:
    """Fan push + email to every active person at this tenant.
    Mirrors the dms.py per-recipient channel selection: push if
    subscribed, email otherwise. No per-recipient cooldown — pulse
    fires at most once per tenant per week regardless of channel."""
    # Recipients: every person with at least one active, non-disabled
    # membership at this tenant. Cross-tenant persons (one human in
    # two hospitals) get one prompt per tenant — reasonable, since
    # the pulse measures perception of THAT team. We pull
    # hashed_password too so the email path can call
    # should_email_person() to filter pendientes.
    persons = adb.execute(
        text(
            """
            SELECT DISTINCT p.id, p.email, p.first_name, p.name,
                   p.hashed_password
            FROM persons p
            JOIN memberships m ON m.person_id = p.id
            WHERE m.tenant_id = :tid
              AND m.disabled_at IS NULL
            """
        ),
        {"tid": tenant_id},
    ).mappings().all()
    if not persons:
        return
    deep_link = (
        f"{settings.public_base_url.rstrip('/')}/me/pulso"
    )

    # Lazy imports keep boot fast on tenants that never enable pulse.
    from app.services.email import send_email, should_email_person
    from app.services.email_templates import pulse_invite_email
    from app.services.push import (
        has_active_subscriptions,
        send_push_to_person,
    )

    for row in persons:
        pid = row["id"]
        # Push path first.
        if has_active_subscriptions(pid):
            sent = send_push_to_person(
                pid,
                title="Pulso semanal de Trivu",
                body=(
                    "¿Cómo ha ido la semana? 30 segundos para "
                    "ayudarnos a entenderlo."
                ),
                url=deep_link,
                # Tag groups all weekly pulses under one OS-side
                # collapsible — if for some reason we ever send
                # multiple pushes in a week, the device shows the
                # latest one only.
                tag=f"pulse:{week_iso}",
            )
            if sent > 0:
                continue
        # Email fallback. Pendientes (hashed_password IS NULL)
        # don't receive operational mail — same gate as
        # billing_emails / meeting_reminders use.
        if not should_email_person(row["hashed_password"]):
            continue
        subject, body_html = pulse_invite_email(
            recipient_first_name=row["first_name"] or row["name"],
            deep_link=deep_link,
        )
        send_email(row["email"], subject, body_html)


