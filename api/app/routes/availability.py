"""Availability block admin endpoints + self-service request workflow.

Sprint 4 introduced the table as admin-managed only. Sprint 5 part C
adds the request → approve/deny lifecycle. The solver only respects
status='approved' rows; pending and denied are scheduling-no-ops.
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, text

from app.db.session import AdminSessionLocal, set_tenant
from app.models import AvailabilityBlock, Membership, Person, Tenant
from app.routes.deps import RequestContext, get_current_context
from app.schemas.availability import (
    TeamAbsence,
    AvailabilityBlockCreate,
    AvailabilityBlockOut,
    AvailabilityBlockUpdate,
    AvailabilityDenyRequest,
    AvailabilityRequestCreate,
    BlockStatus,
    ServicioAdminOut,
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


def _serialize(
    block: AvailabilityBlock,
    person: Person,
    *,
    reviewers: dict[int, tuple[str, str]] | None = None,
) -> AvailabilityBlockOut:
    """`reviewers` is the pre-batched map produced by
    `_resolve_reviewers(...)` — pass it when serialising multiple
    blocks at once to avoid N+1 lookups. For single-block contexts
    we resolve inline (one extra query when the block has a
    reviewer; zero when it doesn't).
    """
    rev_name: str | None = None
    rev_tenant: str | None = None
    if block.reviewer_membership_id is not None:
        if reviewers is not None:
            hit = reviewers.get(block.reviewer_membership_id)
            if hit is not None:
                rev_name, rev_tenant = hit
        else:
            rev_name, rev_tenant = _reviewer_display(block.reviewer_membership_id)
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
        reviewer_membership_id=block.reviewer_membership_id,
        reviewer_person_name=rev_name,
        reviewer_tenant_name=rev_tenant,
        created_at=block.created_at,
    )


def _reviewer_display(
    reviewer_membership_id: int,
) -> tuple[str | None, str | None]:
    """Resolve a single reviewer_membership_id → (person_name,
    tenant_name). Uses AdminSessionLocal so we can find the row even
    when it belongs to a sibling tenant (RLS on the caller's
    connection would otherwise hide it).

    Returns (None, None) when the membership has been deleted since
    the bloqueo was assigned (FK is ON DELETE SET NULL but a race
    could still leave the id pointing at nothing).
    """
    with AdminSessionLocal() as adb:
        row = (
            adb.query(Membership, Person, Tenant)
            .join(Person, Person.id == Membership.person_id)
            .join(Tenant, Tenant.id == Membership.tenant_id)
            .filter(Membership.id == reviewer_membership_id)
            .first()
        )
    if row is None:
        return (None, None)
    _m, p, t = row
    return (p.name, t.name)


def _resolve_reviewers(
    blocks: list[AvailabilityBlock],
) -> dict[int, tuple[str, str]]:
    """Bulk resolve every distinct reviewer_membership_id in `blocks`
    → (person_name, tenant_name). One AdminSessionLocal round-trip;
    list endpoints feed the result into _serialize via the
    `reviewers=` kwarg to avoid N+1 lookups."""
    mids = {
        b.reviewer_membership_id
        for b in blocks
        if b.reviewer_membership_id is not None
    }
    if not mids:
        return {}
    with AdminSessionLocal() as adb:
        rows = (
            adb.query(Membership.id, Person.name, Tenant.name)
            .join(Person, Person.id == Membership.person_id)
            .join(Tenant, Tenant.id == Membership.tenant_id)
            .filter(Membership.id.in_(mids))
            .all()
        )
    return {mid: (pname, tname) for (mid, pname, tname) in rows}


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
    """Admin list. Includes:
      (a) every block in the caller's own tenant (RLS, classic), AND
      (b) cross-tenant blocks where the caller is the chosen
          reviewer (migration 0083). These live in a sibling
          equipo's tenant; we read them via AdminSessionLocal
          since the caller's RLS context can't see them. Merged in
          memory + sorted by start_date desc.

    The `person_id` filter is applied to local rows only — it'd be
    confusing to filter cross-tenant blocks by a local person id
    that doesn't exist there.
    """
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
    rows = q.order_by(AvailabilityBlock.start_date.desc()).all()

    # (b) Cross-tenant blocks assigned to this admin. Only fetch
    # when no person_id filter is set (per the docstring rationale).
    cross_rows: list[tuple[AvailabilityBlock, Person]] = []
    if person_id is None:
        with AdminSessionLocal() as adb:
            cq = (
                adb.query(AvailabilityBlock, Person)
                .join(Person, Person.id == AvailabilityBlock.person_id)
                .filter(AvailabilityBlock.reviewer_membership_id == ctx.membership.id)
                .filter(AvailabilityBlock.tenant_id != ctx.tenant.id)
            )
            if from_ is not None:
                cq = cq.filter(AvailabilityBlock.end_date >= from_)
            if to is not None:
                cq = cq.filter(AvailabilityBlock.start_date <= to)
            if status_ is not None:
                cq = cq.filter(AvailabilityBlock.status == status_)
            cross_rows = cq.order_by(AvailabilityBlock.start_date.desc()).all()
            # Expunge so the rows survive the session.close() — we
            # only need the field values, not the ORM identity.
            for b, p in cross_rows:
                adb.expunge(b)
                adb.expunge(p)

    all_blocks = [b for b, _ in rows] + [b for b, _ in cross_rows]
    reviewers = _resolve_reviewers(all_blocks)
    serialised = (
        [_serialize(b, p, reviewers=reviewers) for b, p in rows]
        + [_serialize(b, p, reviewers=reviewers) for b, p in cross_rows]
    )
    # Final sort across the union — preserves the per-source order
    # when there are ties.
    serialised.sort(key=lambda x: x.start_date, reverse=True)
    return serialised


@router.get(
    "/availability/team-absences",
    response_model=list[TeamAbsence],
)
def list_team_absences(
    from_: date | None = Query(default=None, alias="from"),
    to: date | None = None,
    ctx: RequestContext = Depends(get_current_context),
) -> list[TeamAbsence]:
    """Sanitized read-only view of APPROVED availability blocks for the
    whole tenant. Returned to any authenticated user — the team needs to
    see who's on vacation / baja for the Libre row in the planning grid.
    No notes / review notes are exposed; only what the row needs.
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


def _load_for_review(
    ctx: RequestContext, block_id: int
) -> tuple[AvailabilityBlock, Person, bool]:
    """Resolve a block id to the row + its requester person for an
    approve/deny operation. Returns (block, person, is_cross_tenant).

    Auth rules (migration 0083):
    - If `reviewer_membership_id` is set on the block, ONLY that
      membership can review it (locked routing). The block may live
      in a sibling tenant — we use AdminSessionLocal to fetch it
      since the caller's RLS context can't see cross-tenant rows.
    - If `reviewer_membership_id` is NULL (legacy), any admin of
      the block's own tenant can review (current behaviour).

    404 on any mismatch — never leak existence of a block the
    caller isn't authorised to touch.
    """
    # First try the local tenant — fast happy path.
    block = ctx.db.get(AvailabilityBlock, block_id)
    if block is not None and block.tenant_id == ctx.tenant.id:
        _ensure_member(ctx, block.person_id)
        # If this block is locked to a specific reviewer, only that
        # membership can act on it (even if other local admins exist).
        if (
            block.reviewer_membership_id is not None
            and block.reviewer_membership_id != ctx.membership.id
        ):
            raise HTTPException(
                status_code=403,
                detail=(
                    "Esta solicitud está asignada a otro admin "
                    "del servicio."
                ),
            )
        person = ctx.db.get(Person, block.person_id)
        assert person is not None
        return (block, person, False)

    # Not in local tenant. Look in any sibling tenant where the
    # caller is the chosen reviewer. AdminSessionLocal bypasses RLS
    # so we can find the row; we still gate on
    # reviewer_membership_id == ctx.membership.id so the caller can
    # only touch blocks they were explicitly assigned.
    with AdminSessionLocal() as adb:
        row = (
            adb.query(AvailabilityBlock, Person)
            .join(Person, Person.id == AvailabilityBlock.person_id)
            .filter(
                AvailabilityBlock.id == block_id,
                AvailabilityBlock.reviewer_membership_id == ctx.membership.id,
            )
            .first()
        )
        if row is None:
            raise HTTPException(status_code=404, detail="Block not found")
        b, p = row
        # Expunge so the caller can keep using these objects after the
        # AdminSessionLocal is closed. The actual write happens in a
        # fresh AdminSessionLocal scope below.
        adb.expunge(b)
        adb.expunge(p)
    return (b, p, True)


def _apply_review_write(
    *,
    block_id: int,
    new_status: str,
    reviewer_membership_id: int,
    review_notes: str | None,
    is_cross_tenant: bool,
    local_block: AvailabilityBlock | None,
    ctx: RequestContext,
) -> None:
    """Persist the approve/deny decision. Local tenant goes through
    the caller's session; cross-tenant goes through a fresh
    AdminSessionLocal scope (RLS bypass) bounded by the same
    reviewer_membership_id == ctx.membership.id filter we used to
    load it, so it's still impossible to mutate a block the caller
    wasn't assigned."""
    now_utc = datetime.now(timezone.utc)
    if not is_cross_tenant:
        assert local_block is not None
        local_block.status = new_status
        local_block.reviewed_by_membership_id = reviewer_membership_id
        local_block.reviewed_at = now_utc
        if review_notes is not None:
            local_block.review_notes = review_notes
        ctx.db.flush()
        return
    with AdminSessionLocal() as adb:
        b = (
            adb.query(AvailabilityBlock)
            .filter(
                AvailabilityBlock.id == block_id,
                AvailabilityBlock.reviewer_membership_id == reviewer_membership_id,
            )
            .first()
        )
        if b is None:
            raise HTTPException(status_code=404, detail="Block not found")
        b.status = new_status
        b.reviewed_by_membership_id = reviewer_membership_id
        b.reviewed_at = now_utc
        if review_notes is not None:
            b.review_notes = review_notes
        adb.commit()


@router.post(
    "/availability-blocks/{block_id}/approve",
    response_model=AvailabilityBlockOut,
)
def approve_block(
    block_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> AvailabilityBlockOut:
    _require_admin(ctx)
    block, person, is_cross = _load_for_review(ctx, block_id)
    _apply_review_write(
        block_id=block_id,
        new_status="approved",
        reviewer_membership_id=ctx.membership.id,
        review_notes=None,
        is_cross_tenant=is_cross,
        local_block=block if not is_cross else None,
        ctx=ctx,
    )
    # Reflect the mutation onto our in-memory block for the response
    # serialisation (the cross-tenant write happened in a separate
    # session, so the local `block` ORM object is stale).
    block.status = "approved"
    block.reviewed_by_membership_id = ctx.membership.id
    block.reviewed_at = datetime.now(timezone.utc)
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
    block, person, is_cross = _load_for_review(ctx, block_id)
    _apply_review_write(
        block_id=block_id,
        new_status="denied",
        reviewer_membership_id=ctx.membership.id,
        review_notes=payload.review_notes,
        is_cross_tenant=is_cross,
        local_block=block if not is_cross else None,
        ctx=ctx,
    )
    block.status = "denied"
    block.reviewed_by_membership_id = ctx.membership.id
    block.reviewed_at = datetime.now(timezone.utc)
    if payload.review_notes is not None:
        block.review_notes = payload.review_notes
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
    # Migration 0083: optional reviewer routing. When the member
    # picks an admin from the servicio-wide picker, we validate the
    # choice against the same `list_servicio_persons` SECURITY
    # DEFINER function that powers cross-equipo meeting invites —
    # this guarantees the chosen admin is (a) in an approved equipo
    # of the same servicio and (b) actually carries the 'admin'
    # role on that membership. NULL passes through unchanged
    # (legacy behaviour: any admin in own tenant can review).
    reviewer_membership_id: int | None = None
    if payload.reviewer_membership_id is not None:
        reviewer_membership_id = _validate_servicio_admin(
            ctx, payload.reviewer_membership_id
        )
    block = AvailabilityBlock(
        tenant_id=ctx.tenant.id,
        person_id=ctx.person.id,
        start_date=payload.start_date,
        end_date=payload.end_date,
        block_type=payload.block_type,
        notes=payload.notes,
        status="pending",
        requested_by_membership_id=ctx.membership.id,
        reviewer_membership_id=reviewer_membership_id,
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
    reviewers = _resolve_reviewers([b for b, _ in rows])
    return [_serialize(b, p, reviewers=reviewers) for b, p in rows]


# ---------------------------------------------------------------------------
# Servicio-wide admin picker (migration 0083)
# ---------------------------------------------------------------------------


def _validate_servicio_admin(ctx: RequestContext, membership_id: int) -> int:
    """Verify that `membership_id` is an admin of some approved equipo
    inside the caller's servicio (their own equipo counts too).
    Raises 422 if not. Returns the validated id back so the caller
    can use it in a single line."""
    admins = _list_servicio_admins(ctx)
    valid_ids = {a.membership_id for a in admins}
    if membership_id not in valid_ids:
        raise HTTPException(
            status_code=422,
            detail=(
                "El admin elegido no pertenece al servicio o ya no "
                "está activo."
            ),
        )
    return membership_id


def _list_servicio_admins(ctx: RequestContext) -> list[ServicioAdminOut]:
    """Build the picker list. Returns every admin membership inside
    the caller's servicio, across approved equipos.

    For tenants without a servicio_id (legacy pre-Phase-A), falls
    back to admins of the caller's own tenant — so the picker still
    works on un-migrated standalone tenants.
    """
    out: list[ServicioAdminOut] = []
    if ctx.tenant.servicio_id is None:
        # Standalone tenant — local admins only.
        with AdminSessionLocal() as adb:
            rows = (
                adb.query(Membership, Person, Tenant)
                .join(Person, Person.id == Membership.person_id)
                .join(Tenant, Tenant.id == Membership.tenant_id)
                .filter(
                    Membership.tenant_id == ctx.tenant.id,
                    Membership.disabled_at.is_(None),
                    Membership.roles.contains(["admin"]),
                )
                .all()
            )
            for m, p, t in rows:
                out.append(
                    ServicioAdminOut(
                        membership_id=m.id,
                        person_id=p.id,
                        person_name=p.name,
                        tenant_id=t.id,
                        tenant_name=t.name,
                        is_own_tenant=True,
                    )
                )
        return _sort_picker(out)

    # Servicio-aware. AdminSessionLocal bypasses RLS so we can
    # enumerate sibling tenants' admins. Only approved equipos
    # (matches the policy used by `list_servicio_persons`).
    with AdminSessionLocal() as adb:
        rows = (
            adb.query(Membership, Person, Tenant)
            .join(Person, Person.id == Membership.person_id)
            .join(Tenant, Tenant.id == Membership.tenant_id)
            .filter(
                Tenant.servicio_id == ctx.tenant.servicio_id,
                Tenant.approval_state == "approved",
                Membership.disabled_at.is_(None),
                Membership.roles.contains(["admin"]),
            )
            .all()
        )
        for m, p, t in rows:
            out.append(
                ServicioAdminOut(
                    membership_id=m.id,
                    person_id=p.id,
                    person_name=p.name,
                    tenant_id=t.id,
                    tenant_name=t.name,
                    is_own_tenant=(t.id == ctx.tenant.id),
                )
            )
    return _sort_picker(out)


def _sort_picker(rows: list[ServicioAdminOut]) -> list[ServicioAdminOut]:
    """Own-tenant admins first (most common pick), then sibling
    equipos grouped by tenant name. Within each group sort by
    person name so the list reads predictably."""
    return sorted(
        rows,
        key=lambda r: (
            0 if r.is_own_tenant else 1,
            r.tenant_name.lower(),
            r.person_name.lower(),
        ),
    )


@router.get(
    "/me/servicio/admins",
    response_model=list[ServicioAdminOut],
)
def list_my_servicio_admins(
    ctx: RequestContext = Depends(get_current_context),
) -> list[ServicioAdminOut]:
    """Picker source for the bloqueo reviewer dropdown on
    /me/bloqueos. Returns every admin of every approved equipo in
    the caller's servicio, with the caller's own equipo first."""
    return _list_servicio_admins(ctx)


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
