from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError

from app.core.security import hash_password, verify_password
from app.models import (
    Category,
    Department,
    Membership,
    Person,
    Pool,
    RoleType,
    Skill,
    Slot,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import (
    EmailChangeRequest,
    MeResponse,
    PasswordChangeRequest,
    PersonOut,
    ProfileUpdateRequest,
    TenantSummaryCounts,
)

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


# ---------------------------------------------------------------------------
# Profile self-management. All three endpoints act on ctx.person — the
# logged-in user — and don't require any specific role.
# ---------------------------------------------------------------------------


@router.put("/me/profile", response_model=PersonOut)
def update_profile(
    payload: ProfileUpdateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> Person:
    ctx.person.name = payload.name.strip()
    ctx.db.flush()
    return ctx.person


@router.post("/me/password", status_code=status.HTTP_204_NO_CONTENT)
def change_password(
    payload: PasswordChangeRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    if not verify_password(payload.current_password, ctx.person.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Contraseña actual incorrecta",
        )
    if payload.new_password == payload.current_password:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="La contraseña nueva debe ser distinta",
        )
    ctx.person.hashed_password = hash_password(payload.new_password)
    ctx.db.flush()


@router.post("/me/email", response_model=PersonOut)
def change_email(
    payload: EmailChangeRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> Person:
    if not verify_password(payload.current_password, ctx.person.hashed_password):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Contraseña actual incorrecta",
        )
    new_email = payload.new_email.strip().lower()
    if new_email == ctx.person.email:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="El email nuevo es igual al actual",
        )
    ctx.person.email = new_email
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Ya existe una cuenta con ese email",
        )
    return ctx.person
