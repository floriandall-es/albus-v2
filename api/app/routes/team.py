from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException

from app.models import Category, Membership, Person
from app.routes.deps import RequestContext, get_current_context
from app.schemas.team import TeamMemberOut, TeamMemberUpdate

router = APIRouter()


def _serialize(m: Membership, person: Person, category: Category | None) -> TeamMemberOut:
    return TeamMemberOut(
        id=m.id,
        tenant_id=m.tenant_id,
        person_id=m.person_id,
        person_name=person.name,
        person_email=person.email,
        person_locale=person.locale,
        person_avatar_url=person.avatar_url,
        roles=list(m.roles),
        category_id=m.category_id,
        category_name=category.name if category else None,
        fte_pct=m.fte_pct,
        disabled_at=m.disabled_at,
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
    # `disabled` is a bool flag in the API; the column it controls
    # is a timestamp. Translate before the generic setattr loop so
    # we don't try to assign a bool to disabled_at directly.
    disabled = data.pop("disabled", None)
    if data.get("category_id") is not None:
        cat = ctx.db.get(Category, data["category_id"])
        if not cat or cat.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=422, detail="Unknown category_id")
    for k, v in data.items():
        setattr(m, k, v)
    if disabled is not None:
        if disabled and m.disabled_at is None:
            # Stamp the moment we paused — useful later for "disabled
            # since X" UI hints and any cleanup batch jobs.
            m.disabled_at = datetime.now(timezone.utc)
        elif not disabled:
            m.disabled_at = None
    ctx.db.flush()
    person = ctx.db.get(Person, m.person_id)
    cat = ctx.db.get(Category, m.category_id) if m.category_id else None
    assert person is not None
    return _serialize(m, person, cat)


# NOTE: POST /api/team/invite was moved to app.routes.invitations in Sprint 3
# and now creates a token-based Invitation rather than a Person directly.
