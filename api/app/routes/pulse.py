"""Pulse survey routes (migration 0090).

Six endpoints, split across member-facing and admin-facing:

  Member:
    GET    /api/pulse/current-week        the open week's questions + my answers so far
    POST   /api/pulse/responses           upsert {question_key, score} batch
    GET    /api/pulse/my-history          self-history time-series (12 weeks default)

  Admin:
    GET    /api/admin/pulse/settings      tenant on/off + last notified week
    PATCH  /api/admin/pulse/settings      toggle enabled
    GET    /api/admin/pulse/stats         aggregated time-series + correlation hooks

All routes are tenant-scoped through ctx.db's RLS session. No
cross-tenant reads — pulse data is private to the team that
generated it. Aggregation queries group server-side so individual
responses never leave the API; the admin sees mean, distribution,
response rate, never "who said what".
"""

from __future__ import annotations

import logging
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Response, status
from pydantic import BaseModel, Field
from sqlalchemy import text

from app.routes.deps import RequestContext, get_current_context
from app.services.pulse import (
    CORE_QUESTIONS,
    ROTATING_QUESTIONS,
    current_week_iso,
    question_by_key,
    questions_for_week,
)


logger = logging.getLogger("app.pulse.routes")
router = APIRouter()


# ---------------------------------------------------------------------------
# Schemas
# ---------------------------------------------------------------------------


class PulseQuestionOut(BaseModel):
    key: str
    prompt: str
    scale_type: str
    scale_max: int
    labels: list[str] = []


class PulseCurrentWeekOut(BaseModel):
    week_iso: str
    enabled: bool
    questions: list[PulseQuestionOut]
    # Map of question_key → score for the answers I've already given
    # this week. Empty when I haven't started. Lets the frontend
    # render the form pre-filled if the user came back mid-flow.
    my_answers: dict[str, int]


class PulseAnswerIn(BaseModel):
    question_key: str = Field(min_length=1, max_length=32)
    score: int = Field(ge=1, le=10)  # generous bound; per-q validated below


class PulseResponseBatchIn(BaseModel):
    answers: list[PulseAnswerIn] = Field(min_length=1, max_length=20)


class PulseHistoryItem(BaseModel):
    week_iso: str
    question_key: str
    score: int


class PulseSettingsOut(BaseModel):
    enabled: bool
    last_notified_week_iso: str | None


class PulseSettingsPatch(BaseModel):
    enabled: bool


class PulseQuestionStat(BaseModel):
    """One row per (question_key, week_iso) for the admin time-series.
    Distribution is a list of (score, count) pairs so the frontend
    can render histograms without recomputing."""

    week_iso: str
    question_key: str
    mean: float
    response_count: int
    distribution: list[tuple[int, int]]


class PulseStatsOut(BaseModel):
    # Total clinicians eligible to answer this week. The response
    # rate is derived as `response_count / eligible_count` per
    # week — surfaced as a separate line on the admin chart.
    eligible_count: int
    weekly: list[PulseQuestionStat]


class PulseCatalogueQuestion(BaseModel):
    """Admin-facing view of one question. Same shape as
    PulseQuestionOut on the member side, plus a flag indicating
    whether this question is in the current week's rotation
    (always true for core questions)."""

    key: str
    prompt: str
    scale_type: str
    scale_max: int
    labels: list[str] = []
    is_core: bool
    is_this_week: bool


class PulseCatalogueOut(BaseModel):
    """All questions the admin's team could see. Split into core
    (always asked) and rotating (one of N picked per week)."""

    current_week_iso: str
    core: list[PulseCatalogueQuestion]
    rotating: list[PulseCatalogueQuestion]


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )


def _is_enabled(ctx: RequestContext) -> bool:
    row = ctx.db.execute(
        text(
            """
            SELECT enabled FROM pulse_settings
            WHERE tenant_id = :tid
            """
        ),
        {"tid": ctx.tenant.id},
    ).first()
    return bool(row and row[0])


def _ensure_settings_row(ctx: RequestContext) -> None:
    """Idempotent: create a default-OFF row the first time we touch
    settings for a tenant. Avoids "row didn't exist" branches all
    over the place."""
    ctx.db.execute(
        text(
            """
            INSERT INTO pulse_settings (tenant_id, enabled)
            VALUES (:tid, FALSE)
            ON CONFLICT (tenant_id) DO NOTHING
            """
        ),
        {"tid": ctx.tenant.id},
    )
    ctx.db.flush()


# ---------------------------------------------------------------------------
# Member-facing routes
# ---------------------------------------------------------------------------


@router.get(
    "/pulse/current-week", response_model=PulseCurrentWeekOut
)
def get_current_week(
    ctx: RequestContext = Depends(get_current_context),
) -> PulseCurrentWeekOut:
    """Return this week's questions + any answers I've already
    saved. Always returns the question set even when pulse is
    disabled for the tenant — the frontend uses the `enabled`
    flag to render the disabled banner instead of the form.
    Cheaper than gating with 404."""
    week_iso = current_week_iso()
    questions = questions_for_week(week_iso)
    rows = ctx.db.execute(
        text(
            """
            SELECT question_key, score
            FROM pulse_responses
            WHERE person_id = :pid AND week_iso = :w
            """
        ),
        {"pid": ctx.person.id, "w": week_iso},
    ).all()
    my_answers = {r[0]: r[1] for r in rows}
    return PulseCurrentWeekOut(
        week_iso=week_iso,
        enabled=_is_enabled(ctx),
        questions=[
            PulseQuestionOut(
                key=q.key,
                prompt=q.prompt_es,
                scale_type=q.scale_type,
                scale_max=q.scale_max,
                labels=list(q.labels_es),
            )
            for q in questions
        ],
        my_answers=my_answers,
    )


@router.post("/pulse/responses", status_code=status.HTTP_204_NO_CONTENT)
def post_responses(
    payload: PulseResponseBatchIn,
    ctx: RequestContext = Depends(get_current_context),
) -> Response:
    """Upsert a batch of answers for the current ISO week. Any
    answers for question keys not in this week's catalogue are
    rejected (defensive — the frontend shouldn't send those).
    Returns 410 if pulse is disabled for the tenant (the frontend
    should show a stale-state banner).

    Returns a bare `Response` rather than `None` because FastAPI's
    body-validation assertion on 204 routes fires on the implicit
    `-> None` return type. Same workaround used by the push
    routes."""
    if not _is_enabled(ctx):
        raise HTTPException(
            status_code=status.HTTP_410_GONE,
            detail="Pulso desactivado en este equipo.",
        )
    week_iso = current_week_iso()
    week_questions = {q.key for q in questions_for_week(week_iso)}
    for answer in payload.answers:
        q = question_by_key(answer.question_key)
        if q is None or answer.question_key not in week_questions:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Pregunta {answer.question_key} no es válida "
                    f"para esta semana."
                ),
            )
        if answer.score < 1 or answer.score > q.scale_max:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=(
                    f"Respuesta fuera de rango para "
                    f"{answer.question_key}."
                ),
            )
    # Upsert one row per answer. Single round-trip via executemany
    # would be marginally faster but the batch is bounded (5-ish
    # questions) so per-row inserts read cleaner.
    for answer in payload.answers:
        ctx.db.execute(
            text(
                """
                INSERT INTO pulse_responses (
                    tenant_id, person_id, week_iso, question_key, score
                ) VALUES (:tid, :pid, :w, :k, :s)
                ON CONFLICT (person_id, week_iso, question_key)
                DO UPDATE SET score = EXCLUDED.score
                """
            ),
            {
                "tid": ctx.tenant.id,
                "pid": ctx.person.id,
                "w": week_iso,
                "k": answer.question_key,
                "s": answer.score,
            },
        )
    ctx.db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get(
    "/pulse/my-history", response_model=list[PulseHistoryItem]
)
def get_my_history(
    weeks: int = 12,
    ctx: RequestContext = Depends(get_current_context),
) -> list[PulseHistoryItem]:
    """Self-history time-series — drives the line chart at the
    bottom of /me/pulso. Bounded to 52 weeks (one year) since
    longer windows are rarely useful and the data column is
    cheap to query but cheap to abuse."""
    weeks = max(1, min(52, weeks))
    rows = ctx.db.execute(
        text(
            """
            SELECT week_iso, question_key, score
            FROM pulse_responses
            WHERE person_id = :pid
            ORDER BY week_iso DESC
            LIMIT :lim
            """
        ),
        # 5 questions/week × N weeks.
        {"pid": ctx.person.id, "lim": weeks * 5},
    ).all()
    return [
        PulseHistoryItem(week_iso=r[0], question_key=r[1], score=r[2])
        for r in rows
    ]


# ---------------------------------------------------------------------------
# Admin-facing routes
# ---------------------------------------------------------------------------


@router.get(
    "/admin/pulse/catalogue", response_model=PulseCatalogueOut
)
def get_admin_catalogue(
    ctx: RequestContext = Depends(get_current_context),
) -> PulseCatalogueOut:
    """Return every question in the catalogue so the admin can see
    what their team is being asked. Core questions are always
    asked; rotating questions cycle one-per-week. The
    `is_this_week` flag marks which questions WILL appear in the
    current ISO week's survey.

    No tenant-customisation yet — the catalogue lives in code
    (services/pulse.py). When we ship per-tenant overrides, this
    endpoint becomes the read-side of that editor."""
    _require_admin(ctx)
    week_iso = current_week_iso()
    week_keys = {q.key for q in questions_for_week(week_iso)}
    core = [
        PulseCatalogueQuestion(
            key=q.key,
            prompt=q.prompt_es,
            scale_type=q.scale_type,
            scale_max=q.scale_max,
            labels=list(q.labels_es),
            is_core=True,
            is_this_week=True,
        )
        for q in CORE_QUESTIONS
    ]
    rotating = [
        PulseCatalogueQuestion(
            key=q.key,
            prompt=q.prompt_es,
            scale_type=q.scale_type,
            scale_max=q.scale_max,
            labels=list(q.labels_es),
            is_core=False,
            is_this_week=q.key in week_keys,
        )
        for q in ROTATING_QUESTIONS
    ]
    return PulseCatalogueOut(
        current_week_iso=week_iso,
        core=core,
        rotating=rotating,
    )


@router.get("/admin/pulse/settings", response_model=PulseSettingsOut)
def get_admin_settings(
    ctx: RequestContext = Depends(get_current_context),
) -> PulseSettingsOut:
    _require_admin(ctx)
    _ensure_settings_row(ctx)
    row = ctx.db.execute(
        text(
            """
            SELECT enabled, last_notified_week_iso
            FROM pulse_settings WHERE tenant_id = :tid
            """
        ),
        {"tid": ctx.tenant.id},
    ).first()
    return PulseSettingsOut(
        enabled=bool(row[0]),
        last_notified_week_iso=row[1],
    )


@router.patch(
    "/admin/pulse/settings", response_model=PulseSettingsOut
)
def patch_admin_settings(
    payload: PulseSettingsPatch,
    ctx: RequestContext = Depends(get_current_context),
) -> PulseSettingsOut:
    """Flip the on/off toggle for the caller's tenant.

    Reads the post-update row BEFORE commit so we can return it
    in the same transaction. Calling get_admin_settings() (or any
    RLS-scoped query) after commit() blows up with
    ObjectDeletedError: the SET LOCAL app.tenant_id GUC is
    transaction-scoped, so a fresh query in a new transaction
    sees RLS reject every row, including the caller's own
    membership. The right fix is to never run a second RLS query
    on the same session after committing — do all reads up front.
    """
    _require_admin(ctx)
    _ensure_settings_row(ctx)
    ctx.db.execute(
        text(
            """
            UPDATE pulse_settings
            SET enabled = :en, updated_at = NOW()
            WHERE tenant_id = :tid
            """
        ),
        {"en": payload.enabled, "tid": ctx.tenant.id},
    )
    # Read back inside the same transaction so RLS is still
    # primed by `SET LOCAL app.tenant_id`.
    row = ctx.db.execute(
        text(
            """
            SELECT enabled, last_notified_week_iso
            FROM pulse_settings WHERE tenant_id = :tid
            """
        ),
        {"tid": ctx.tenant.id},
    ).first()
    ctx.db.commit()
    logger.info(
        "pulse settings: tenant=%s enabled=%s",
        ctx.tenant.id,
        payload.enabled,
    )
    return PulseSettingsOut(
        enabled=bool(row[0]) if row else payload.enabled,
        last_notified_week_iso=row[1] if row else None,
    )


@router.get("/admin/pulse/stats", response_model=PulseStatsOut)
def get_admin_stats(
    from_week: str | None = None,
    to_week: str | None = None,
    ctx: RequestContext = Depends(get_current_context),
) -> PulseStatsOut:
    """Server-side aggregated time-series. Never returns a single
    person's response — distribution + counts only. Default
    window: trailing 26 weeks (6 months). `from_week` / `to_week`
    are ISO week strings inclusive."""
    _require_admin(ctx)
    # Default window — backend computes it so the frontend doesn't
    # need to know what "trailing 6 months" means.
    if to_week is None:
        to_week = current_week_iso()
    if from_week is None:
        # 26 weeks back, naive subtraction works because ISO weeks
        # sort lexically.
        try:
            year, wk = to_week.split("-W")
            ywk = int(year) * 53 + int(wk)
            ywk -= 26
            from_year, from_wk = divmod(ywk, 53)
            from_week = f"{from_year}-W{max(1, from_wk):02d}"
        except (ValueError, IndexError):
            from_week = to_week  # degenerate; just return one week
    rows = ctx.db.execute(
        text(
            """
            SELECT week_iso,
                   question_key,
                   AVG(score)::float AS mean,
                   COUNT(*) AS response_count,
                   ARRAY_AGG(score) AS scores
            FROM pulse_responses
            WHERE tenant_id = :tid
              AND week_iso >= :from_w
              AND week_iso <= :to_w
            GROUP BY week_iso, question_key
            ORDER BY week_iso ASC, question_key ASC
            """
        ),
        {
            "tid": ctx.tenant.id,
            "from_w": from_week,
            "to_w": to_week,
        },
    ).all()
    # Eligible-count baseline for response rate. Counted as active
    # memberships at this tenant right now — slight drift if
    # members joined/left mid-window, but acceptable for a metric
    # users glance at not audit.
    eligible_row = ctx.db.execute(
        text(
            """
            SELECT COUNT(DISTINCT person_id) FROM memberships
            WHERE tenant_id = :tid AND disabled_at IS NULL
            """
        ),
        {"tid": ctx.tenant.id},
    ).first()
    eligible_count = int(eligible_row[0]) if eligible_row else 0

    weekly: list[PulseQuestionStat] = []
    for r in rows:
        scores: list[int] = list(r[4] or [])
        # Build distribution as (score, count) tuples sorted by
        # score. Caps at the question's scale_max; unrecognised
        # questions just bucket whatever scores arrived.
        dist: dict[int, int] = {}
        for s in scores:
            dist[s] = dist.get(s, 0) + 1
        distribution = sorted(dist.items())
        weekly.append(
            PulseQuestionStat(
                week_iso=r[0],
                question_key=r[1],
                mean=round(float(r[2]), 2),
                response_count=int(r[3]),
                distribution=distribution,
            )
        )
    return PulseStatsOut(
        eligible_count=eligible_count, weekly=weekly
    )


__all__ = ["router", "CORE_QUESTIONS"]
