"""Tenant-admin CRUD for sub-team groups.

A group has a name and one designated lead (a Membership). The
lead becomes a group-scoped admin: they manage that group's
members and slots only.

Member assignment to a group happens via PUT /api/groups/{id}/members
with the full desired membership list (idempotent set semantics).
Members removed from the list go to "main team" (group_id=NULL);
members in the list that were elsewhere are moved here. Members
not mentioned stay untouched.
"""

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.models import Group, Membership, Person, Slot
from app.routes.deps import RequestContext, get_current_context
from app.schemas.group import (
    GroupCreate,
    GroupMembersUpdate,
    GroupOut,
    GroupUpdate,
)

router = APIRouter()


def _require_tenant_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo el administrador puede gestionar sub-equipos.",
        )


def _serialize(
    ctx: RequestContext,
    g: Group,
    *,
    lead_name: str | None = None,
    member_count: int | None = None,
    slot_count: int | None = None,
) -> GroupOut:
    if lead_name is None and g.lead_membership_id is not None:
        row = (
            ctx.db.query(Person.name)
            .join(Membership, Membership.person_id == Person.id)
            .filter(Membership.id == g.lead_membership_id)
            .first()
        )
        lead_name = row[0] if row else None
    if member_count is None:
        member_count = (
            ctx.db.query(Membership)
            .filter(Membership.group_id == g.id)
            .count()
        )
    if slot_count is None:
        slot_count = ctx.db.query(Slot).filter(Slot.group_id == g.id).count()
    return GroupOut(
        id=g.id,
        tenant_id=g.tenant_id,
        name=g.name,
        lead_membership_id=g.lead_membership_id,
        lead_name=lead_name,
        member_count=member_count,
        slot_count=slot_count,
        created_at=g.created_at,
    )


def _get_or_404(ctx: RequestContext, group_id: int) -> Group:
    g = ctx.db.get(Group, group_id)
    if not g or g.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Group not found")
    return g


def _validate_membership_in_tenant(ctx: RequestContext, membership_id: int) -> Membership:
    m = ctx.db.get(Membership, membership_id)
    if not m or m.tenant_id != ctx.tenant.id:
        raise HTTPException(
            status_code=422, detail=f"Unknown membership_id: {membership_id}"
        )
    return m


@router.get("/groups", response_model=list[GroupOut])
def list_groups(
    ctx: RequestContext = Depends(get_current_context),
) -> list[GroupOut]:
    # Readable by any authenticated tenant member — the team page
    # uses group names for the "Sub-equipo" pill on members and
    # slots. Mutations are admin-only (see other routes).
    groups = (
        ctx.db.query(Group)
        .filter(Group.tenant_id == ctx.tenant.id)
        .order_by(Group.name)
        .all()
    )
    # Batch lookups to avoid N+1.
    lead_ids = [g.lead_membership_id for g in groups if g.lead_membership_id]
    lead_names: dict[int, str] = {}
    if lead_ids:
        for mid, name in (
            ctx.db.query(Membership.id, Person.name)
            .join(Person, Person.id == Membership.person_id)
            .filter(Membership.id.in_(lead_ids))
            .all()
        ):
            lead_names[mid] = name
    # Per-group counts. One extra query per group is fine for v1
    # (tenants typically have <5 groups); upgrade to a single
    # GROUP BY when that stops being true.
    return [
        _serialize(
            ctx,
            g,
            lead_name=lead_names.get(g.lead_membership_id) if g.lead_membership_id else None,
        )
        for g in groups
    ]


@router.post("/groups", response_model=GroupOut, status_code=status.HTTP_201_CREATED)
def create_group(
    payload: GroupCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> GroupOut:
    _require_tenant_admin(ctx)
    if payload.lead_membership_id is not None:
        _validate_membership_in_tenant(ctx, payload.lead_membership_id)
    g = Group(
        tenant_id=ctx.tenant.id,
        name=payload.name.strip(),
        lead_membership_id=payload.lead_membership_id,
    )
    ctx.db.add(g)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Ya existe un sub-equipo con ese nombre.")
    return _serialize(ctx, g)


@router.put("/groups/{group_id}", response_model=GroupOut)
def update_group(
    group_id: int,
    payload: GroupUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> GroupOut:
    _require_tenant_admin(ctx)
    g = _get_or_404(ctx, group_id)
    data = payload.model_dump(exclude_unset=True)
    clear_lead = data.pop("clear_lead", False)
    if "name" in data and data["name"] is not None:
        g.name = data["name"].strip()
    if clear_lead:
        g.lead_membership_id = None
    elif "lead_membership_id" in data:
        if data["lead_membership_id"] is not None:
            _validate_membership_in_tenant(ctx, data["lead_membership_id"])
        g.lead_membership_id = data["lead_membership_id"]
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(status_code=409, detail="Ya existe un sub-equipo con ese nombre.")
    return _serialize(ctx, g)


@router.delete("/groups/{group_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_group(
    group_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_tenant_admin(ctx)
    g = _get_or_404(ctx, group_id)
    # SET NULL on membership.group_id + slot.group_id is wired by
    # the FK constraint; deleting the group just unscopes its
    # rows back to "main team".
    ctx.db.delete(g)
    ctx.db.flush()


@router.put("/groups/{group_id}/members", response_model=GroupOut)
def replace_group_members(
    group_id: int,
    payload: GroupMembersUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> GroupOut:
    """Replace the group's membership list with `membership_ids`.

    Memberships listed here that were elsewhere (main team or
    another group) are moved INTO this group. Memberships
    previously in this group but absent from the list are moved
    out to the main team (group_id = NULL).
    """
    _require_tenant_admin(ctx)
    g = _get_or_404(ctx, group_id)
    desired = set(payload.membership_ids)

    # Validate every requested membership belongs to this tenant.
    if desired:
        found = (
            ctx.db.query(Membership.id)
            .filter(
                Membership.id.in_(desired),
                Membership.tenant_id == ctx.tenant.id,
            )
            .all()
        )
        found_ids = {row[0] for row in found}
        missing = desired - found_ids
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"Unknown membership_ids: {sorted(missing)}",
            )

    # Move requested memberships into the group.
    if desired:
        ctx.db.query(Membership).filter(
            Membership.id.in_(desired),
            Membership.tenant_id == ctx.tenant.id,
        ).update({Membership.group_id: g.id}, synchronize_session=False)

    # Move out memberships that USED to be in this group but aren't
    # in the new list.
    ctx.db.query(Membership).filter(
        Membership.tenant_id == ctx.tenant.id,
        Membership.group_id == g.id,
        ~Membership.id.in_(desired) if desired else True,
    ).update({Membership.group_id: None}, synchronize_session=False)

    ctx.db.flush()
    return _serialize(ctx, g)
