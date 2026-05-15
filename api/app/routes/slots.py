from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.models import (
    Category,
    Membership,
    Skill,
    Slot,
    SlotRule,
    SlotRuleRotationBlock,
    SlotRuleRotationMember,
    SlotRuleWeeklyPin,
    SlotSkillRequired,
    SlotTeamRole,
    SlotTeamRoleCategory,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.slot import (
    SlotCreate,
    SlotOut,
    SlotSkillRequiredIn,
    SlotSkillRequiredOut,
    SlotTeamRoleIn,
    SlotTeamRoleOut,
    SlotUpdate,
)
from app.schemas.slot_rule import (
    RotationBlockOut,
    RotationMemberOut,
    SlotRuleIn,
    SlotRuleOut,
    SlotRulesReplaceIn,
    WeeklyPinOut,
)

router = APIRouter()


def _get_or_404(ctx: RequestContext, slot_id: int) -> Slot:
    obj = ctx.db.get(Slot, slot_id)
    if not obj or obj.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Slot not found")
    return obj


def _default_rule_bitmap(slot: Slot) -> int:
    """Derive the default rule's days_bitmap from the slot's days_applied.

    Bit layout: 0=Mon, 1=Tue, ..., 5=Sat, 6=Sun.
    - all                 → 0b1111111 (127)
    - weekdays            → 0b0011111 (31, Mon-Fri)
    - weekends_holidays   → 0b1111111 (127): holidays can fall on any
                            weekday, so the rule bitmap must cover all
                            days; the slot itself filters to weekend ∪
                            holiday occurrences at solve time.
    - custom              → slot.custom_days_bitmap (fallback to all if empty)
    """
    da = slot.days_applied
    if da == "weekdays":
        return 0b0011111
    if da == "custom":
        return slot.custom_days_bitmap or 0b1111111
    return 0b1111111


def _validate_categories(ctx: RequestContext, ids: list[int]) -> None:
    if not ids:
        return
    found = ctx.db.query(Category.id).filter(Category.id.in_(ids)).all()
    found_ids = {row[0] for row in found}
    missing = [i for i in ids if i not in found_ids]
    if missing:
        raise HTTPException(
            status_code=422, detail=f"Unknown category_ids: {missing}"
        )


def _validate_skills(ctx: RequestContext, ids: list[int]) -> None:
    if not ids:
        return
    found = ctx.db.query(Skill.id).filter(Skill.id.in_(ids)).all()
    found_ids = {row[0] for row in found}
    missing = [i for i in ids if i not in found_ids]
    if missing:
        raise HTTPException(status_code=422, detail=f"Unknown skill_ids: {missing}")


def _serialize(ctx: RequestContext, slot: Slot) -> SlotOut:
    team_roles = (
        ctx.db.query(SlotTeamRole)
        .filter(SlotTeamRole.slot_id == slot.id)
        .order_by(SlotTeamRole.id)
        .all()
    )
    role_categories = (
        ctx.db.query(SlotTeamRoleCategory)
        .filter(
            SlotTeamRoleCategory.slot_team_role_id.in_([r.id for r in team_roles] or [0])
        )
        .all()
    )
    cats_by_role: dict[int, list[int]] = {}
    for rc in role_categories:
        cats_by_role.setdefault(rc.slot_team_role_id, []).append(rc.category_id)

    skills = (
        ctx.db.query(SlotSkillRequired)
        .filter(SlotSkillRequired.slot_id == slot.id)
        .order_by(SlotSkillRequired.id)
        .all()
    )

    rules = (
        ctx.db.query(SlotRule)
        .filter(SlotRule.slot_id == slot.id)
        .order_by(SlotRule.position, SlotRule.id)
        .all()
    )
    rule_ids = [r.id for r in rules] or [0]
    pins = (
        ctx.db.query(SlotRuleWeeklyPin)
        .filter(SlotRuleWeeklyPin.rule_id.in_(rule_ids))
        .order_by(SlotRuleWeeklyPin.weekday, SlotRuleWeeklyPin.id)
        .all()
    )
    blocks = (
        ctx.db.query(SlotRuleRotationBlock)
        .filter(SlotRuleRotationBlock.rule_id.in_(rule_ids))
        .order_by(SlotRuleRotationBlock.position, SlotRuleRotationBlock.id)
        .all()
    )
    members = (
        ctx.db.query(SlotRuleRotationMember)
        .filter(SlotRuleRotationMember.rule_id.in_(rule_ids))
        .order_by(SlotRuleRotationMember.position, SlotRuleRotationMember.id)
        .all()
    )
    pins_by_rule: dict[int, list[SlotRuleWeeklyPin]] = {}
    for p in pins:
        pins_by_rule.setdefault(p.rule_id, []).append(p)
    blocks_by_rule: dict[int, list[SlotRuleRotationBlock]] = {}
    for b in blocks:
        blocks_by_rule.setdefault(b.rule_id, []).append(b)
    members_by_rule: dict[int, list[SlotRuleRotationMember]] = {}
    for m in members:
        members_by_rule.setdefault(m.rule_id, []).append(m)

    rules_out = [
        SlotRuleOut(
            id=r.id,
            tenant_id=r.tenant_id,
            position=r.position,
            days_bitmap=r.days_bitmap,
            strategy=r.strategy,  # type: ignore[arg-type]
            anchor_date=r.anchor_date,
            weekly_pins=[
                WeeklyPinOut(id=p.id, weekday=p.weekday, person_id=p.person_id)
                for p in pins_by_rule.get(r.id, [])
            ],
            rotation_blocks=[
                RotationBlockOut(id=b.id, position=b.position, days_bitmap=b.days_bitmap)
                for b in blocks_by_rule.get(r.id, [])
            ],
            rotation_members=[
                RotationMemberOut(id=m.id, position=m.position, person_id=m.person_id)
                for m in members_by_rule.get(r.id, [])
            ],
        )
        for r in rules
    ]

    return SlotOut(
        id=slot.id,
        tenant_id=slot.tenant_id,
        department_id=slot.department_id,
        pool_id=slot.pool_id,
        name=slot.name,
        start_time=slot.start_time,
        end_time=slot.end_time,
        days_applied=slot.days_applied,  # type: ignore[arg-type]
        custom_days_bitmap=slot.custom_days_bitmap,
        staffing_mode=slot.staffing_mode,  # type: ignore[arg-type]
        headcount=slot.headcount,
        post_slot_rest=slot.post_slot_rest,
        counts_for_equity=slot.counts_for_equity,
        guardia_type=slot.guardia_type,
        equity_group_key=slot.equity_group_key,
        color=slot.color,
        crosses_midnight=slot.crosses_midnight,
        team_roles=[
            SlotTeamRoleOut(
                id=r.id,
                role_label=r.role_label,
                headcount=r.headcount,
                category_ids=sorted(cats_by_role.get(r.id, [])),
            )
            for r in team_roles
        ],
        skills_required=[
            SlotSkillRequiredOut(id=s.id, skill_id=s.skill_id, strength=s.strength)  # type: ignore[arg-type]
            for s in skills
        ],
        rules=rules_out,
        created_at=slot.created_at,
    )


def _replace_team_roles(
    ctx: RequestContext, slot: Slot, team_roles: list[SlotTeamRoleIn]
) -> None:
    # Delete existing roles (cascade clears categories).
    existing = ctx.db.query(SlotTeamRole).filter(SlotTeamRole.slot_id == slot.id).all()
    for r in existing:
        ctx.db.delete(r)
    ctx.db.flush()
    for tr in team_roles:
        _validate_categories(ctx, tr.category_ids)
        role = SlotTeamRole(
            tenant_id=ctx.tenant.id,
            slot_id=slot.id,
            role_label=tr.role_label,
            headcount=tr.headcount,
        )
        ctx.db.add(role)
        ctx.db.flush()
        for cid in tr.category_ids:
            ctx.db.add(
                SlotTeamRoleCategory(
                    tenant_id=ctx.tenant.id,
                    slot_team_role_id=role.id,
                    category_id=cid,
                )
            )
    ctx.db.flush()


def _replace_skills_required(
    ctx: RequestContext, slot: Slot, skills_required: list[SlotSkillRequiredIn]
) -> None:
    existing = (
        ctx.db.query(SlotSkillRequired)
        .filter(SlotSkillRequired.slot_id == slot.id)
        .all()
    )
    for s in existing:
        ctx.db.delete(s)
    ctx.db.flush()
    _validate_skills(ctx, [s.skill_id for s in skills_required])
    seen: set[int] = set()
    for sr in skills_required:
        if sr.skill_id in seen:
            raise HTTPException(
                status_code=422,
                detail=f"Duplicate skill_id in skills_required: {sr.skill_id}",
            )
        seen.add(sr.skill_id)
        ctx.db.add(
            SlotSkillRequired(
                tenant_id=ctx.tenant.id,
                slot_id=slot.id,
                skill_id=sr.skill_id,
                strength=sr.strength,
            )
        )
    ctx.db.flush()


@router.get("/slots", response_model=list[SlotOut])
def list_slots(ctx: RequestContext = Depends(get_current_context)) -> list[SlotOut]:
    rows = ctx.db.query(Slot).order_by(Slot.name).all()
    return [_serialize(ctx, r) for r in rows]


@router.post("/slots", response_model=SlotOut, status_code=status.HTTP_201_CREATED)
def create_slot(
    payload: SlotCreate, ctx: RequestContext = Depends(get_current_context)
) -> SlotOut:
    obj = Slot(
        tenant_id=ctx.tenant.id,
        name=payload.name,
        department_id=payload.department_id,
        pool_id=payload.pool_id,
        start_time=payload.start_time,
        end_time=payload.end_time,
        days_applied=payload.days_applied,
        custom_days_bitmap=payload.custom_days_bitmap,
        staffing_mode=payload.staffing_mode,
        headcount=payload.headcount,
        post_slot_rest=payload.post_slot_rest,
        counts_for_equity=payload.counts_for_equity,
        guardia_type=(payload.guardia_type or None),
        equity_group_key=(payload.equity_group_key or None),
        color=(payload.color or None),
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Slot name already exists")

    _replace_team_roles(ctx, obj, payload.team_roles)
    _replace_skills_required(ctx, obj, payload.skills_required)
    # Default rule: solver, position 0. The rule's days_bitmap is
    # derived from slot.days_applied so the admin doesn't have to
    # reconcile two day-scopes for a brand-new slot. Custom-day slots
    # use their custom_days_bitmap; "weekdays" / "weekends_holidays" /
    # "all" map to the obvious bitmaps.
    ctx.db.add(
        SlotRule(
            tenant_id=ctx.tenant.id,
            slot_id=obj.id,
            position=0,
            days_bitmap=_default_rule_bitmap(obj),
            strategy="solver",
            anchor_date=None,
        )
    )
    ctx.db.flush()
    ctx.db.refresh(obj)
    return _serialize(ctx, obj)


@router.get("/slots/{slot_id}", response_model=SlotOut)
def get_slot(slot_id: int, ctx: RequestContext = Depends(get_current_context)) -> SlotOut:
    return _serialize(ctx, _get_or_404(ctx, slot_id))


@router.put("/slots/{slot_id}", response_model=SlotOut)
def update_slot(
    slot_id: int, payload: SlotUpdate, ctx: RequestContext = Depends(get_current_context)
) -> SlotOut:
    obj = _get_or_404(ctx, slot_id)
    data = payload.model_dump(exclude_unset=True)
    team_roles = data.pop("team_roles", None)
    skills_required = data.pop("skills_required", None)
    if "guardia_type" in data:
        # Normalize empty string to None so the column reflects "not a guardia".
        gt = data["guardia_type"]
        data["guardia_type"] = gt or None
    if "equity_group_key" in data:
        eg = data["equity_group_key"]
        data["equity_group_key"] = eg or None
    if "color" in data:
        c = data["color"]
        data["color"] = c or None
    for k, v in data.items():
        setattr(obj, k, v)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Slot name already exists")

    if team_roles is not None:
        _replace_team_roles(
            ctx, obj, [SlotTeamRoleIn.model_validate(r) for r in team_roles]
        )
    if skills_required is not None:
        _replace_skills_required(
            ctx, obj, [SlotSkillRequiredIn.model_validate(s) for s in skills_required]
        )
    ctx.db.refresh(obj)
    return _serialize(ctx, obj)


@router.delete("/slots/{slot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_slot(slot_id: int, ctx: RequestContext = Depends(get_current_context)) -> None:
    obj = _get_or_404(ctx, slot_id)
    ctx.db.delete(obj)
    ctx.db.flush()


def _validate_rules_in_tenant_persons(
    ctx: RequestContext, person_ids: set[int]
) -> None:
    """Every person_id referenced in pins/members must be a member of this
    tenant — Person rows aren't tenant-scoped but Memberships are."""
    if not person_ids:
        return
    found = (
        ctx.db.query(Membership.person_id)
        .filter(Membership.person_id.in_(person_ids))
        .all()
    )
    found_ids = {row[0] for row in found}
    missing = [p for p in person_ids if p not in found_ids]
    if missing:
        raise HTTPException(
            status_code=400,
            detail=f"Personas no pertenecen a este equipo: {sorted(missing)}",
        )


def _validate_rules(rules: list[SlotRuleIn], slot_headcount: int = 1) -> None:
    if not rules:
        raise HTTPException(
            status_code=400, detail="Debe haber al menos una regla por turno"
        )
    seen_mask = 0
    for idx, r in enumerate(rules):
        if r.days_bitmap <= 0 or r.days_bitmap > 127:
            raise HTTPException(
                status_code=400,
                detail=f"Regla {idx + 1}: días inválidos (debe ser 1..127)",
            )
        if seen_mask & r.days_bitmap:
            raise HTTPException(
                status_code=400,
                detail=f"Regla {idx + 1}: solapa con otra regla en los mismos días",
            )
        seen_mask |= r.days_bitmap

        if r.strategy == "rotation":
            if r.anchor_date is None:
                raise HTTPException(
                    status_code=400,
                    detail=f"Regla {idx + 1}: la rotación necesita fecha ancla",
                )
            if not r.rotation_blocks:
                raise HTTPException(
                    status_code=400,
                    detail=f"Regla {idx + 1}: la rotación necesita al menos un bloque",
                )
            if not r.rotation_members:
                raise HTTPException(
                    status_code=400,
                    detail=f"Regla {idx + 1}: la rotación necesita al menos un miembro",
                )
            block_mask = 0
            for bidx, b in enumerate(r.rotation_blocks):
                if b.days_bitmap & ~r.days_bitmap:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Regla {idx + 1}, bloque {bidx + 1}: incluye días fuera"
                            " del bitmap de la regla"
                        ),
                    )
                if block_mask & b.days_bitmap:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Regla {idx + 1}, bloque {bidx + 1}: solapa con otro"
                            " bloque"
                        ),
                    )
                block_mask |= b.days_bitmap
            if block_mask != r.days_bitmap:
                raise HTTPException(
                    status_code=400,
                    detail=(
                        f"Regla {idx + 1}: los bloques deben cubrir exactamente"
                        " los días de la regla"
                    ),
                )
            # Per-position duplicate person check (DB also enforces via
            # UNIQUE(rule_id, position, person_id), but we error here with
            # a friendlier Spanish message).
            seen_pos_person: set[tuple[int, int]] = set()
            members_per_position: dict[int, int] = {}
            for m in r.rotation_members:
                key = (m.position, m.person_id)
                if key in seen_pos_person:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Regla {idx + 1}: persona duplicada en la"
                            f" posición {m.position}"
                        ),
                    )
                seen_pos_person.add(key)
                members_per_position[m.position] = (
                    members_per_position.get(m.position, 0) + 1
                )
            # A position can hold at most `slot.headcount` persons. For
            # single slots that's 1, so each position is exactly one
            # person and the rotation cycles them across days.
            for pos, n in members_per_position.items():
                if n > slot_headcount:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Regla {idx + 1}, posición {pos}: tiene"
                            f" {n} personas pero el turno solo permite"
                            f" {slot_headcount}. Crea más posiciones para"
                            " que la rotación recorra a más personas."
                        ),
                    )
            # A person can appear in only one position of the rotation.
            # (Migration 0015 keeps UNIQUE(rule_id, person_id) for this.)
            persons = [m.person_id for m in r.rotation_members]
            if len(set(persons)) != len(persons):
                raise HTTPException(
                    status_code=400,
                    detail=f"Regla {idx + 1}: una persona aparece en dos posiciones de la rotación",
                )
        elif r.strategy == "fixed_weekly":
            seen_pin: set[tuple[int, int]] = set()
            pins_per_weekday: dict[int, int] = {}
            for pidx, p in enumerate(r.weekly_pins):
                pins_per_weekday[p.weekday] = (
                    pins_per_weekday.get(p.weekday, 0) + 1
                )
                if not (r.days_bitmap & (1 << p.weekday)):
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Regla {idx + 1}, pin {pidx + 1}: el día"
                            f" {p.weekday} no está en la regla"
                        ),
                    )
                key = (p.weekday, p.person_id)
                if key in seen_pin:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Regla {idx + 1}: pin duplicado para weekday="
                            f"{p.weekday}, person_id={p.person_id}"
                        ),
                    )
                seen_pin.add(key)
            # A weekday can hold at most `slot.headcount` pins. For a
            # 1-person turno that's 1 person per weekday. To pin
            # different people on different weekdays, use one pin per
            # (weekday, person). Headcount stays the cap on parallel
            # plazas, not on alternatives.
            for wd, n in pins_per_weekday.items():
                if n > slot_headcount:
                    raise HTTPException(
                        status_code=400,
                        detail=(
                            f"Regla {idx + 1}, día {wd}: tiene {n}"
                            f" personas pero el turno solo permite"
                            f" {slot_headcount}."
                        ),
                    )


@router.put("/slots/{slot_id}/rules", response_model=SlotOut)
def replace_slot_rules(
    slot_id: int,
    payload: SlotRulesReplaceIn,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotOut:
    obj = _get_or_404(ctx, slot_id)
    rules = payload.rules
    _validate_rules(rules, slot_headcount=max(1, obj.headcount))

    # Validate person_ids belong to this tenant via Membership.
    person_ids: set[int] = set()
    for r in rules:
        for p in r.weekly_pins:
            person_ids.add(p.person_id)
        for m in r.rotation_members:
            person_ids.add(m.person_id)
    _validate_rules_in_tenant_persons(ctx, person_ids)

    # Atomic replace: delete existing rules (cascade drops children).
    existing = ctx.db.query(SlotRule).filter(SlotRule.slot_id == obj.id).all()
    for r in existing:
        ctx.db.delete(r)
    ctx.db.flush()

    for pos, r in enumerate(rules):
        rule = SlotRule(
            tenant_id=ctx.tenant.id,
            slot_id=obj.id,
            position=pos,
            days_bitmap=r.days_bitmap,
            strategy=r.strategy,
            anchor_date=r.anchor_date if r.strategy == "rotation" else None,
        )
        ctx.db.add(rule)
        ctx.db.flush()
        if r.strategy == "fixed_weekly":
            for p in r.weekly_pins:
                ctx.db.add(
                    SlotRuleWeeklyPin(
                        tenant_id=ctx.tenant.id,
                        rule_id=rule.id,
                        weekday=p.weekday,
                        person_id=p.person_id,
                    )
                )
        elif r.strategy == "rotation":
            for b in r.rotation_blocks:
                ctx.db.add(
                    SlotRuleRotationBlock(
                        tenant_id=ctx.tenant.id,
                        rule_id=rule.id,
                        position=b.position,
                        days_bitmap=b.days_bitmap,
                    )
                )
            for m in r.rotation_members:
                ctx.db.add(
                    SlotRuleRotationMember(
                        tenant_id=ctx.tenant.id,
                        rule_id=rule.id,
                        position=m.position,
                        person_id=m.person_id,
                    )
                )
    ctx.db.flush()
    ctx.db.refresh(obj)
    return _serialize(ctx, obj)
