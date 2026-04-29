from fastapi import APIRouter, Depends
from sqlalchemy import func

from app.models import (
    Category,
    Department,
    Membership,
    Pool,
    RoleType,
    Skill,
    Slot,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import MeResponse, TenantSummaryCounts

router = APIRouter()


@router.get("/me", response_model=MeResponse)
def me(ctx: RequestContext = Depends(get_current_context)) -> MeResponse:
    db = ctx.db
    # These queries flow through RLS — they will only return rows for the
    # tenant_id set via SET LOCAL app.tenant_id in the deps. If RLS is missing
    # or the SET wasn't applied, this endpoint would over-return; the
    # tenant-isolation tests assert the opposite.
    memberships = db.query(Membership).filter(Membership.person_id == ctx.person.id).all()
    role_types = db.query(RoleType).all()
    departments = db.query(Department).all()

    counts = TenantSummaryCounts(
        categories=int(db.query(func.count(Category.id)).scalar() or 0),
        pools=int(db.query(func.count(Pool.id)).scalar() or 0),
        skills=int(db.query(func.count(Skill.id)).scalar() or 0),
        slots=int(db.query(func.count(Slot.id)).scalar() or 0),
    )

    return MeResponse(
        person=ctx.person,  # type: ignore[arg-type]
        current_tenant=ctx.tenant,  # type: ignore[arg-type]
        memberships=memberships,  # type: ignore[arg-type]
        role_types=role_types,  # type: ignore[arg-type]
        departments=departments,  # type: ignore[arg-type]
        counts=counts,
    )
