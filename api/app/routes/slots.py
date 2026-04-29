from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.models import (
    Category,
    Skill,
    Slot,
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

router = APIRouter()


def _get_or_404(ctx: RequestContext, slot_id: int) -> Slot:
    obj = ctx.db.get(Slot, slot_id)
    if not obj or obj.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Slot not found")
    return obj


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
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Slot name already exists")

    _replace_team_roles(ctx, obj, payload.team_roles)
    _replace_skills_required(ctx, obj, payload.skills_required)
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
