"""Cross-slot dependency endpoints (sprint 14).

Two CRUDs:
- /api/slot-succession-rules
- /api/slot-frequency-caps

Both are admin-only and tenant-scoped via the standard RequestContext +
RLS path. POST is idempotent on the natural key (after/forbid/days_after/
applies_to for succession; slot_id+period for frequency caps) — same
admin-multiplayer pattern as categories/skills/pools.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.exc import IntegrityError

from app.models import Slot, SlotFrequencyCap, SlotSuccessionRule
from app.routes.deps import RequestContext, get_current_context
from app.schemas.slot_dependencies import (
    SlotFrequencyCapIn,
    SlotFrequencyCapOut,
    SlotFrequencyCapUpdate,
    SlotSuccessionRuleIn,
    SlotSuccessionRuleOut,
    SlotSuccessionRuleUpdate,
)


router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _slot_or_422(ctx: RequestContext, slot_id: int, label: str) -> Slot:
    s = ctx.db.get(Slot, slot_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(
            status_code=422, detail=f"{label} no pertenece a este tenant"
        )
    return s


# ---------------------------------------------------------------------------
# Succession rules
# ---------------------------------------------------------------------------


@router.get(
    "/slot-succession-rules", response_model=list[SlotSuccessionRuleOut]
)
def list_succession_rules(
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotSuccessionRuleOut]:
    rows = (
        ctx.db.query(SlotSuccessionRule)
        .order_by(SlotSuccessionRule.id)
        .all()
    )
    return [SlotSuccessionRuleOut.model_validate(r) for r in rows]


@router.post(
    "/slot-succession-rules", response_model=SlotSuccessionRuleOut
)
def create_succession_rule(
    payload: SlotSuccessionRuleIn,
    response: Response,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotSuccessionRuleOut:
    _require_admin(ctx)
    # whole_team is schema-supported but solver path is deferred — reject
    # at the API layer for v1 so admins don't think they can configure it.
    if payload.applies_to == "whole_team":
        raise HTTPException(
            status_code=422,
            detail="applies_to='whole_team' aún no está soportado",
        )
    _slot_or_422(ctx, payload.after_slot_id, "after_slot_id")
    _slot_or_422(ctx, payload.forbid_slot_id, "forbid_slot_id")
    # Self-pair with same-day (days_after=0) is degenerate: a slot can't
    # conflict with itself on the same day — the slot's own headcount
    # already prevents that. Reject so admins don't create rules that
    # silently force the slot empty.
    if (
        payload.days_after == 0
        and payload.after_slot_id == payload.forbid_slot_id
    ):
        raise HTTPException(
            status_code=422,
            detail="Una incompatibilidad del mismo día requiere dos turnos diferentes",
        )

    existing = (
        ctx.db.query(SlotSuccessionRule)
        .filter(
            SlotSuccessionRule.after_slot_id == payload.after_slot_id,
            SlotSuccessionRule.forbid_slot_id == payload.forbid_slot_id,
            SlotSuccessionRule.days_after == payload.days_after,
            SlotSuccessionRule.applies_to == payload.applies_to,
        )
        .first()
    )
    if existing:
        response.status_code = status.HTTP_200_OK
        return SlotSuccessionRuleOut.model_validate(existing)

    obj = SlotSuccessionRule(
        tenant_id=ctx.tenant.id,
        after_slot_id=payload.after_slot_id,
        forbid_slot_id=payload.forbid_slot_id,
        days_after=payload.days_after,
        applies_to=payload.applies_to,
        severity=payload.severity,
        weight=payload.weight,
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        winner = (
            ctx.db.query(SlotSuccessionRule)
            .filter(
                SlotSuccessionRule.after_slot_id == payload.after_slot_id,
                SlotSuccessionRule.forbid_slot_id == payload.forbid_slot_id,
                SlotSuccessionRule.days_after == payload.days_after,
                SlotSuccessionRule.applies_to == payload.applies_to,
            )
            .first()
        )
        if winner:
            response.status_code = status.HTTP_200_OK
            return SlotSuccessionRuleOut.model_validate(winner)
        raise HTTPException(status_code=409, detail="Conflicto al crear la regla")
    ctx.db.refresh(obj)
    response.status_code = status.HTTP_201_CREATED
    return SlotSuccessionRuleOut.model_validate(obj)


def _succession_or_404(
    ctx: RequestContext, rule_id: int
) -> SlotSuccessionRule:
    obj = ctx.db.get(SlotSuccessionRule, rule_id)
    if not obj or obj.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Succession rule not found")
    return obj


@router.put(
    "/slot-succession-rules/{rule_id}", response_model=SlotSuccessionRuleOut
)
def update_succession_rule(
    rule_id: int,
    payload: SlotSuccessionRuleUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotSuccessionRuleOut:
    _require_admin(ctx)
    obj = _succession_or_404(ctx, rule_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        if v is not None:
            setattr(obj, k, v)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Conflicto al actualizar la regla")
    ctx.db.refresh(obj)
    return SlotSuccessionRuleOut.model_validate(obj)


@router.delete(
    "/slot-succession-rules/{rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_succession_rule(
    rule_id: int, ctx: RequestContext = Depends(get_current_context)
) -> None:
    _require_admin(ctx)
    obj = _succession_or_404(ctx, rule_id)
    ctx.db.delete(obj)
    ctx.db.flush()


# ---------------------------------------------------------------------------
# Frequency caps
# ---------------------------------------------------------------------------


@router.get("/slot-frequency-caps", response_model=list[SlotFrequencyCapOut])
def list_frequency_caps(
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotFrequencyCapOut]:
    rows = (
        ctx.db.query(SlotFrequencyCap).order_by(SlotFrequencyCap.id).all()
    )
    return [SlotFrequencyCapOut.model_validate(r) for r in rows]


@router.post("/slot-frequency-caps", response_model=SlotFrequencyCapOut)
def create_frequency_cap(
    payload: SlotFrequencyCapIn,
    response: Response,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotFrequencyCapOut:
    _require_admin(ctx)
    _slot_or_422(ctx, payload.slot_id, "slot_id")

    existing = (
        ctx.db.query(SlotFrequencyCap)
        .filter(
            SlotFrequencyCap.slot_id == payload.slot_id,
            SlotFrequencyCap.period == payload.period,
        )
        .first()
    )
    if existing:
        response.status_code = status.HTTP_200_OK
        return SlotFrequencyCapOut.model_validate(existing)

    obj = SlotFrequencyCap(
        tenant_id=ctx.tenant.id,
        slot_id=payload.slot_id,
        period=payload.period,
        max_count=payload.max_count,
        severity=payload.severity,
        weight=payload.weight,
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        winner = (
            ctx.db.query(SlotFrequencyCap)
            .filter(
                SlotFrequencyCap.slot_id == payload.slot_id,
                SlotFrequencyCap.period == payload.period,
            )
            .first()
        )
        if winner:
            response.status_code = status.HTTP_200_OK
            return SlotFrequencyCapOut.model_validate(winner)
        raise HTTPException(status_code=409, detail="Conflicto al crear el límite")
    ctx.db.refresh(obj)
    response.status_code = status.HTTP_201_CREATED
    return SlotFrequencyCapOut.model_validate(obj)


def _freqcap_or_404(ctx: RequestContext, cap_id: int) -> SlotFrequencyCap:
    obj = ctx.db.get(SlotFrequencyCap, cap_id)
    if not obj or obj.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Frequency cap not found")
    return obj


@router.put(
    "/slot-frequency-caps/{cap_id}", response_model=SlotFrequencyCapOut
)
def update_frequency_cap(
    cap_id: int,
    payload: SlotFrequencyCapUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotFrequencyCapOut:
    _require_admin(ctx)
    obj = _freqcap_or_404(ctx, cap_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        if v is not None:
            setattr(obj, k, v)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Conflicto al actualizar el límite")
    ctx.db.refresh(obj)
    return SlotFrequencyCapOut.model_validate(obj)


@router.delete(
    "/slot-frequency-caps/{cap_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_frequency_cap(
    cap_id: int, ctx: RequestContext = Depends(get_current_context)
) -> None:
    _require_admin(ctx)
    obj = _freqcap_or_404(ctx, cap_id)
    ctx.db.delete(obj)
    ctx.db.flush()
