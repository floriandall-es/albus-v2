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

ISO week semantics: ISO 8601 weeks start Monday. The "open"
survey window is bounded by worker firings rather than calendar
boundaries — a week stays open from its Friday 14:00 worker tick
until the NEXT Friday's tick rotates it. Means surgeons on
weekend guardia can still answer Tuesday and it counts toward
the right week. See open_week_iso().
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
    just render N buttons.

    `default_enabled` decides whether a tenant that hasn't set an
    explicit override gets this question asked. The first four
    "recommended" questions ship with default_enabled=True; the
    rest are off by default and the admin opts them in. Tenant
    overrides always win — see apply_overrides()."""

    key: str
    prompt_es: str
    # "scale" → 1..scale_max numeric buttons.
    # "choice" → scale_max labelled buttons (labels in labels_es).
    scale_type: Literal["scale", "choice"]
    scale_max: int
    labels_es: tuple[str, ...] = ()
    default_enabled: bool = True


# Recommended-on questions — the proven core for week-over-week
# wellbeing tracking. New tenants get these four on by default;
# admins can still toggle them off from /admin/pulso.
CORE_QUESTIONS: tuple[PulseQuestion, ...] = (
    PulseQuestion(
        key="fairness",
        prompt_es="¿Sientes que el reparto de turnos esta semana ha sido justo contigo?",
        scale_type="scale",
        scale_max=4,
        # Every scale question now ships with per-point labels so
        # the survey button can render "3 · Justo" instead of a
        # bare "3". The numbers are the data we chart; the labels
        # are the UX. Labels are part of the time-series contract
        # (along with scale_max) and are NOT tenant-customisable —
        # only prompts are. Order is monotonic 1→N from "worst"
        # to "best" so chart direction is consistent across
        # questions. Every scale is 4-point (even, no neutral
        # middle to hide in) — we deliberately do not offer a
        # "regular / normal" option that would let respondents
        # coast.
        labels_es=("Injusto", "Poco justo", "Justo", "Muy justo"),
        default_enabled=True,
    ),
    PulseQuestion(
        key="workload",
        prompt_es="¿Cómo describirías tu carga esta semana?",
        scale_type="choice",
        scale_max=4,
        labels_es=("Ligera", "Adecuada", "Pesada", "Insostenible"),
        default_enabled=True,
    ),
    PulseQuestion(
        key="recovery",
        prompt_es="¿Cómo de descansado/a te sientes ahora mismo?",
        scale_type="scale",
        scale_max=4,
        labels_es=("Agotado", "Cansado", "Bien", "Pleno"),
        default_enabled=True,
    ),
    PulseQuestion(
        key="predictability",
        prompt_es="¿Cuántos cambios de última hora te han afectado esta semana?",
        scale_type="choice",
        scale_max=4,
        labels_es=("Ninguno", "Pocos", "Bastantes", "Demasiados"),
        default_enabled=True,
    ),
)

# Opt-in extras — admin enables the ones they care about. Each
# week's survey includes every enabled question (no rotation
# anymore — the rotation made surveys feel arbitrary, and admins
# preferred curating the question set themselves). New tenants
# start with all of these OFF.
#
# Name "ROTATING_QUESTIONS" kept in the codebase so existing
# imports don't churn — but conceptually these are now just
# "additional questions, default off". Renaming in a later pass
# if it bothers anyone.
ROTATING_QUESTIONS: tuple[PulseQuestion, ...] = (
    PulseQuestion(
        key="team_support",
        prompt_es="¿Has sentido apoyo del equipo cuando lo necesitabas?",
        scale_type="scale",
        scale_max=4,
        labels_es=("Ninguno", "Poco", "Bastante", "Total"),
        default_enabled=False,
    ),
    PulseQuestion(
        key="tool_friction",
        prompt_es="¿Trivu te ha facilitado o complicado la semana?",
        scale_type="choice",
        scale_max=4,
        # Order stays "facilitated → complicated" (higher = more
        # friction) to match the directional convention workload
        # and predictability already use for choice questions —
        # the chart-direction hint reads consistently across all
        # "higher = worse" metrics.
        labels_es=(
            "Facilitado mucho",
            "Algo facilitado",
            "Algo complicado",
            "Complicado mucho",
        ),
        default_enabled=False,
    ),
    PulseQuestion(
        key="wellbeing",
        prompt_es="En general, ¿cómo estás esta semana?",
        scale_type="scale",
        scale_max=4,
        labels_es=("Muy mal", "Mal", "Bien", "Genial"),
        default_enabled=False,
    ),
    PulseQuestion(
        key="recommend",
        prompt_es="¿Recomendarías a un colega unirse a este equipo?",
        scale_type="scale",
        scale_max=4,
        labels_es=("No", "Quizá no", "Sí", "Seguro"),
        default_enabled=False,
    ),
)


def current_week_iso(now: datetime | None = None) -> str:
    """Return today's ISO week as "YYYY-Www". `now` defaults to
    Europe/Madrid clock — all pulse state is computed in hospital
    time, never UTC.

    Used by the worker to decide which week to stamp on its
    Friday fan-out. Member-facing endpoints should use
    `open_week_iso()` instead — the "answerable" window is
    bounded by worker firings, not by ISO week boundaries."""
    if now is None:
        now = datetime.now(tz=_TZ)
    iso_year, iso_week, _ = now.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def open_week_iso(last_notified_week_iso: str | None) -> str:
    """Return the ISO week the team can currently answer for.

    The survey opens Friday 14:00 Europe/Madrid (worker tick
    stamps `pulse_settings.last_notified_week_iso`) and stays
    open until the NEXT worker firing rotates it — at which
    point the previous week's responses become immutable. This
    is softer than an ISO-week boundary: someone on weekend
    guardia who answers Tuesday is still answering "last
    Friday's" survey, which matches what the team understands
    by "the open pulse".

    Fallback to today's ISO week when no notification has ever
    fired (fresh enable). The first worker tick after that will
    stamp the same value, so there's no jump.
    """
    if last_notified_week_iso:
        return last_notified_week_iso
    return current_week_iso()


def week_iso_for(d: date) -> str:
    iso_year, iso_week, _ = d.isocalendar()
    return f"{iso_year}-W{iso_week:02d}"


def questions_for_week(week_iso: str) -> list[PulseQuestion]:
    """Return every question in the catalogue, in display order.
    No week-based filtering — that's apply_overrides()'s job.

    `week_iso` is accepted for API symmetry with the older
    rotation-based signature; it's unused today and may be
    re-introduced if we ship a "rotate disabled questions back
    in on slow weeks" feature later."""
    del week_iso  # silence linters; kept in signature for symmetry
    return [*CORE_QUESTIONS, *ROTATING_QUESTIONS]


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
    None if either the override disables it or there's no override
    and the question's default_enabled is False.

    Scale / scale_max / labels are never overridden — those are
    the time-series contract and must stay stable across all
    tenants. Only prompt + enabled are tenant-configurable.

    Effective `enabled`:
      - present override → use whatever the tenant set
      - absent override → fall back to question.default_enabled
        (True for the core 4, False for the additional 4)
    """
    o = (overrides or {}).get(question.key, {})
    enabled = o.get("enabled", question.default_enabled)
    if not enabled:
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
        default_enabled=question.default_enabled,
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


