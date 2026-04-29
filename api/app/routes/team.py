import secrets

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.core.security import hash_password
from app.models import Category, Membership, Person
from app.routes.deps import RequestContext, get_current_context
from app.schemas.auth import MembershipOut
from app.schemas.team import (
    TeamInviteRequest,
    TeamInviteResponse,
    TeamMemberOut,
    TeamMemberUpdate,
)

router = APIRouter()


def _serialize(m: Membership, person: Person, category: Category | None) -> TeamMemberOut:
    return TeamMemberOut(
        id=m.id,
        tenant_id=m.tenant_id,
        person_id=m.person_id,
        person_name=person.name,
        person_email=person.email,
        person_locale=person.locale,
        roles=list(m.roles),
        category_id=m.category_id,
        category_name=category.name if category else None,
        fte_pct=m.fte_pct,
        does_guardias=m.does_guardias,
        guardia_types=list(m.guardia_types),
        exemption_type=m.exemption_type,
        exemption_until=m.exemption_until,
        created_at=m.created_at,
    )


@router.get("/team", response_model=list[TeamMemberOut])
def list_team(ctx: RequestContext = Depends(get_current_context)) -> list[TeamMemberOut]:
    rows = (
        ctx.db.query(Membership, Person, Category)
        .join(Person, Person.id == Membership.person_id)
        .outerjoin(Category, Category.id == Membership.category_id)
        .order_by(Person.name)
        .all()
    )
    return [_serialize(m, p, c) for m, p, c in rows]


def _get_member_or_404(ctx: RequestContext, membership_id: int) -> Membership:
    m = ctx.db.get(Membership, membership_id)
    if not m or m.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Membership not found")
    return m


@router.put("/team/{membership_id}", response_model=TeamMemberOut)
def update_team_member(
    membership_id: int,
    payload: TeamMemberUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> TeamMemberOut:
    m = _get_member_or_404(ctx, membership_id)
    data = payload.model_dump(exclude_unset=True)
    clear_exemption = data.pop("clear_exemption", False)
    if data.get("category_id") is not None:
        cat = ctx.db.get(Category, data["category_id"])
        if not cat or cat.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=422, detail="Unknown category_id")
    for k, v in data.items():
        setattr(m, k, v)
    if clear_exemption:
        m.exemption_type = None
        m.exemption_until = None
    ctx.db.flush()
    person = ctx.db.get(Person, m.person_id)
    cat = ctx.db.get(Category, m.category_id) if m.category_id else None
    assert person is not None
    return _serialize(m, person, cat)


@router.post(
    "/team/invite", response_model=TeamInviteResponse, status_code=status.HTTP_201_CREATED
)
def invite_team_member(
    payload: TeamInviteRequest, ctx: RequestContext = Depends(get_current_context)
) -> TeamInviteResponse:
    if payload.category_id is not None:
        cat = ctx.db.get(Category, payload.category_id)
        if not cat or cat.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=422, detail="Unknown category_id")

    email = payload.email.lower()
    person = ctx.db.query(Person).filter(Person.email == email).first()
    created_person = False
    if not person:
        # No invite email is sent in this sprint — set an unusable random
        # password. The admin will reset it for the user out-of-band, or a
        # later sprint adds a self-serve reset flow.
        random_pw = secrets.token_urlsafe(32)
        person = Person(
            email=email,
            hashed_password=hash_password(random_pw),
            name=payload.person_name,
        )
        ctx.db.add(person)
        ctx.db.flush()
        created_person = True

    existing = (
        ctx.db.query(Membership)
        .filter(
            Membership.tenant_id == ctx.tenant.id, Membership.person_id == person.id
        )
        .first()
    )
    if existing:
        raise HTTPException(
            status_code=409, detail="Person is already a member of this tenant"
        )

    m = Membership(
        tenant_id=ctx.tenant.id,
        person_id=person.id,
        roles=payload.roles,
        category_id=payload.category_id,
        fte_pct=payload.fte_pct,
        does_guardias=payload.does_guardias,
        guardia_types=payload.guardia_types,
    )
    ctx.db.add(m)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Conflict creating membership")
    ctx.db.refresh(m)
    return TeamInviteResponse(
        membership=MembershipOut.model_validate(m),
        person_id=person.id,
        email=person.email,
        created_person=created_person,
    )
