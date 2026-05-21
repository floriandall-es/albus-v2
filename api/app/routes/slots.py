import sqlalchemy as sa
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy.exc import IntegrityError

from app.models import (
    Category,
    Membership,
    Person,
    Slot,
    SlotAllowedPerson,
    SlotRule,
    SlotRuleRotationBlock,
    SlotRuleRotationMember,
    SlotRuleWeeklyPin,
    SlotTeamRole,
    SlotTeamRoleCategory,
)
from app.routes.deps import RequestContext, get_current_context
from app.routes.scope import caller_scope
from app.schemas.slot import (
    SlotCreate,
    SlotOut,
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


def _validate_allowed_persons(ctx: RequestContext, ids: list[int]) -> None:
    """Every person_id in the allow-list must currently be a member
    of THIS tenant. Person rows aren't tenant-scoped but Memberships
    are; checking membership is the right tenant boundary."""
    if not ids:
        return
    found = (
        ctx.db.query(Membership.person_id)
        .filter(Membership.person_id.in_(ids), Membership.tenant_id == ctx.tenant.id)
        .all()
    )
    found_ids = {row[0] for row in found}
    missing = [i for i in ids if i not in found_ids]
    if missing:
        raise HTTPException(
            status_code=422,
            detail=f"Personas no pertenecen a este equipo: {sorted(missing)}",
        )


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

    allowed_rows = (
        ctx.db.query(SlotAllowedPerson)
        .filter(SlotAllowedPerson.slot_id == slot.id)
        .order_by(SlotAllowedPerson.id)
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
            weeks_per_position=r.weeks_per_position,
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
        group_id=slot.group_id,
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
        color=slot.color,
        position=slot.position,
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
        allowed_person_ids=sorted({a.person_id for a in allowed_rows}),
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


def _replace_allowed_persons(
    ctx: RequestContext, slot: Slot, person_ids: list[int]
) -> None:
    """Atomically replace the slot's allow-list. Empty list = clear
    (= "Todo el equipo" / no restriction). Caller pre-validates that
    the person ids belong to this tenant.

    Cascade: anyone being removed from the allow-list also loses
    any weekly_pin / rotation_member references they had in this
    slot's rules. The frontend should surface those conflicts via
    a confirm dialog before getting here so this isn't a silent
    delete from the admin's point of view.
    """
    from app.services.slot_rules import cascade_remove_persons_from_slot_rules

    existing = (
        ctx.db.query(SlotAllowedPerson)
        .filter(SlotAllowedPerson.slot_id == slot.id)
        .all()
    )
    previous_ids = {r.person_id for r in existing}
    new_ids = set(person_ids)

    # Edge case: clearing the allow-list (empty payload) unlocks
    # the slot to "Todo el equipo". Existing pins/rotation_members
    # stay valid — anyone in the tenant is now eligible. So only
    # cascade when we're transitioning from one restricted state
    # to another (or restricted → still restricted) AND the new
    # state actually drops people.
    if new_ids:
        removed = previous_ids - new_ids
        if removed:
            cascade_remove_persons_from_slot_rules(ctx.db, slot.id, removed)

    for row in existing:
        ctx.db.delete(row)
    ctx.db.flush()
    _validate_allowed_persons(ctx, person_ids)
    # De-dupe input — the unique constraint enforces this at DB level
    # but we'd rather return a clean 422 than catch IntegrityError.
    for pid in dict.fromkeys(person_ids):
        ctx.db.add(
            SlotAllowedPerson(
                tenant_id=ctx.tenant.id,
                slot_id=slot.id,
                person_id=pid,
            )
        )
    ctx.db.flush()


@router.get("/slots", response_model=list[SlotOut])
def list_slots(
    ctx: RequestContext = Depends(get_current_context),
    main_team_only: bool = False,
) -> list[SlotOut]:
    # Admin-controlled order (sprint 17): position is the primary
    # sort key, with name + id as deterministic tiebreakers in the
    # (rare) case two slots end up with the same position.
    #
    # Scope filtering:
    #   - Group lead: only slots owned by their group (forced;
    #     they can't even see main-team slots via this endpoint).
    #   - Tenant admin + plain members: all slots by default,
    #     UNLESS the caller passes ?main_team_only=true, which
    #     restricts to slots with group_id IS NULL. /admin/slots
    #     uses this so sub-equipo slots don't appear in the
    #     admin's main actividades list — sub-equipos are the
    #     lead's responsibility, the admin manages them through
    #     /admin/groups/[id] (still TODO at time of writing).
    scope = caller_scope(ctx)
    q = ctx.db.query(Slot).order_by(Slot.position, Slot.name, Slot.id)
    if scope.is_group_lead:
        q = q.filter(Slot.group_id == scope.group_id)
    elif main_team_only:
        q = q.filter(Slot.group_id.is_(None))
    return [_serialize(ctx, r) for r in q.all()]


@router.post("/slots", response_model=SlotOut, status_code=status.HTTP_201_CREATED)
def create_slot(
    payload: SlotCreate, ctx: RequestContext = Depends(get_current_context)
) -> SlotOut:
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(status_code=403, detail="Permisos insuficientes.")
    # Group lead: new slots are auto-tagged with their group. We
    # ignore any incoming group_id from the payload (could be a
    # malicious or stale value); a lead can't create slots outside
    # their group.
    group_id = payload.group_id
    if scope.is_group_lead:
        group_id = scope.group_id
    elif group_id is not None:
        # Tenant admin specifying a group → validate it exists.
        g = ctx.db.get(Group, group_id)
        if not g or g.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=422, detail="Unknown group_id")
    # Sprint 17: new slots land at the end of the admin's ordering.
    # `max(position) + 1`; if there are no slots yet, position = 0.
    max_pos = ctx.db.query(sa.func.max(Slot.position)).scalar()
    next_pos = (max_pos + 1) if max_pos is not None else 0
    obj = Slot(
        tenant_id=ctx.tenant.id,
        name=payload.name,
        department_id=payload.department_id,
        group_id=group_id,
        start_time=payload.start_time,
        end_time=payload.end_time,
        days_applied=payload.days_applied,
        custom_days_bitmap=payload.custom_days_bitmap,
        staffing_mode=payload.staffing_mode,
        headcount=payload.headcount,
        post_slot_rest=payload.post_slot_rest,
        counts_for_equity=payload.counts_for_equity,
        guardia_type=(payload.guardia_type or None),
        color=(payload.color or None),
        position=next_pos,
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Slot name already exists")

    _replace_team_roles(ctx, obj, payload.team_roles)
    _replace_allowed_persons(ctx, obj, payload.allowed_person_ids)
    # Default rule strategy depends on whether this is a main-team
    # or group-owned slot: group slots are manual-only by policy
    # (see scheduler skip + UI hide), main-team slots default to
    # the solver as before.
    default_strategy = "manual" if obj.group_id is not None else "solver"
    ctx.db.add(
        SlotRule(
            tenant_id=ctx.tenant.id,
            slot_id=obj.id,
            position=0,
            days_bitmap=_default_rule_bitmap(obj),
            strategy=default_strategy,
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
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(status_code=403, detail="Permisos insuficientes.")
    obj = _get_or_404(ctx, slot_id)
    if scope.is_group_lead and obj.group_id != scope.group_id:
        raise HTTPException(
            status_code=403,
            detail="No puedes editar actividades fuera de tu sub-equipo.",
        )
    data = payload.model_dump(exclude_unset=True)
    team_roles = data.pop("team_roles", None)
    allowed_person_ids = data.pop("allowed_person_ids", None)
    # group_id reassignment: tenant admin only. Group leads cannot
    # move slots between groups (they could otherwise hide a slot
    # from the tenant admin's view).
    if "group_id" in data:
        if scope.is_group_lead:
            raise HTTPException(
                status_code=403,
                detail="Solo el administrador puede cambiar el sub-equipo de una actividad.",
            )
        gid = data["group_id"]
        if gid is not None:
            g = ctx.db.get(Group, gid)
            if not g or g.tenant_id != ctx.tenant.id:
                raise HTTPException(status_code=422, detail="Unknown group_id")
    if "guardia_type" in data:
        # Normalize empty string to None so the column reflects "not a guardia".
        gt = data["guardia_type"]
        data["guardia_type"] = gt or None
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
    if allowed_person_ids is not None:
        _replace_allowed_persons(ctx, obj, list(allowed_person_ids))
    ctx.db.refresh(obj)
    return _serialize(ctx, obj)


@router.delete("/slots/{slot_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_slot(slot_id: int, ctx: RequestContext = Depends(get_current_context)) -> None:
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(status_code=403, detail="Permisos insuficientes.")
    obj = _get_or_404(ctx, slot_id)
    if scope.is_group_lead and obj.group_id != scope.group_id:
        raise HTTPException(
            status_code=403,
            detail="No puedes eliminar actividades fuera de tu sub-equipo.",
        )
    ctx.db.delete(obj)
    ctx.db.flush()


class _SlotMovePayload(BaseModel):
    direction: str  # "up" or "down"


@router.post("/slots/{slot_id}/move", response_model=list[SlotOut])
def move_slot(
    slot_id: int,
    payload: _SlotMovePayload,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SlotOut]:
    """Swap a slot's position with its neighbor above ("up") or below
    ("down"). At a boundary it's a no-op (returns the unchanged list).
    Returns the full reordered slot list so the client can replace its
    cache atomically without a follow-up GET."""
    target = _get_or_404(ctx, slot_id)
    if payload.direction not in ("up", "down"):
        raise HTTPException(
            status_code=422, detail="direction debe ser 'up' o 'down'"
        )
    # Self-heal duplicate positions across the WHOLE tenant. The
    # Sprint 17 reorder design assumes every Slot has a unique
    # `position` value — swapping two integers is a no-op when
    # they already match. Bulk imports (the legacy CSV migration
    # on the alpha customer ran main-team slots 0..5 AND
    # sub-equipo slots 0..6 in separate enumerations, producing
    # 4 pairs of slots sharing position numbers) can produce ties
    # that silently break the up/down arrows. Renumber to 0..N-1
    # along the current sort order so subsequent swaps always
    # have a real effect.
    all_slots = (
        ctx.db.query(Slot)
        .order_by(Slot.position, Slot.name, Slot.id)
        .all()
    )
    seen: set[int] = set()
    has_duplicates = False
    for s in all_slots:
        if s.position in seen:
            has_duplicates = True
            break
        seen.add(s.position)
    if has_duplicates:
        for i, s in enumerate(all_slots):
            s.position = i
        ctx.db.flush()
    # Neighbor search is SCOPED to slots in the same `group_id` as
    # the target. Main-team slots (group_id IS NULL) only swap
    # with other main-team slots; sub-equipo slots only swap with
    # siblings in the same group. Without this, an admin clicking
    # ↑ on a main-team slot could end up swapping with an
    # invisible sub-equipo slot (the admin UI hides sub-equipo
    # slots since their lead owns them), making the click look
    # like a no-op even after the duplicate-position self-heal.
    same_scope = [s for s in all_slots if s.group_id == target.group_id]
    idx = next(
        (i for i, s in enumerate(same_scope) if s.id == target.id), -1
    )
    if idx == -1:
        raise HTTPException(status_code=404, detail="Slot not found")
    if payload.direction == "up" and idx == 0:
        return [_serialize(ctx, s) for s in all_slots]
    if payload.direction == "down" and idx == len(same_scope) - 1:
        return [_serialize(ctx, s) for s in all_slots]
    neighbor = same_scope[idx - 1 if payload.direction == "up" else idx + 1]
    target.position, neighbor.position = neighbor.position, target.position
    ctx.db.flush()
    new_order = (
        ctx.db.query(Slot)
        .order_by(Slot.position, Slot.name, Slot.id)
        .all()
    )
    return [_serialize(ctx, s) for s in new_order]


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


def _validate_rules_against_allowlist(
    ctx: RequestContext, slot: Slot, person_ids: set[int]
) -> None:
    """If the slot is restricted, every person referenced in
    pins/rotation_members must also be in the slot's allow-list.
    Saves admins from creating "Pedro pinned to Tuesday on a
    restricted slot Pedro can't actually do" mismatches that the
    solver would silently drop.

    Unrestricted slots (no rows in slot_allowed_persons) accept
    any tenant member — every member is implicitly eligible.
    """
    if not person_ids:
        return
    allowed = {
        row[0]
        for row in ctx.db.query(SlotAllowedPerson.person_id)
        .filter(SlotAllowedPerson.slot_id == slot.id)
        .all()
    }
    if not allowed:
        return
    missing_ids = person_ids - allowed
    if not missing_ids:
        return
    # Look up names for a friendly error.
    rows = ctx.db.query(Person.name).filter(Person.id.in_(missing_ids)).all()
    names = ", ".join(r[0] for r in rows) or f"#{sorted(missing_ids)}"
    raise HTTPException(
        status_code=422,
        detail=(
            f"Personas no autorizadas en este turno: {names}. "
            "Añádelas primero al equipo autorizado de la actividad."
        ),
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
            # Pins per weekday are intentionally NOT capped at
            # slot.headcount for fixed_weekly. The strategy means
            # "admin knows who's on duty that day" — including the
            # case where one weekday genuinely has more people than
            # the slot's default headcount (e.g. a 1-person Consulta
            # with 6 people across 5 weekdays, so one day doubles
            # up). The scheduler emits one assignment per pin and
            # the planning grid renders them stacked. Other
            # strategies (solver, rotation) still respect headcount
            # via their own validation paths above.


@router.put("/slots/{slot_id}/rules", response_model=SlotOut)
def replace_slot_rules(
    slot_id: int,
    payload: SlotRulesReplaceIn,
    ctx: RequestContext = Depends(get_current_context),
) -> SlotOut:
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(status_code=403, detail="Permisos insuficientes.")
    obj = _get_or_404(ctx, slot_id)
    if scope.is_group_lead and obj.group_id != scope.group_id:
        raise HTTPException(
            status_code=403,
            detail="No puedes editar reglas de actividades fuera de tu sub-equipo.",
        )
    rules = payload.rules
    _validate_rules(rules, slot_headcount=max(1, obj.headcount))

    # Group-owned slots are manual-only. Forbidden rule strategies
    # here (rotation / fixed_weekly / solver) would conflict with
    # the design: sub-team leads manage their schedules by hand.
    if obj.group_id is not None:
        non_manual = [r.strategy for r in rules if r.strategy != "manual"]
        if non_manual:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Las actividades de un sub-equipo solo admiten "
                    "asignación manual. Cambia las reglas a 'Manual' "
                    "antes de guardar."
                ),
            )

    # Validate person_ids belong to this tenant via Membership.
    person_ids: set[int] = set()
    for r in rules:
        for p in r.weekly_pins:
            person_ids.add(p.person_id)
        for m in r.rotation_members:
            person_ids.add(m.person_id)
    _validate_rules_in_tenant_persons(ctx, person_ids)
    _validate_rules_against_allowlist(ctx, obj, person_ids)

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
            # weeks_per_position only matters for rotation; other
            # strategies store the default 1 (harmless, ignored).
            weeks_per_position=(
                r.weeks_per_position if r.strategy == "rotation" else 1
            ),
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
