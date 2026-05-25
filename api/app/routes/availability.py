"""Availability block admin endpoints + self-service request workflow.

Sprint 4 introduced the table as admin-managed only. Sprint 5 part C
adds the request → approve/deny lifecycle. The solver only respects
status='approved' rows; pending and denied are scheduling-no-ops.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.models import AvailabilityBlock, Membership, Person
from app.routes.deps import RequestContext, get_current_context
from app.schemas.availability import (
    TeamAbsence,
    AvailabilityBlockCreate,
    AvailabilityBlockOut,
    AvailabilityBlockUpdate,
    AvailabilityDenyRequest,
    AvailabilityRequestCreate,
    BlockStatus,
)

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _ensure_member(ctx: RequestContext, person_id: int) -> None:
    """Reject person_ids that don't belong to a member of the current tenant.
    Without this we'd happily store an availability block for a person that
    doesn't exist in this tenant — RLS doesn't catch it because availability
    blocks have their own tenant_id, separate from the person they reference.
    """
    m = (
        ctx.db.query(Membership)
        .filter(Membership.tenant_id == ctx.tenant.id, Membership.person_id == person_id)
        .first()
    )
    if not m:
        raise HTTPException(
            status_code=422, detail="person_id is not a member of this tenant"
        )


# `_ensure_main_team_member` used to reject sub-equipo persons here
# so the tenant admin couldn't create/edit/approve their bloqueos.
# Dropped — sub-equipo members can now request bloqueos themselves,
# and the tenant admin approves them along with main-team requests.
# Callers now use `_ensure_member` directly. Kept the function name
# as a thin alias for diff hygiene; will be removed in a follow-up.


def _serialize(block: AvailabilityBlock, person: Person) -> AvailabilityBlockOut:
    return AvailabilityBlockOut(
        id=block.id,
        tenant_id=block.tenant_id,
        person_id=block.person_id,
        person_name=person.name,
        start_date=block.start_date,
        end_date=block.end_date,
        block_type=block.block_type,  # type: ignore[arg-type]
        notes=block.notes,
        status=block.status,  # type: ignore[arg-type]
        requested_by_membership_id=block.requested_by_membership_id,
        reviewed_by_membership_id=block.reviewed_by_membership_id,
        reviewed_at=block.reviewed_at,
        review_notes=block.review_notes,
        created_at=block.created_at,
    )


# ---------------------------------------------------------------------------
# Admin endpoints (existing API, extended with status)
# ---------------------------------------------------------------------------


@router.get("/availability-blocks", response_model=list[AvailabilityBlockOut])
def list_blocks(
    person_id: int | None = None,
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
    status_: BlockStatus | None = Query(default=None, alias="status"),
    ctx: RequestContext = Depends(get_current_context),
) -> list[AvailabilityBlockOut]:
    _require_admin(ctx)
    q = ctx.db.query(AvailabilityBlock, Person).join(
        Person, Person.id == AvailabilityBlock.person_id
    )
    if person_id is not None:
        q = q.filter(AvailabilityBlock.person_id == person_id)
    if from_ is not None:
        q = q.filter(AvailabilityBlock.end_date >= from_)
    if to is not None:
        q = q.filter(AvailabilityBlock.start_date <= to)
    if status_ is not None:
        q = q.filter(AvailabilityBlock.status == status_)
    # No group filter — tenant admin sees bloqueos for everyone in
    # the tenant, including sub-equipo members. The frontend
    # /admin/availability page surfaces the person's group on each
    # row so admins can spot "este es del sub-equipo X".
    rows = q.order_by(AvailabilityBlock.start_date.desc()).all()
    return [_serialize(b, p) for b, p in rows]


@router.get(
    "/availability/team-absences",
    response_model=list[TeamAbsence],
)
def list_team_absences(
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
    main_team_only: bool = False,
    ctx: RequestContext = Depends(get_current_context),
) -> list[TeamAbsence]:
    """Sanitized read-only view of APPROVED availability blocks for the
    whole tenant. Returned to any authenticated user — the team needs to
    see who's on vacation / baja for the Libre row in the planning grid.
    No notes / review notes are exposed; only what the row needs.

    Scope: by default, returns absences for every person in the
    tenant. /admin/schedule passes `main_team_only=true` so its
    Libre row shows only people whose Membership has
    `group_id IS NULL` — sub-equipo members' libre time belongs in
    the sub-equipo's own planning, not in the main team's grid.
    """
    q = (
        ctx.db.query(AvailabilityBlock, Person)
        .join(Person, Person.id == AvailabilityBlock.person_id)
        .filter(AvailabilityBlock.status == "approved")
    )
    if from_ is not None:
        q = q.filter(AvailabilityBlock.end_date >= from_)
    if to is not None:
        q = q.filter(AvailabilityBlock.start_date <= to)
    if main_team_only:
        # Restrict to persons whose Membership in THIS tenant has
        # no group_id (main team). We can't filter on Person alone
        # — Persons aren't tenant-scoped, only Memberships are.
        # EXISTS subquery keeps the row count correct even when a
        # person has multiple memberships somehow.
        #
        # Sprint 28 tightening: ALSO exclude persons who have ANY
        # sub-team membership. Without this guard, a person with
        # both a main-team and a residents-group membership (e.g.
        # admin/lead merge into clinical membership from task #69)
        # would still pass the EXISTS check and leak into the
        # main planning's Libre row even though their clinical
        # work is on the sub-team. The user-visible symptom was
        # "veo residentes en la fila Libre del equipo principal".
        q = q.filter(
            ctx.db.query(Membership.id)
            .filter(
                Membership.person_id == AvailabilityBlock.person_id,
                Membership.tenant_id == ctx.tenant.id,
                Membership.group_id.is_(None),
            )
            .exists()
        ).filter(
            ~ctx.db.query(Membership.id)
            .filter(
                Membership.person_id == AvailabilityBlock.person_id,
                Membership.tenant_id == ctx.tenant.id,
                Membership.group_id.isnot(None),
            )
            .exists()
        )
    rows = q.order_by(AvailabilityBlock.start_date).all()
    return [
        TeamAbsence(
            person_id=b.person_id,
            person_name=p.name,
            person_first_name=p.first_name,
            person_last_name=p.last_name,
            person_avatar_url=p.avatar_url,
            start_date=b.start_date,
            end_date=b.end_date,
            block_type=b.block_type,  # type: ignore[arg-type]
        )
        for b, p in rows
    ]


@router.post(
    "/availability-blocks",
    response_model=AvailabilityBlockOut,
    status_code=status.HTTP_201_CREATED,
)
def create_block(
    payload: AvailabilityBlockCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> AvailabilityBlockOut:
    _require_admin(ctx)
    _ensure_member(ctx, payload.person_id)
    block = AvailabilityBlock(
        tenant_id=ctx.tenant.id,
        person_id=payload.person_id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        block_type=payload.block_type,
        notes=payload.notes,
        # Admin-direct creation defaults to approved.
        status="approved",
        reviewed_by_membership_id=ctx.membership.id,
        reviewed_at=datetime.now(timezone.utc),
    )
    ctx.db.add(block)
    ctx.db.flush()
    person = ctx.db.get(Person, block.person_id)
    assert person is not None
    return _serialize(block, person)


@router.put(
    "/availability-blocks/{block_id}", response_model=AvailabilityBlockOut
)
def update_block(
    block_id: int,
    payload: AvailabilityBlockUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> AvailabilityBlockOut:
    _require_admin(ctx)
    block = ctx.db.get(AvailabilityBlock, block_id)
    if not block or block.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Block not found")
    # Both the existing target and the new target must be main team.
    _ensure_member(ctx, block.person_id)
    _ensure_member(ctx, payload.person_id)
    block.person_id = payload.person_id
    block.start_date = payload.start_date
    block.end_date = payload.end_date
    block.block_type = payload.block_type
    block.notes = payload.notes
    ctx.db.flush()
    person = ctx.db.get(Person, block.person_id)
    assert person is not None
    return _serialize(block, person)


@router.delete(
    "/availability-blocks/{block_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_block(
    block_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    block = ctx.db.get(AvailabilityBlock, block_id)
    if not block or block.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Block not found")
    _ensure_member(ctx, block.person_id)
    ctx.db.delete(block)
    ctx.db.flush()


@router.post(
    "/availability-blocks/{block_id}/approve",
    response_model=AvailabilityBlockOut,
)
def approve_block(
    block_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> AvailabilityBlockOut:
    _require_admin(ctx)
    block = ctx.db.get(AvailabilityBlock, block_id)
    if not block or block.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Block not found")
    _ensure_member(ctx, block.person_id)
    block.status = "approved"
    block.reviewed_by_membership_id = ctx.membership.id
    block.reviewed_at = datetime.now(timezone.utc)
    ctx.db.flush()
    person = ctx.db.get(Person, block.person_id)
    assert person is not None
    return _serialize(block, person)


@router.post(
    "/availability-blocks/{block_id}/deny",
    response_model=AvailabilityBlockOut,
)
def deny_block(
    block_id: int,
    payload: AvailabilityDenyRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> AvailabilityBlockOut:
    _require_admin(ctx)
    block = ctx.db.get(AvailabilityBlock, block_id)
    if not block or block.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Block not found")
    _ensure_member(ctx, block.person_id)
    block.status = "denied"
    block.reviewed_by_membership_id = ctx.membership.id
    block.reviewed_at = datetime.now(timezone.utc)
    block.review_notes = payload.review_notes
    ctx.db.flush()
    person = ctx.db.get(Person, block.person_id)
    assert person is not None
    return _serialize(block, person)


# ---------------------------------------------------------------------------
# Self-service endpoints (any authenticated member of the tenant)
# ---------------------------------------------------------------------------


@router.post(
    "/me/availability-requests",
    response_model=AvailabilityBlockOut,
    status_code=status.HTTP_201_CREATED,
)
def create_my_request(
    payload: AvailabilityRequestCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> AvailabilityBlockOut:
    # Sub-equipo members can request bloqueos too — the request
    # goes through tenant-admin approval the same way main-team
    # ones do. Lead-side approval is a separate scope.
    block = AvailabilityBlock(
        tenant_id=ctx.tenant.id,
        person_id=ctx.person.id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        block_type=payload.block_type,
        notes=payload.notes,
        status="pending",
        requested_by_membership_id=ctx.membership.id,
    )
    ctx.db.add(block)
    ctx.db.flush()
    return _serialize(block, ctx.person)


@router.get(
    "/me/availability-requests",
    response_model=list[AvailabilityBlockOut],
)
def list_my_requests(
    ctx: RequestContext = Depends(get_current_context),
) -> list[AvailabilityBlockOut]:
    rows = (
        ctx.db.query(AvailabilityBlock, Person)
        .join(Person, Person.id == AvailabilityBlock.person_id)
        .filter(AvailabilityBlock.person_id == ctx.person.id)
        .order_by(AvailabilityBlock.created_at.desc())
        .all()
    )
    return [_serialize(b, p) for b, p in rows]


@router.delete(
    "/me/availability-requests/{block_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_my_request(
    block_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    block = ctx.db.get(AvailabilityBlock, block_id)
    # 404 (not 403) on cross-person/cross-status to avoid leaking existence.
    if (
        not block
        or block.tenant_id != ctx.tenant.id
        or block.person_id != ctx.person.id
        or block.status != "pending"
    ):
        raise HTTPException(status_code=404, detail="Request not found")
    ctx.db.delete(block)
    ctx.db.flush()
