from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.models import Skill
from app.routes.deps import RequestContext, get_current_context
from app.schemas.skill import SkillCreate, SkillOut, SkillUpdate

router = APIRouter()


def _get_or_404(ctx: RequestContext, skill_id: int) -> Skill:
    obj = ctx.db.get(Skill, skill_id)
    if not obj or obj.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Skill not found")
    return obj


@router.get("/skills", response_model=list[SkillOut])
def list_skills(ctx: RequestContext = Depends(get_current_context)) -> list[SkillOut]:
    rows = ctx.db.query(Skill).order_by(Skill.name).all()
    return [SkillOut.model_validate(r) for r in rows]


@router.post("/skills", response_model=SkillOut, status_code=status.HTTP_201_CREATED)
def create_skill(
    payload: SkillCreate, ctx: RequestContext = Depends(get_current_context)
) -> SkillOut:
    obj = Skill(
        tenant_id=ctx.tenant.id, name=payload.name, description=payload.description
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Skill name already exists")
    ctx.db.refresh(obj)
    return SkillOut.model_validate(obj)


@router.get("/skills/{skill_id}", response_model=SkillOut)
def get_skill(skill_id: int, ctx: RequestContext = Depends(get_current_context)) -> SkillOut:
    return SkillOut.model_validate(_get_or_404(ctx, skill_id))


@router.put("/skills/{skill_id}", response_model=SkillOut)
def update_skill(
    skill_id: int,
    payload: SkillUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> SkillOut:
    obj = _get_or_404(ctx, skill_id)
    data = payload.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(obj, k, v)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Skill name already exists")
    ctx.db.refresh(obj)
    return SkillOut.model_validate(obj)


@router.delete("/skills/{skill_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_skill(skill_id: int, ctx: RequestContext = Depends(get_current_context)) -> None:
    obj = _get_or_404(ctx, skill_id)
    ctx.db.delete(obj)
    ctx.db.flush()
