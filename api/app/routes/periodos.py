"""Periodos especiales — admin CRUD + per-slot snapshot management +
generate trigger.

See docs/vacation-periods.md for the design. Admin-only across the
board: a non-admin reaching any of these endpoints gets 403.

Surfaces:

  /api/periodos                            CRUD on the periodo itself
  /api/periodos/{id}/slot-snapshots        per-(period, slot) full
                                           snapshot of slot+rules
                                           config (V.2.5)
  /api/periodos/{id}/succession-overrides  per-(period, succession
                                           rule) delta overrides (V.2)
  /api/periodos/{id}/cap-overrides         per-(period, frequency
                                           cap) delta overrides (V.2)
  /api/periodos/{id}/generate              one-button multi-month solve

Non-overlap of periodos per tenant is enforced at the DB layer (GiST
exclusion constraint added in migration 0075). We catch the resulting
IntegrityError and turn it into a 422 with a friendly Spanish
message.
"""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.models import (
    PeriodoEspecial,
    Schedule,
    Slot,
    SlotFrequencyCap,
    SlotFrequencyCapPeriodOverride,
    SlotPeriodSnapshot,
    SlotPeriodSnapshotAllowedPerson,
    SlotPeriodSnapshotCategory,
    SlotPeriodSnapshotRule,
    SlotPeriodSnapshotRuleRotationBlock,
    SlotPeriodSnapshotRuleRotationMember,
    SlotPeriodSnapshotRuleWeeklyPin,
    SlotPeriodSnapshotTeamRole,
    SlotPeriodSnapshotTeamRoleCategory,
    SlotSuccessionRule,
    SlotSuccessionRulePeriodExtra,
    SlotSuccessionRulePeriodOverride,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.periodo_especial import (
    GeneratePeriodResult,
    PeriodoEspecialCreate,
    PeriodoEspecialOut,
    PeriodoEspecialUpdate,
    SlotFrequencyCapPeriodOverrideOut,
    SlotFrequencyCapPeriodOverrideUpsert,
    SlotPeriodSnapshotOut,
    SlotPeriodSnapshotUpsert,
    SlotSuccessionRulePeriodExtraIn,
    SlotSuccessionRulePeriodExtraOut,
    SlotSuccessionRulePeriodOverrideOut,
    SlotSuccessionRulePeriodOverrideUpsert,
)
from app.schemas.slot import SlotTeamRoleOut
from app.schemas.slot_rule import (
    RotationBlockOut,
    RotationMemberOut,
    SlotRuleOut,
    WeeklyPinOut,
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
    # Slot snapshots + succession/cap overrides cascade via the FK
    # ondelete=CASCADE; Schedule rows generated under this periodo
    # are NOT cascade-deleted — they stand on their own once
    # produced. Mara can delete them individually via the schedule
    # UI if she wants.
    ctx.db.delete(p)
    ctx.db.flush()


# ---------------------------------------------------------------------------
# Slot snapshots (V.2.5)
# ---------------------------------------------------------------------------


def _serialize_snapshot(snap: SlotPeriodSnapshot) -> SlotPeriodSnapshotOut:
    """Serialize a snapshot + its child rows to the response shape.
    Mirrors the /api/slots serializer so the frontend can feed both
    payloads into the same SlotDialog."""
    team_role_rows = sorted(snap.team_roles, key=lambda r: r.id)
    return SlotPeriodSnapshotOut(
        id=snap.id,
        period_id=snap.period_id,
        slot_id=snap.slot_id,
        dismissed=snap.dismissed,
        start_time=snap.start_time,
        end_time=snap.end_time,
        days_applied=snap.days_applied,  # type: ignore[arg-type]
        custom_days_bitmap=snap.custom_days_bitmap,
        staffing_mode=snap.staffing_mode,  # type: ignore[arg-type]
        headcount=snap.headcount,
        post_slot_rest=snap.post_slot_rest,
        counts_for_equity=snap.counts_for_equity,
        guardia_type=snap.guardia_type,
        color=snap.color,
        team_roles=[
            SlotTeamRoleOut(
                id=tr.id,
                role_label=tr.role_label,
                headcount=tr.headcount,
                category_ids=sorted(c.category_id for c in tr.categories),
            )
            for tr in team_role_rows
        ],
        allowed_person_ids=sorted(p.person_id for p in snap.allowed_persons),
        allowed_category_ids=sorted(c.category_id for c in snap.categories),
        rules=[
            SlotRuleOut(
                id=r.id,
                tenant_id=r.tenant_id,
                position=r.position,
                days_bitmap=r.days_bitmap,
                strategy=r.strategy,  # type: ignore[arg-type]
                anchor_date=r.anchor_date,
                weeks_per_position=r.weeks_per_position,
                weekly_pins=[
                    WeeklyPinOut(
                        id=p.id, weekday=p.weekday, person_id=p.person_id
                    )
                    for p in sorted(r.weekly_pins, key=lambda x: x.id)
                ],
                rotation_blocks=[
                    RotationBlockOut(
                        id=b.id, position=b.position, days_bitmap=b.days_bitmap
                    )
                    for b in sorted(r.rotation_blocks, key=lambda x: x.position)
                ],
                rotation_members=[
                    RotationMemberOut(
                        id=m.id, position=m.position, person_id=m.person_id
                    )
                    for m in sorted(r.rotation_members, key=lambda x: (x.position, x.id))
                ],
            )
            for r in sorted(snap.rules, key=lambda x: x.position)
        ],
        created_at=snap.created_at,
    )


@router.get(
    "/periodos/{period_id}/slot-snapshots",
    response_model=list[SlotPeriodSnapshotOut],
)
def list_slot_snapshots(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotPeriodSnapshotOut]:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    rows = (
        ctx.db.query(SlotPeriodSnapshot)
        .filter(SlotPeriodSnapshot.period_id == period_id)
        .all()
    )
    return [_serialize_snapshot(r) for r in rows]


@router.put(
    "/periodos/{period_id}/slot-snapshots/{slot_id}",
    response_model=SlotPeriodSnapshotOut,
)
def upsert_slot_snapshot(
    period_id: int,
    slot_id: int,
    payload: SlotPeriodSnapshotUpsert,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotPeriodSnapshotOut:
    """Create or replace the snapshot for one (period, slot) pair.

    Replaces the snapshot row AND every child row (rules, weekly_pins,
    rotation_blocks, rotation_members, team_roles, team_role_categories,
    categories, allowed_persons) atomically. The frontend's SlotDialog
    sends the full slot config in `mode='period-snapshot'` — same
    payload shape as PUT /api/slots/{id}, with `dismissed` at the top
    level.

    Use DELETE on the same URL to revert the slot to its defaults
    during the period (drops the snapshot and all its child rows).
    """
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    # Slot must belong to caller's tenant.
    slot = (
        ctx.db.query(Slot)
        .filter(Slot.id == slot_id, Slot.tenant_id == ctx.tenant.id)
        .one_or_none()
    )
    if slot is None:
        raise HTTPException(status_code=404, detail="Slot no encontrado")

    # Drop any existing snapshot first (CASCADE wipes child rows).
    # Atomic replace; we don't try to diff-patch.
    ctx.db.query(SlotPeriodSnapshot).filter(
        SlotPeriodSnapshot.period_id == period_id,
        SlotPeriodSnapshot.slot_id == slot_id,
    ).delete(synchronize_session=False)
    ctx.db.flush()

    snap = SlotPeriodSnapshot(
        tenant_id=ctx.tenant.id,
        period_id=period_id,
        slot_id=slot_id,
        dismissed=payload.dismissed,
        start_time=payload.start_time,
        end_time=payload.end_time,
        days_applied=payload.days_applied,
        custom_days_bitmap=payload.custom_days_bitmap,
        staffing_mode=payload.staffing_mode,
        headcount=payload.headcount,
        post_slot_rest=payload.post_slot_rest,
        counts_for_equity=payload.counts_for_equity,
        guardia_type=payload.guardia_type or None,
        color=payload.color or None,
    )
    ctx.db.add(snap)
    ctx.db.flush()

    # Team roles + their categoría restrictions.
    for tr in payload.team_roles:
        tr_row = SlotPeriodSnapshotTeamRole(
            tenant_id=ctx.tenant.id,
            snapshot_id=snap.id,
            role_label=tr.role_label,
            headcount=tr.headcount,
        )
        ctx.db.add(tr_row)
        ctx.db.flush()
        for cat_id in tr.category_ids:
            ctx.db.add(
                SlotPeriodSnapshotTeamRoleCategory(
                    tenant_id=ctx.tenant.id,
                    snapshot_team_role_id=tr_row.id,
                    category_id=cat_id,
                )
            )

    # Slot-level allow-lists.
    for pid in payload.allowed_person_ids:
        ctx.db.add(
            SlotPeriodSnapshotAllowedPerson(
                tenant_id=ctx.tenant.id,
                snapshot_id=snap.id,
                person_id=pid,
            )
        )
    for cid in payload.allowed_category_ids:
        ctx.db.add(
            SlotPeriodSnapshotCategory(
                tenant_id=ctx.tenant.id,
                snapshot_id=snap.id,
                category_id=cid,
            )
        )

    # Rules + child rows.
    for idx, rule in enumerate(payload.rules):
        rule_row = SlotPeriodSnapshotRule(
            tenant_id=ctx.tenant.id,
            snapshot_id=snap.id,
            position=idx,
            days_bitmap=rule.days_bitmap,
            strategy=rule.strategy,
            anchor_date=rule.anchor_date,
            weeks_per_position=rule.weeks_per_position,
        )
        ctx.db.add(rule_row)
        ctx.db.flush()
        for pin in rule.weekly_pins:
            ctx.db.add(
                SlotPeriodSnapshotRuleWeeklyPin(
                    tenant_id=ctx.tenant.id,
                    snapshot_rule_id=rule_row.id,
                    weekday=pin.weekday,
                    person_id=pin.person_id,
                )
            )
        for block in rule.rotation_blocks:
            ctx.db.add(
                SlotPeriodSnapshotRuleRotationBlock(
                    tenant_id=ctx.tenant.id,
                    snapshot_rule_id=rule_row.id,
                    position=block.position,
                    days_bitmap=block.days_bitmap,
                )
            )
        for member in rule.rotation_members:
            ctx.db.add(
                SlotPeriodSnapshotRuleRotationMember(
                    tenant_id=ctx.tenant.id,
                    snapshot_rule_id=rule_row.id,
                    position=member.position,
                    person_id=member.person_id,
                )
            )

    ctx.db.flush()
    ctx.db.refresh(snap)
    return _serialize_snapshot(snap)


@router.delete(
    "/periodos/{period_id}/slot-snapshots/{slot_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_slot_snapshot(
    period_id: int,
    slot_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Remove the snapshot so the slot reverts to its defaults
    during the period. No-op (204) if no snapshot exists. CASCADE
    on the snapshot table cleans up every child row."""
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    ctx.db.query(SlotPeriodSnapshot).filter(
        SlotPeriodSnapshot.period_id == period_id,
        SlotPeriodSnapshot.slot_id == slot_id,
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
    periodo = _get_periodo_or_404(ctx, period_id)

    # Billing gate (migration 0080). The trial horizon check is
    # against periodo.end_date (not start_date) so a trial admin
    # creating a Verano period Jul-Sep in May gets blocked because
    # Sep is past the horizon (May + 2 = July). Hard-gates unpaid /
    # canceled tenants outright.
    from app.services.billing import can_generate_for
    ok, reason = can_generate_for(ctx.tenant, periodo.end_date)
    if not ok:
        raise HTTPException(status_code=403, detail=reason)
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


# ---------------------------------------------------------------------------
# V.2 — succession + frequency cap deltas
#
# Per-rule SlotRule overrides moved to the V.2.5 snapshot model
# (they're part of the slot's full config now). The two surfaces below
# remain because succession + cap rules are tenant-scoped (cross-slot),
# so the delta model still fits.
# ---------------------------------------------------------------------------


@router.get(
    "/periodos/{period_id}/succession-overrides",
    response_model=list[SlotSuccessionRulePeriodOverrideOut],
)
def list_succession_overrides(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotSuccessionRulePeriodOverrideOut]:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    rows = (
        ctx.db.query(SlotSuccessionRulePeriodOverride)
        .filter(SlotSuccessionRulePeriodOverride.period_id == period_id)
        .all()
    )
    return [
        SlotSuccessionRulePeriodOverrideOut.model_validate(
            r, from_attributes=True
        )
        for r in rows
    ]


@router.put(
    "/periodos/{period_id}/succession-overrides/{succession_rule_id}",
    response_model=SlotSuccessionRulePeriodOverrideOut,
)
def upsert_succession_override(
    period_id: int,
    succession_rule_id: int,
    payload: SlotSuccessionRulePeriodOverrideUpsert,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotSuccessionRulePeriodOverrideOut:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    rule = (
        ctx.db.query(SlotSuccessionRule)
        .filter(
            SlotSuccessionRule.id == succession_rule_id,
            SlotSuccessionRule.tenant_id == ctx.tenant.id,
        )
        .one_or_none()
    )
    if rule is None:
        raise HTTPException(
            status_code=404, detail="Regla de sucesión no encontrada"
        )

    existing = (
        ctx.db.query(SlotSuccessionRulePeriodOverride)
        .filter(
            SlotSuccessionRulePeriodOverride.period_id == period_id,
            SlotSuccessionRulePeriodOverride.succession_rule_id
            == succession_rule_id,
        )
        .one_or_none()
    )
    if existing is None:
        row = SlotSuccessionRulePeriodOverride(
            tenant_id=ctx.tenant.id,
            period_id=period_id,
            succession_rule_id=succession_rule_id,
        )
        ctx.db.add(row)
    else:
        row = existing
    row.days_after_override = payload.days_after_override
    row.severity_override = payload.severity_override
    row.disabled = payload.disabled
    ctx.db.flush()
    return SlotSuccessionRulePeriodOverrideOut.model_validate(
        row, from_attributes=True
    )


@router.delete(
    "/periodos/{period_id}/succession-overrides/{succession_rule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_succession_override(
    period_id: int,
    succession_rule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    ctx.db.query(SlotSuccessionRulePeriodOverride).filter(
        SlotSuccessionRulePeriodOverride.period_id == period_id,
        SlotSuccessionRulePeriodOverride.succession_rule_id
        == succession_rule_id,
    ).delete(synchronize_session=False)
    ctx.db.flush()


# ---------------------------------------------------------------------------
# Period-only succession rules (migration 0078)
#
# Complements the override CRUD above. The override edits an existing
# global rule for the period; the extras CRUD lets the admin create
# NEW rules that ONLY apply inside the period — covering the case
# where no global rule exists but one is needed for the season.
# ---------------------------------------------------------------------------


def _validate_extra_payload(
    ctx: RequestContext, payload: SlotSuccessionRulePeriodExtraIn
) -> tuple[Slot, Slot]:
    """Validate that the slot + sub-role refs in `payload` belong to
    this tenant, and that role refs point at roles of the named slot.

    Returns the two slot rows so caller doesn't re-query.
    """
    after_slot = (
        ctx.db.query(Slot)
        .filter(Slot.id == payload.after_slot_id, Slot.tenant_id == ctx.tenant.id)
        .one_or_none()
    )
    forbid_slot = (
        ctx.db.query(Slot)
        .filter(
            Slot.id == payload.forbid_slot_id, Slot.tenant_id == ctx.tenant.id
        )
        .one_or_none()
    )
    if after_slot is None or forbid_slot is None:
        raise HTTPException(status_code=404, detail="Actividad no encontrada")
    # Role-belongs-to-slot check. Done by joining SlotTeamRole rather
    # than touching the slot relationship, so the validation is one
    # cheap query regardless of how big the slot's team_roles list is.
    from app.models import SlotTeamRole

    for slot, role_id, side in (
        (after_slot, payload.after_team_role_id, "después de"),
        (forbid_slot, payload.forbid_team_role_id, "no se puede"),
    ):
        if role_id is None:
            continue
        owned = (
            ctx.db.query(SlotTeamRole)
            .filter(
                SlotTeamRole.id == role_id,
                SlotTeamRole.slot_id == slot.id,
            )
            .one_or_none()
        )
        if owned is None:
            raise HTTPException(
                status_code=422,
                detail=(
                    f"La sub-actividad seleccionada en \"{side}\" no "
                    f"pertenece a la actividad elegida."
                ),
            )
    return after_slot, forbid_slot


@router.get(
    "/periodos/{period_id}/succession-extras",
    response_model=list[SlotSuccessionRulePeriodExtraOut],
)
def list_succession_extras(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotSuccessionRulePeriodExtraOut]:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    rows = (
        ctx.db.query(SlotSuccessionRulePeriodExtra)
        .filter(SlotSuccessionRulePeriodExtra.period_id == period_id)
        .order_by(SlotSuccessionRulePeriodExtra.id)
        .all()
    )
    return [
        SlotSuccessionRulePeriodExtraOut.model_validate(r, from_attributes=True)
        for r in rows
    ]


@router.post(
    "/periodos/{period_id}/succession-extras",
    response_model=SlotSuccessionRulePeriodExtraOut,
    status_code=status.HTTP_201_CREATED,
)
def create_succession_extra(
    period_id: int,
    payload: SlotSuccessionRulePeriodExtraIn,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotSuccessionRulePeriodExtraOut:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    _validate_extra_payload(ctx, payload)
    row = SlotSuccessionRulePeriodExtra(
        tenant_id=ctx.tenant.id,
        period_id=period_id,
        after_slot_id=payload.after_slot_id,
        forbid_slot_id=payload.forbid_slot_id,
        after_team_role_id=payload.after_team_role_id,
        forbid_team_role_id=payload.forbid_team_role_id,
        days_after=payload.days_after,
        severity=payload.severity,
        weight=payload.weight,
    )
    ctx.db.add(row)
    ctx.db.flush()
    return SlotSuccessionRulePeriodExtraOut.model_validate(
        row, from_attributes=True
    )


@router.put(
    "/periodos/{period_id}/succession-extras/{extra_id}",
    response_model=SlotSuccessionRulePeriodExtraOut,
)
def update_succession_extra(
    period_id: int,
    extra_id: int,
    payload: SlotSuccessionRulePeriodExtraIn,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotSuccessionRulePeriodExtraOut:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    row = (
        ctx.db.query(SlotSuccessionRulePeriodExtra)
        .filter(
            SlotSuccessionRulePeriodExtra.id == extra_id,
            SlotSuccessionRulePeriodExtra.period_id == period_id,
        )
        .one_or_none()
    )
    if row is None:
        raise HTTPException(status_code=404, detail="Regla no encontrada")
    _validate_extra_payload(ctx, payload)
    row.after_slot_id = payload.after_slot_id
    row.forbid_slot_id = payload.forbid_slot_id
    row.after_team_role_id = payload.after_team_role_id
    row.forbid_team_role_id = payload.forbid_team_role_id
    row.days_after = payload.days_after
    row.severity = payload.severity
    row.weight = payload.weight
    ctx.db.flush()
    return SlotSuccessionRulePeriodExtraOut.model_validate(
        row, from_attributes=True
    )


@router.delete(
    "/periodos/{period_id}/succession-extras/{extra_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_succession_extra(
    period_id: int,
    extra_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    ctx.db.query(SlotSuccessionRulePeriodExtra).filter(
        SlotSuccessionRulePeriodExtra.id == extra_id,
        SlotSuccessionRulePeriodExtra.period_id == period_id,
    ).delete(synchronize_session=False)
    ctx.db.flush()


@router.get(
    "/periodos/{period_id}/cap-overrides",
    response_model=list[SlotFrequencyCapPeriodOverrideOut],
)
def list_cap_overrides(
    period_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotFrequencyCapPeriodOverrideOut]:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    rows = (
        ctx.db.query(SlotFrequencyCapPeriodOverride)
        .filter(SlotFrequencyCapPeriodOverride.period_id == period_id)
        .all()
    )
    return [
        SlotFrequencyCapPeriodOverrideOut.model_validate(
            r, from_attributes=True
        )
        for r in rows
    ]


@router.put(
    "/periodos/{period_id}/cap-overrides/{cap_id}",
    response_model=SlotFrequencyCapPeriodOverrideOut,
)
def upsert_cap_override(
    period_id: int,
    cap_id: int,
    payload: SlotFrequencyCapPeriodOverrideUpsert,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotFrequencyCapPeriodOverrideOut:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    cap = (
        ctx.db.query(SlotFrequencyCap)
        .filter(
            SlotFrequencyCap.id == cap_id,
            SlotFrequencyCap.tenant_id == ctx.tenant.id,
        )
        .one_or_none()
    )
    if cap is None:
        raise HTTPException(status_code=404, detail="Límite no encontrado")

    existing = (
        ctx.db.query(SlotFrequencyCapPeriodOverride)
        .filter(
            SlotFrequencyCapPeriodOverride.period_id == period_id,
            SlotFrequencyCapPeriodOverride.cap_id == cap_id,
        )
        .one_or_none()
    )
    if existing is None:
        row = SlotFrequencyCapPeriodOverride(
            tenant_id=ctx.tenant.id,
            period_id=period_id,
            cap_id=cap_id,
        )
        ctx.db.add(row)
    else:
        row = existing
    row.max_count_override = payload.max_count_override
    row.severity_override = payload.severity_override
    row.disabled = payload.disabled
    ctx.db.flush()
    return SlotFrequencyCapPeriodOverrideOut.model_validate(
        row, from_attributes=True
    )


@router.delete(
    "/periodos/{period_id}/cap-overrides/{cap_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_cap_override(
    period_id: int,
    cap_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    _get_periodo_or_404(ctx, period_id)
    ctx.db.query(SlotFrequencyCapPeriodOverride).filter(
        SlotFrequencyCapPeriodOverride.period_id == period_id,
        SlotFrequencyCapPeriodOverride.cap_id == cap_id,
    ).delete(synchronize_session=False)
    ctx.db.flush()
