"""Per-tenant incident log CRUD.

Admin-only. The list endpoint returns rows sorted by `occurred_at`
descending (most recent first), with the author's name joined from
the membership/person tables for display.
"""

from fastapi import APIRouter, Depends, HTTPException, status

from app.models import Incident, Membership, Person
from app.routes.deps import RequestContext, get_current_context
from app.schemas.incident import IncidentCreate, IncidentOut, IncidentUpdate

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _serialize(inc: Incident, author_name: str | None) -> IncidentOut:
    return IncidentOut(
        id=inc.id,
        tenant_id=inc.tenant_id,
        occurred_at=inc.occurred_at,
        title=inc.title,
        body=inc.body,
        created_by_name=author_name,
        created_at=inc.created_at,
        updated_at=inc.updated_at,
    )


def _author_name(ctx: RequestContext, membership_id: int | None) -> str | None:
    """Look up the display name of the admin who wrote an incident.
    Returns None if the membership was deleted (SET NULL on FK)."""
    if membership_id is None:
        return None
    row = (
        ctx.db.query(Person.name)
        .join(Membership, Membership.person_id == Person.id)
        .filter(Membership.id == membership_id)
        .first()
    )
    return row[0] if row else None


def _get_or_404(ctx: RequestContext, incident_id: int) -> Incident:
    inc = ctx.db.get(Incident, incident_id)
    if not inc or inc.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Incident not found")
    return inc


@router.get("/incidents", response_model=list[IncidentOut])
def list_incidents(
    ctx: RequestContext = Depends(get_current_context),
) -> list[IncidentOut]:
    _require_admin(ctx)
    rows = (
        ctx.db.query(Incident)
        .order_by(Incident.occurred_at.desc(), Incident.id.desc())
        .all()
    )
    # Batch-load author names to avoid N+1.
    membership_ids = {r.created_by_membership_id for r in rows if r.created_by_membership_id}
    authors: dict[int, str] = {}
    if membership_ids:
        for mid, name in (
            ctx.db.query(Membership.id, Person.name)
            .join(Person, Person.id == Membership.person_id)
            .filter(Membership.id.in_(membership_ids))
            .all()
        ):
            authors[mid] = name
    return [
        _serialize(r, authors.get(r.created_by_membership_id) if r.created_by_membership_id else None)
        for r in rows
    ]


@router.post(
    "/incidents",
    response_model=IncidentOut,
    status_code=status.HTTP_201_CREATED,
)
def create_incident(
    payload: IncidentCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> IncidentOut:
    _require_admin(ctx)
    inc = Incident(
        tenant_id=ctx.tenant.id,
        occurred_at=payload.occurred_at,
        title=payload.title.strip(),
        body=(payload.body.strip() if payload.body else None) or None,
        created_by_membership_id=ctx.membership.id,
    )
    ctx.db.add(inc)
    ctx.db.flush()
    return _serialize(inc, _author_name(ctx, inc.created_by_membership_id))


@router.put("/incidents/{incident_id}", response_model=IncidentOut)
def update_incident(
    incident_id: int,
    payload: IncidentUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> IncidentOut:
    _require_admin(ctx)
    inc = _get_or_404(ctx, incident_id)
    data = payload.model_dump(exclude_unset=True)
    if "title" in data and data["title"] is not None:
        data["title"] = data["title"].strip()
    if "body" in data:
        # Empty string → null for cleaner storage.
        b = data["body"]
        data["body"] = (b.strip() if b else None) or None
    for k, v in data.items():
        setattr(inc, k, v)
    ctx.db.flush()
    return _serialize(inc, _author_name(ctx, inc.created_by_membership_id))


@router.delete(
    "/incidents/{incident_id}", status_code=status.HTTP_204_NO_CONTENT
)
def delete_incident(
    incident_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    inc = _get_or_404(ctx, incident_id)
    ctx.db.delete(inc)
    ctx.db.flush()
