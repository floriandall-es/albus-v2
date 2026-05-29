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
from app.models import (
    Assignment,
    AvailabilityBlock,
    Membership,
    Person,
    Schedule,
    Slot,
    SlotTeamRole,
    Tenant,
)
from app.routes.deps import RequestContext, get_current_context
from app.services.notifications import PushPayload, push_only
from app.schemas.availability import (
    TeamAbsence,
    AvailabilityBlockCreate,
    AvailabilityBlockOut,
    AvailabilityBlockUpdate,
    AvailabilityDenyRequest,
    AvailabilityRequestCreate,
    BlockStatus,
    ConflictingShift,
    ServicioAdminOut,
    ServicioAdminPickerOut,
)

router = APIRouter()


def _bloqueo_summary(block: AvailabilityBlock) -> str:
    """Short body line for the push: "26 jun – 28 jun" or "26 jun"
    when single-day. Notification bodies can be long enough that
    we don't need any abbreviation, but a compact range still
    reads better on the lock screen than the ISO format."""
    start = block.start_date.strftime("%d/%m")
    if block.end_date and block.end_date != block.start_date:
        end = block.end_date.strftime("%d/%m")
        return f"{start} – {end}"
    return start


def _push_bloqueo_submitted(
    ctx: RequestContext, block: AvailabilityBlock
) -> None:
    """Notify the chosen reviewer that a bloqueo needs them.

    No email counterpart today — bloqueos historically relied on
    admins poll-checking the pendientes badge. Push closes that
    gap for the subscribed reviewers; everyone else still sees
    the sidebar badge next time they open Trivu."""
    if block.reviewer_membership_id is None:
        return
    reviewer_m = ctx.db.get(Membership, block.reviewer_membership_id)
    if reviewer_m is None:
        return
    reviewer = ctx.db.get(Person, reviewer_m.person_id)
    submitter_name = ctx.person.name
    push_only(
        reviewer,
        push=PushPayload(
            title=f"{submitter_name} pide un bloqueo",
            body=_bloqueo_summary(block),
            path="/admin/availability",
            tag=f"bloqueo:request:{block.id}",
        ),
    )


def _push_bloqueo_decided(
    ctx: RequestContext,
    block: AvailabilityBlock,
    *,
    person: Person,
    approved: bool,
) -> None:
    """Notify the submitter of the admin's decision. `person` is the
    block's owner — passed in by the caller since admin routes
    already loaded them via _load_for_review."""
    reviewer_name = ctx.person.name
    if approved:
        title = f"{reviewer_name} aprobó tu bloqueo"
    else:
        title = f"{reviewer_name} rechazó tu bloqueo"
    push_only(
        person,
        push=PushPayload(
            title=title,
            body=_bloqueo_summary(block),
            path="/me/bloqueos",
            tag=f"bloqueo:decision:{block.id}",
        ),
    )


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
    conflicts: dict[int, tuple[list[ConflictingShift], bool]] | None = None,
    ctx: RequestContext | None = None,
) -> AvailabilityBlockOut:
    """`reviewers` is the pre-batched map produced by
    `_resolve_reviewers(...)` — pass it when serialising multiple
    blocks at once to avoid N+1 lookups. For single-block contexts
    we resolve inline (one extra query when the block has a
    reviewer; zero when it doesn't).

    `conflicts` carries the pre-batched conflict-shifts result keyed
    by block id (see `_resolve_conflicts`). When omitted on a
    pending block we resolve inline via the passed `ctx`; on
    non-pending blocks we skip the lookup entirely (conflicts are
    only interesting before the decision is made).
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
    conflict_shifts: list[ConflictingShift] = []
    conflict_truncated = False
    if block.status == "pending":
        if conflicts is not None:
            conflict_shifts, conflict_truncated = conflicts.get(
                block.id, ([], False)
            )
        elif ctx is not None:
            conflict_shifts, conflict_truncated = _resolve_conflicts(
                ctx, [block]
            ).get(block.id, ([], False))
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
        conflicting_shifts=conflict_shifts,
        conflicting_shifts_truncated=conflict_truncated,
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


# Cap on conflicting-shift rows reported per pending bloqueo. Past
# this the admin gets the gist — they can open the planning grid
# if they need the exhaustive list. Keeps the JSON payload bounded
# even on pathological cases (someone requesting a 6-month leave
# while assigned every-day shifts).
_CONFLICT_CAP = 20


def _resolve_conflicts(
    ctx: RequestContext,
    blocks: list[AvailabilityBlock],
) -> dict[int, tuple[list[ConflictingShift], bool]]:
    """For each pending block in `blocks`, find the assignments the
    block would displace if approved. Cross-tenant blocks are
    resolved via AdminSessionLocal because their assignments live
    in the requester's tenant, not the caller's RLS scope.

    Returns a dict keyed by block.id → (shifts, truncated_flag).
    Empty for non-pending blocks (we don't bother flagging
    conflicts after the decision is made).
    """
    pending = [b for b in blocks if b.status == "pending"]
    if not pending:
        return {}

    # Partition by tenant_id — local tenant rows go through
    # ctx.db (RLS-scoped), cross-tenant rows through AdminSessionLocal.
    local_pending = [b for b in pending if b.tenant_id == ctx.tenant.id]
    cross_pending = [b for b in pending if b.tenant_id != ctx.tenant.id]

    out: dict[int, tuple[list[ConflictingShift], bool]] = {}

    def _fetch(db, blocks_subset: list[AvailabilityBlock]) -> None:
        for b in blocks_subset:
            rows = (
                db.query(Assignment, Slot, SlotTeamRole)
                .join(Schedule, Schedule.id == Assignment.schedule_id)
                .join(Slot, Slot.id == Assignment.slot_id)
                .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
                .filter(
                    Schedule.status.in_(["published", "archived"]),
                    Assignment.person_id == b.person_id,
                    Assignment.date.between(b.start_date, b.end_date),
                    Assignment.tenant_id == b.tenant_id,
                )
                .order_by(Assignment.date.asc(), Slot.position.asc())
                # Fetch one extra row so we can detect truncation
                # without a second COUNT query.
                .limit(_CONFLICT_CAP + 1)
                .all()
            )
            truncated = len(rows) > _CONFLICT_CAP
            shifts = [
                ConflictingShift(
                    date=a.date,
                    slot_name=s.name,
                    role_label=r.role_label if r is not None else None,
                )
                for (a, s, r) in rows[:_CONFLICT_CAP]
            ]
            out[b.id] = (shifts, truncated)

    if local_pending:
        _fetch(ctx.db, local_pending)
    if cross_pending:
        with AdminSessionLocal() as adb:
            _fetch(adb, cross_pending)

    return out


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
    conflicts = _resolve_conflicts(ctx, all_blocks)
    serialised = (
        [
            _serialize(b, p, reviewers=reviewers, conflicts=conflicts)
            for b, p in rows
        ]
        + [
            _serialize(b, p, reviewers=reviewers, conflicts=conflicts)
            for b, p in cross_rows
        ]
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
    return _serialize(block, person, ctx=ctx)


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
    return _serialize(block, person, ctx=ctx)


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
    try:
        _push_bloqueo_decided(ctx, block, person=person, approved=True)
    except Exception:  # noqa: BLE001
        pass
    return _serialize(block, person, ctx=ctx)


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
    try:
        _push_bloqueo_decided(ctx, block, person=person, approved=False)
    except Exception:  # noqa: BLE001
        pass
    return _serialize(block, person, ctx=ctx)


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
    """Member raises a bloqueo.

    Reviewer routing branches on servicio.bloqueo_routing_mode
    (migration 0085):

      - 'centralised' + a Jefe de Servicio exists: ignore the
        client's `reviewer_membership_id` and force-assign the
        jefe. Picker on /me/bloqueos has already collapsed to the
        jefe so the client is sending the right id anyway — we
        still override server-side to defend against a stale or
        bypassed UI.
      - 'centralised' + NO Jefe exists (cargo not set on anyone or
        the previous Jefe lost the cargo): silently fall back to
        delegated for this one request, validating the client's
        chosen reviewer like normal. Self-healing — the system
        never blocks bloqueos because of a missing config.
      - 'delegated' (the historical behaviour): the client's choice
        wins, validated against the servicio-wide admin list.
    """
    forced_reviewer = _resolve_centralised_reviewer(ctx)
    if forced_reviewer is not None:
        reviewer_membership_id = forced_reviewer
    else:
        # Migration 0083 path. Members must pick exactly which admin
        # reviews their bloqueo. Validated against the servicio-wide
        # admin list so we can't accept a stale or out-of-servicio
        # membership id.
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
    # Push the chosen reviewer so they know it's their queue.
    # Failures are swallowed inside push_only — bloqueo creation
    # must succeed even if the notification path errors.
    try:
        _push_bloqueo_submitted(ctx, block)
    except Exception:  # noqa: BLE001
        # Mirror the same blanket-catch pattern dms.py uses for
        # its email-fallback path. Notifications are best-effort.
        pass
    return _serialize(block, ctx.person, ctx=ctx)


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
    conflicts = _resolve_conflicts(ctx, [b for b, _ in rows])
    return [
        _serialize(b, p, reviewers=reviewers, conflicts=conflicts)
        for b, p in rows
    ]


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


# ---------------------------------------------------------------------------
# Jefe de Servicio resolution (migration 0085)
# ---------------------------------------------------------------------------


# Canonical lowercase form of the cargo we look for. Matched against
# each entry of person.cargos with stripped lowercase comparison so
# capitalisation differences (presets store "Jefe de servicio",
# migrations show "Jefe de Servicio") and stray whitespace don't
# silently disqualify the title-holder. The "Adjunto" suffix etc.
# get filtered out by the strict equality.
_JEFE_DE_SERVICIO_CARGO = "jefe de servicio"


def _person_is_jefe_de_servicio(p: Person) -> bool:
    """True iff any of `p.cargos` equals 'Jefe de Servicio' once
    trimmed and lowercased. Used both for resolving who the jefe
    is (membership-side, see _resolve_servicio_jefe) and gating
    the /admin/compartir toggle (caller-side, see servicios.py)."""
    for raw in p.cargos or ():
        if (raw or "").strip().lower() == _JEFE_DE_SERVICIO_CARGO:
            return True
    return False


def _resolve_servicio_jefe(
    ctx: RequestContext,
) -> tuple[Membership, Person, Tenant] | None:
    """The (Membership, Person, Tenant) of the Jefe de Servicio in
    the caller's servicio, or None if nobody currently carries the
    cargo on an admin membership of an approved equipo.

    Selection rules when multiple jefes exist (rare — typically
    one per servicio):
      1. An admin whose person is jefe AND who lives in the
         caller's own equipo, ordered by lowest membership id.
      2. Otherwise the lowest-membership-id jefe-admin elsewhere
         in the servicio.

    This deterministic pick means the same servicio always
    resolves to the same jefe across requests; we don't need a
    separate "designated_jefe_membership_id" column."""
    if ctx.tenant.servicio_id is None:
        # Standalone tenant. Look only within own tenant.
        with AdminSessionLocal() as adb:
            rows = (
                adb.query(Membership, Person, Tenant)
                .join(Person, Person.id == Membership.person_id)
                .join(Tenant, Tenant.id == Membership.tenant_id)
                .filter(
                    Membership.tenant_id == ctx.tenant.id,
                    Membership.disabled_at.is_(None),
                    Membership.roles.op("@>")(["admin"]),
                )
                .order_by(Membership.id.asc())
                .all()
            )
        for m, p, t in rows:
            if _person_is_jefe_de_servicio(p):
                return m, p, t
        return None

    # Servicio-aware. AdminSessionLocal bypasses RLS so we can scan
    # sibling equipos. Mirrors _list_servicio_admins filters.
    with AdminSessionLocal() as adb:
        rows = (
            adb.query(Membership, Person, Tenant)
            .join(Person, Person.id == Membership.person_id)
            .join(Tenant, Tenant.id == Membership.tenant_id)
            .filter(
                Tenant.servicio_id == ctx.tenant.servicio_id,
                Tenant.approval_state == "approved",
                Membership.disabled_at.is_(None),
                Membership.roles.op("@>")(["admin"]),
            )
            .order_by(Membership.id.asc())
            .all()
        )
    # Two-pass: prefer own-equipo, then anything else. Lowest
    # membership id within each bucket (matches the .order_by above).
    jefe_rows = [(m, p, t) for m, p, t in rows if _person_is_jefe_de_servicio(p)]
    own = [r for r in jefe_rows if r[2].id == ctx.tenant.id]
    if own:
        return own[0]
    if jefe_rows:
        return jefe_rows[0]
    return None


def _resolve_centralised_reviewer(ctx: RequestContext) -> int | None:
    """When the caller's servicio has bloqueo_routing_mode =
    'centralised' AND a jefe currently exists, return their
    membership id (this is who will review every new bloqueo).
    Returns None — meaning "fall back to delegated for this
    request" — when the servicio is in delegated mode OR no jefe
    is currently in place. Read at create-bloqueo time only;
    existing pending bloqueos are not retargeted on mode flips."""
    if ctx.tenant.servicio_id is None:
        return None
    from app.models import Servicio  # local to avoid cycle in module header

    servicio = ctx.db.get(Servicio, ctx.tenant.servicio_id)
    if servicio is None or servicio.bloqueo_routing_mode != "centralised":
        return None
    resolved = _resolve_servicio_jefe(ctx)
    return resolved[0].id if resolved is not None else None


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
                    # Membership.roles is the generic sqlalchemy ARRAY;
                    # `.contains()` raises NotImplementedError on it.
                    # Use Postgres' native @> operator via .op() so we
                    # don't have to change the model's column type.
                    Membership.roles.op("@>")(["admin"]),
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
                # See the standalone-tenant branch above for why .op("@>")
                # instead of .contains() — generic ARRAY type doesn't
                # implement the latter.
                Membership.roles.op("@>")(["admin"]),
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
    response_model=ServicioAdminPickerOut,
)
def list_my_servicio_admins(
    ctx: RequestContext = Depends(get_current_context),
) -> ServicioAdminPickerOut:
    """Picker source for the bloqueo reviewer dropdown on
    /me/bloqueos.

    Returns the servicio's routing mode plus the candidate admin
    list:
      - 'delegated' (or no servicio): every admin across approved
        equipos, caller's own equipo first.
      - 'centralised' WITH a jefe currently in place: collapses to
        just the jefe so the picker UI renders a read-only "Se
        enviará a X" line.
      - 'centralised' but no jefe currently in place: falls back
        to the delegated list so the member can still raise a
        bloqueo. The frontend treats mode='delegated' as the
        canonical "show the picker" signal.
    """
    mode: str = "delegated"
    if ctx.tenant.servicio_id is not None:
        from app.models import Servicio  # local import to avoid cycle

        servicio = ctx.db.get(Servicio, ctx.tenant.servicio_id)
        if servicio is not None:
            mode = servicio.bloqueo_routing_mode
    if mode == "centralised":
        resolved = _resolve_servicio_jefe(ctx)
        if resolved is not None:
            m, p, t = resolved
            return ServicioAdminPickerOut(
                mode="centralised",
                admins=[
                    ServicioAdminOut(
                        membership_id=m.id,
                        person_id=p.id,
                        person_name=p.name,
                        tenant_id=t.id,
                        tenant_name=t.name,
                        is_own_tenant=(t.id == ctx.tenant.id),
                    )
                ],
            )
        # Centralised but no jefe — UI sees mode='delegated' and
        # the full picker reappears (matches the fall-back at
        # create-bloqueo time).
        return ServicioAdminPickerOut(
            mode="delegated", admins=_list_servicio_admins(ctx)
        )
    return ServicioAdminPickerOut(
        mode="delegated", admins=_list_servicio_admins(ctx)
    )


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
