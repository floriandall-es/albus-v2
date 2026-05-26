"""Periodos especiales — admin CRUD + per-slot override management +
generate trigger.

See docs/vacation-periods.md for the design. Admin-only across the
board: a non-admin reaching any of these endpoints gets 403.

Three surfaces:

  /api/periodos          CRUD on the periodo itself
  /api/periodos/{id}/slot-overrides    per-(period, slot) overrides
  /api/periodos/{id}/generate          one-button multi-month solve

Non-overlap of periodos per tenant is enforced at the DB layer (GiST
exclusion constraint added in migration 0075). We catch the resulting
IntegrityError and turn it into a 422 with a friendly Spanish
message.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.models import PeriodoEspecial, Schedule, Slot, SlotPeriodOverride
from app.routes.deps import RequestContext, get_current_context
from app.schemas.periodo_especial import (
    GeneratePeriodResult,
    PeriodoEspecialCreate,
    PeriodoEspecialOut,
    PeriodoEspecialUpdate,
    SlotPeriodOverrideOut,
    SlotPeriodOverrideUpsert,
)
from app.services import scheduler


router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )


def _get_periodo_or_404(ctx: RequestContext, period_id: int) -> PeriodoEspecial:
    p = (
        ctx.db.query(PeriodoEspecial)
        .filter(
            PeriodoEspecial.id == period_id,
            PeriodoEspecial.tenant_id == ctx.tenant.id,
        )
        .one_or_none()
    )
    if p is None:
        raise HTTPException(status_code=404, detail="Periodo no encontrado")
    return p


# ---------------------------------------------------------------------------
# Periodos CRUD
# ---------------------------------------------------------------------------


@router.get("/periodos", response_model=list[PeriodoEspecialOut])
def list_periodos(
    ctx: RequestContext = Depends(get_current_context),
) -> list[PeriodoEspecialOut]:
    _require_admin(ctx)
    rows = (
        ctx.db.query(PeriodoEspecial)
        .order_by(PeriodoEspecial.start_date.desc())
        .all()
    )
    return [PeriodoEspecialOut.model_validate(r, from_attributes=True) for r in rows]


@router.post(
    "/periodos",
    response_model=PeriodoEspecialOut,
    status_code=status.HTTP_201_CREATED,
)
def create_periodo(
    payload: PeriodoEspecialCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> PeriodoEspecialOut:
    _require_admin(ctx)
    p = PeriodoEspecial(
        tenant_id=ctx.tenant.id,
        name=payload.name.strip(),
        start_date=payload.start_date,
        end_date=payload.end_date,
    )
    ctx.db.add(p)
    try:
        ctx.db.flush()
    except IntegrityError as e:
        ctx.db.rollback()
        # The GiST exclusion constraint trips when the new range
        # overlaps an existing periodo for this tenant. Surface a
        # human-readable error so the UI can show "ya existe un
        # periodo solapado" without parsing Postgres internals.
        if "ex_periodos_especiales_no_overlap" in str(e.orig):
            raise HTTPException(
                status_code=422,
                detail=(
                    "Ese rango se solapa con otro periodo ya definido. "
                    "Ajusta las fechas o elimina el periodo existente."
                ),
            ) from e
        raise
    return PeriodoEspecialOut.model_validate(p, from_attributes=True)


@router.get("/periodos/{period_id}", response_model=PeriodoEspecialOut)
def get_periodo(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> PeriodoEspecialOut:
    _require_admin(ctx)
    p = _get_periodo_or_404(ctx, period_id)
    return PeriodoEspecialOut.model_validate(p, from_attributes=True)


@router.patch("/periodos/{period_id}", response_model=PeriodoEspecialOut)
def update_periodo(
    period_id: int,
    payload: PeriodoEspecialUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> PeriodoEspecialOut:
    _require_admin(ctx)
    p = _get_periodo_or_404(ctx, period_id)
    data = payload.model_dump(exclude_unset=True)
    if "name" in data and data["name"] is not None:
        p.name = data["name"].strip()
    new_start = data.get("start_date", p.start_date)
    new_end = data.get("end_date", p.end_date)
    if new_end < new_start:
        raise HTTPException(
            status_code=422,
            detail="end_date debe ser igual o posterior a start_date",
        )
    p.start_date = new_start
    p.end_date = new_end
    try:
        ctx.db.flush()
    except IntegrityError as e:
        ctx.db.rollback()
        if "ex_periodos_especiales_no_overlap" in str(e.orig):
            raise HTTPException(
                status_code=422,
                detail=(
                    "El nuevo rango se solapa con otro periodo. "
                    "Ajusta las fechas o elimina el periodo en conflicto."
                ),
            ) from e
        raise
    return PeriodoEspecialOut.model_validate(p, from_attributes=True)


@router.delete(
    "/periodos/{period_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_periodo(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    p = _get_periodo_or_404(ctx, period_id)
    # Slot overrides cascade via the FK ondelete=CASCADE; Schedule
    # rows generated under this periodo are NOT cascade-deleted —
    # they stand on their own once produced. Mara can delete them
    # individually via the schedule UI if she wants.
    ctx.db.delete(p)
    ctx.db.flush()


# ---------------------------------------------------------------------------
# Slot overrides
# ---------------------------------------------------------------------------


@router.get(
    "/periodos/{period_id}/slot-overrides",
    response_model=list[SlotPeriodOverrideOut],
)
def list_slot_overrides(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotPeriodOverrideOut]:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    rows = (
        ctx.db.query(SlotPeriodOverride)
        .filter(SlotPeriodOverride.period_id == period_id)
        .all()
    )
    return [
        SlotPeriodOverrideOut.model_validate(r, from_attributes=True)
        for r in rows
    ]


@router.put(
    "/periodos/{period_id}/slot-overrides/{slot_id}",
    response_model=SlotPeriodOverrideOut,
)
def upsert_slot_override(
    period_id: int,
    slot_id: int,
    payload: SlotPeriodOverrideUpsert,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotPeriodOverrideOut:
    """Create or replace the override for one (period, slot) pair.

    Idempotent: re-PUT with the same body produces the same row.
    Use DELETE on the same URL to remove the override (revert the
    slot to its defaults inside the period)."""
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    # Slot must belong to caller's tenant — RLS already enforces it,
    # but a clean 404 is friendlier than a silent empty query.
    slot = (
        ctx.db.query(Slot)
        .filter(Slot.id == slot_id, Slot.tenant_id == ctx.tenant.id)
        .one_or_none()
    )
    if slot is None:
        raise HTTPException(status_code=404, detail="Slot no encontrado")

    existing = (
        ctx.db.query(SlotPeriodOverride)
        .filter(
            SlotPeriodOverride.period_id == period_id,
            SlotPeriodOverride.slot_id == slot_id,
        )
        .one_or_none()
    )
    if existing is None:
        row = SlotPeriodOverride(
            tenant_id=ctx.tenant.id,
            period_id=period_id,
            slot_id=slot_id,
        )
        ctx.db.add(row)
    else:
        row = existing

    row.headcount_override = payload.headcount_override
    row.staffing_mode_override = payload.staffing_mode_override
    row.dismissed = payload.dismissed
    row.allowed_category_ids_override = payload.allowed_category_ids_override
    row.allowed_person_ids_override = payload.allowed_person_ids_override
    ctx.db.flush()
    return SlotPeriodOverrideOut.model_validate(row, from_attributes=True)


@router.delete(
    "/periodos/{period_id}/slot-overrides/{slot_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_slot_override(
    period_id: int,
    slot_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Remove the override for (period, slot) so the slot returns
    to its defaults inside the period. No-op (204) if no override
    exists."""
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    ctx.db.query(SlotPeriodOverride).filter(
        SlotPeriodOverride.period_id == period_id,
        SlotPeriodOverride.slot_id == slot_id,
    ).delete(synchronize_session=False)
    ctx.db.flush()


# ---------------------------------------------------------------------------
# Generate
# ---------------------------------------------------------------------------


@router.post(
    "/periodos/{period_id}/generate",
    response_model=list[GeneratePeriodResult],
)
def generate_periodo(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[GeneratePeriodResult]:
    """One-button solve covering every full month that the periodo
    touches. Returns one row per Schedule created (one per touched
    month). Existing drafts in those months are regenerated with
    locked cells preserved; existing PUBLISHED or ARCHIVED schedules
    abort the operation with 409 — caller has to archive/delete
    them first."""
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    try:
        schedules = scheduler.generate_period(
            ctx.db,
            tenant_id=ctx.tenant.id,
            period_id=period_id,
            membership_id=ctx.membership.id,
        )
    except ValueError as e:
        # generate_period raises ValueError when an existing
        # schedule is published or archived. Surface it as a 409.
        raise HTTPException(status_code=409, detail=str(e)) from e

    from app.models import Assignment

    out: list[GeneratePeriodResult] = []
    for s in schedules:
        n_assignments = (
            ctx.db.query(Assignment)
            .filter(Assignment.schedule_id == s.id)
            .count()
        )
        out.append(
            GeneratePeriodResult(
                schedule_id=s.id,
                period=s.period.isoformat(),
                solver_used=s.solver_used or "cpsat",
                assignments_created=n_assignments,
            )
        )
    return out
