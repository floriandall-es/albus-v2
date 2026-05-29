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
    apply_overrides,
    current_week_iso,
    effective_questions_for_week,
    open_week_iso,
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
    """Admin-facing view of one question with override state.

    `prompt` is the effective text the team sees (custom override
    if set, in-code default otherwise). `default_prompt` is what
    the prompt would be without overrides — surfaced so the admin
    UI can show "reset to default" affordance.

    `enabled` defaults to True; only False when the admin
    explicitly disabled the question. `is_this_week` factors in
    both the rotation slot AND the enabled flag — false when a
    rotating question is in this week's slot but the admin
    disabled it (the survey will fall through to 4 core
    questions only).

    `is_customized` is true iff `prompt != default_prompt` or
    `enabled == False`. Drives the "personalizada" pill in the
    admin UI."""

    key: str
    prompt: str
    default_prompt: str
    scale_type: str
    scale_max: int
    labels: list[str] = []
    is_core: bool
    is_this_week: bool
    enabled: bool = True
    is_customized: bool = False


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


def _load_overrides(ctx: RequestContext) -> dict[str, dict]:
    """Read the JSONB overrides column. Empty dict when the row
    doesn't exist yet (member hitting current-week before admin
    ever touched settings)."""
    row = ctx.db.execute(
        text(
            """
            SELECT question_overrides FROM pulse_settings
            WHERE tenant_id = :tid
            """
        ),
        {"tid": ctx.tenant.id},
    ).first()
    if not row or not row[0]:
        return {}
    return dict(row[0])


def _open_week_iso_for_tenant(ctx: RequestContext) -> str:
    """Resolve the answerable week for the caller's tenant. Falls
    back to today's ISO week when no notification has fired
    yet."""
    row = ctx.db.execute(
        text(
            """
            SELECT last_notified_week_iso FROM pulse_settings
            WHERE tenant_id = :tid
            """
        ),
        {"tid": ctx.tenant.id},
    ).first()
    return open_week_iso(row[0] if row else None)


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
    # The open week is bounded by worker firings, not by ISO
    # boundaries — a survey published last Friday stays open until
    # the next Friday's worker tick rotates it.
    week_iso = _open_week_iso_for_tenant(ctx)
    # Migration 0091: apply per-tenant overrides (rewording +
    # disable) so the member sees what the admin configured, not
    # the in-code defaults.
    overrides = _load_overrides(ctx)
    questions = effective_questions_for_week(week_iso, overrides)
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
    # Submissions always target the open week, not "today's" ISO
    # week — the open window is bounded by worker firings.
    week_iso = _open_week_iso_for_tenant(ctx)
    # Migration 0091: reject submissions for questions the admin
    # disabled. effective_questions_for_week strips disabled keys,
    # so anything not in that set 422s.
    overrides = _load_overrides(ctx)
    week_questions = {
        q.key for q in effective_questions_for_week(week_iso, overrides)
    }
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
    _ensure_settings_row(ctx)
    overrides = _load_overrides(ctx)
    week_iso = _open_week_iso_for_tenant(ctx)
    return PulseCatalogueOut(
        current_week_iso=week_iso,
        core=[
            _to_catalogue_out(q, overrides) for q in CORE_QUESTIONS
        ],
        rotating=[
            _to_catalogue_out(q, overrides) for q in ROTATING_QUESTIONS
        ],
    )


def _to_catalogue_out(
    q,
    overrides: dict[str, dict],
) -> PulseCatalogueQuestion:
    """Render one question for the admin catalogue. Computes the
    effective enabled state (override wins over default_enabled)
    and the customised flag (custom prompt OR explicit override
    that disagrees with the default)."""
    o = overrides.get(q.key, {})
    has_enabled_override = "enabled" in o
    effective_enabled = (
        o["enabled"] if has_enabled_override else q.default_enabled
    )
    custom_prompt = (o.get("prompt") or "").strip()
    effective_prompt = custom_prompt or q.prompt_es
    # "Customised" = anything different from the in-code default.
    # Custom prompt always counts. An explicit enabled-override
    # only counts if it disagrees with default_enabled.
    customised = bool(custom_prompt) or (
        has_enabled_override and o["enabled"] != q.default_enabled
    )
    return PulseCatalogueQuestion(
        key=q.key,
        prompt=effective_prompt,
        default_prompt=q.prompt_es,
        scale_type=q.scale_type,
        scale_max=q.scale_max,
        labels=list(q.labels_es),
        # is_core kept on the wire so existing frontends that
        # split into two sections still work; it now means
        # "recommended-on by default" rather than "asked every
        # week" (which is true of every enabled question now).
        is_core=q.default_enabled,
        is_this_week=effective_enabled,
        enabled=effective_enabled,
        is_customized=customised,
    )


class PulseQuestionOverridePatch(BaseModel):
    """Body for PATCH /admin/pulse/catalogue/{key}.

    Both fields optional and independently applied. `prompt=null`
    clears the rewording (falls back to the default). `enabled` is
    a plain bool; omitting it leaves the current enabled-state
    untouched. Server validates the resulting effective set still
    has at least one enabled question per week."""

    prompt: str | None = Field(default=None, max_length=300)
    enabled: bool | None = None


@router.patch(
    "/admin/pulse/catalogue/{question_key}",
    response_model=PulseCatalogueOut,
)
def patch_admin_catalogue_question(
    question_key: str,
    payload: PulseQuestionOverridePatch,
    ctx: RequestContext = Depends(get_current_context),
) -> PulseCatalogueOut:
    """Apply a per-question override. Rejects if the change would
    leave the current ISO week with zero questions.

    The change takes effect for next week's survey at the latest.
    If you reword a question mid-week, members who haven't yet
    answered see the new prompt; members who already answered keep
    their score (the underlying question_key didn't change).
    """
    _require_admin(ctx)
    _ensure_settings_row(ctx)
    q = question_by_key(question_key)
    if q is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Pregunta '{question_key}' no existe.",
        )
    # Merge with existing overrides.
    overrides = _load_overrides(ctx)
    current = dict(overrides.get(question_key, {}))
    if payload.prompt is not None:
        # Empty string / whitespace = clear the override.
        stripped = payload.prompt.strip()
        if stripped:
            current["prompt"] = stripped
        else:
            current.pop("prompt", None)
    if payload.enabled is not None:
        current["enabled"] = payload.enabled
    # Empty merged dict → drop the key entirely so the JSON stays
    # tidy and the "is_customized" flag clears.
    if current:
        overrides[question_key] = current
    else:
        overrides.pop(question_key, None)
    # Floor check: the open week must still have at least one
    # effective question. Otherwise the admin would create a
    # window the team can't answer. Same week-resolution rule
    # the GET endpoints use.
    week_iso = _open_week_iso_for_tenant(ctx)
    week_questions = effective_questions_for_week(week_iso, overrides)
    if not week_questions:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=(
                "Necesitas al menos una pregunta activa cada "
                "semana. Activa al menos una antes de desactivar "
                "esta."
            ),
        )
    # Write back. We rebuild the whole column rather than use
    # jsonb_set so the "drop empty key" case is handled the same
    # way as "edit key".
    import json as _json

    ctx.db.execute(
        text(
            """
            UPDATE pulse_settings
            SET question_overrides = CAST(:j AS jsonb),
                updated_at = NOW()
            WHERE tenant_id = :tid
            """
        ),
        {"j": _json.dumps(overrides), "tid": ctx.tenant.id},
    )
    # Read back inside the transaction (same RLS-after-commit
    # gotcha we hit on patch_admin_settings).
    fresh_overrides = _load_overrides(ctx)
    ctx.db.commit()
    logger.info(
        "pulse override: tenant=%s key=%s prompt=%s enabled=%s",
        ctx.tenant.id,
        question_key,
        payload.prompt is not None,
        payload.enabled,
    )
    # Build the response in the same shape get_admin_catalogue
    # uses, but with fresh_overrides already in hand — avoids a
    # second RLS query after commit.
    return PulseCatalogueOut(
        current_week_iso=week_iso,
        core=[
            _to_catalogue_out(q, fresh_overrides) for q in CORE_QUESTIONS
        ],
        rotating=[
            _to_catalogue_out(q, fresh_overrides) for q in ROTATING_QUESTIONS
        ],
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
