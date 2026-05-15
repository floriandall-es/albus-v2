"""Shift swap offers — team members can offer one of their published
assignments for coverage. Other members respond as "cover" (take it) or
"swap" (trade for one of their own). The asker accepts/declines.

On accept, assignments are reassigned atomically and the schedule stays
published. Solver eligibility is re-checked at accept time so a stale
offer can't violate rules.

All endpoints are auth-only (no admin gate) except /admin/swaps which
exposes the read-only audit log.
"""

from __future__ import annotations

import logging
from datetime import date as date_t, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy.exc import IntegrityError

from app.core.config import settings
from app.models import (
    Assignment,
    Membership,
    Person,
    Schedule,
    ShiftSwapOffer,
    ShiftSwapResponse,
    Slot,
    SlotTeamRole,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.shift_swap import (
    AssignmentSummary,
    CreateOfferRequest,
    CreateResponseRequest,
    SwapOfferOut,
    SwapResponseOut,
)
from app.services.email import send_email
from app.services.email_templates import (
    format_spanish_date,
    swap_accepted_email,
    swap_admin_notification_email,
    swap_offer_created_email,
    swap_response_email,
)
from app.services.scheduler import slots_overlap_in_time

logger = logging.getLogger("app.shift_swaps")
router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _assignment_or_404(ctx: RequestContext, assignment_id: int) -> Assignment:
    a = ctx.db.get(Assignment, assignment_id)
    if not a or a.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Asignación no encontrada")
    return a


def _offer_or_404(ctx: RequestContext, offer_id: int) -> ShiftSwapOffer:
    o = ctx.db.get(ShiftSwapOffer, offer_id)
    if not o or o.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Solicitud no encontrada")
    return o


def _response_or_404(
    ctx: RequestContext, offer: ShiftSwapOffer, response_id: int
) -> ShiftSwapResponse:
    r = ctx.db.get(ShiftSwapResponse, response_id)
    if not r or r.tenant_id != ctx.tenant.id or r.offer_id != offer.id:
        raise HTTPException(status_code=404, detail="Respuesta no encontrada")
    return r


def _membership_for_person(
    ctx: RequestContext, person_id: int
) -> Membership | None:
    """Find the (current-tenant) membership for a person_id."""
    return (
        ctx.db.query(Membership)
        .filter(Membership.person_id == person_id)
        .first()
    )


def _summarize_assignment(
    ctx: RequestContext, a: Assignment
) -> AssignmentSummary:
    slot = ctx.db.get(Slot, a.slot_id)
    person = (
        ctx.db.get(Person, a.person_id) if a.person_id is not None else None
    )
    role_label: str | None = None
    if a.team_role_id is not None:
        role = ctx.db.get(SlotTeamRole, a.team_role_id)
        role_label = role.role_label if role else None
    return AssignmentSummary(
        id=a.id,
        schedule_id=a.schedule_id,
        date=a.date,
        slot_id=a.slot_id,
        slot_name=slot.name if slot else f"#{a.slot_id}",
        person_id=a.person_id,
        person_name=person.name if person else None,
        team_role_label=role_label,
    )


def _serialize_response(
    ctx: RequestContext, r: ShiftSwapResponse
) -> SwapResponseOut:
    responder_m = ctx.db.get(Membership, r.responder_membership_id)
    responder_person = (
        ctx.db.get(Person, responder_m.person_id) if responder_m else None
    )
    swap_assignment_out: AssignmentSummary | None = None
    if r.swap_assignment_id is not None:
        sa = ctx.db.get(Assignment, r.swap_assignment_id)
        if sa is not None:
            swap_assignment_out = _summarize_assignment(ctx, sa)
    return SwapResponseOut(
        id=r.id,
        offer_id=r.offer_id,
        responder_membership_id=r.responder_membership_id,
        responder_person_id=responder_m.person_id if responder_m else 0,
        responder_person_name=(
            responder_person.name if responder_person else "?"
        ),
        kind=r.kind,  # type: ignore[arg-type]
        swap_assignment=swap_assignment_out,
        status=r.status,  # type: ignore[arg-type]
        notes=r.notes,
        created_at=r.created_at,
        decided_at=r.decided_at,
    )


def _serialize_offer(
    ctx: RequestContext, o: ShiftSwapOffer
) -> SwapOfferOut:
    a = ctx.db.get(Assignment, o.assignment_id)
    if a is None:
        raise HTTPException(status_code=500, detail="Asignación huérfana")
    requester_m = ctx.db.get(Membership, o.requested_by_membership_id)
    requester_person = (
        ctx.db.get(Person, requester_m.person_id) if requester_m else None
    )
    responses = (
        ctx.db.query(ShiftSwapResponse)
        .filter(ShiftSwapResponse.offer_id == o.id)
        .order_by(ShiftSwapResponse.created_at)
        .all()
    )
    return SwapOfferOut(
        id=o.id,
        tenant_id=o.tenant_id,
        assignment=_summarize_assignment(ctx, a),
        requested_by_membership_id=o.requested_by_membership_id,
        requested_by_person_id=requester_m.person_id if requester_m else 0,
        requested_by_person_name=(
            requester_person.name if requester_person else "?"
        ),
        status=o.status,  # type: ignore[arg-type]
        notes=o.notes,
        created_at=o.created_at,
        closed_at=o.closed_at,
        responses=[_serialize_response(ctx, r) for r in responses],
    )


def _check_eligibility_for_slot(
    ctx: RequestContext, person_id: int, target: Assignment
) -> str | None:
    """Mirror of scheduler eligibility. Returns reason or None.

    Checks pool membership, hard skills, availability blocks, AND
    cross-slot time-overlap against other assignments the person
    already has on that date or the adjacent one.
    """
    slot = ctx.db.get(Slot, target.slot_id)
    if slot is None:
        return "Turno no encontrado"

    # Build a minimal scheduler context for the period and use its
    # eligibility check — keeps the rules in lockstep with the solver.
    from app.services.scheduler import _Context  # local import to avoid cycle

    period = date_t(target.date.year, target.date.month, 1)
    sched_ctx = _Context(ctx.db, ctx.tenant.id, period)
    reason = sched_ctx.eligibility_reason(
        person_id, slot, target.date, target.team_role_id
    )
    if reason:
        return reason

    # Time overlap with other PUBLISHED assignments the person already
    # holds on adjacent days. Drafts don't count — the published
    # schedule is what matters once a swap fulfils.
    nearby = (
        ctx.db.query(Assignment, Schedule)
        .join(Schedule, Schedule.id == Assignment.schedule_id)
        .filter(
            Assignment.person_id == person_id,
            Schedule.status == "published",
            Assignment.id != target.id,
            Assignment.date.between(
                target.date - _ONE_DAY, target.date + _ONE_DAY
            ),
        )
        .all()
    )
    for other, _sched in nearby:
        other_slot = ctx.db.get(Slot, other.slot_id)
        if other_slot is None:
            continue
        if slots_overlap_in_time(slot, target.date, other_slot, other.date):
            return (
                f"Solape horario con otro turno asignado el "
                f"{other.date.isoformat()}"
            )
    return None


from datetime import timedelta as _td

_ONE_DAY = _td(days=1)


def _published_or_400(ctx: RequestContext, a: Assignment) -> None:
    s = ctx.db.get(Schedule, a.schedule_id)
    if s is None or s.status != "published":
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden cambiar turnos de planificaciones publicadas",
        )


# ---------------------------------------------------------------------------
# User-facing endpoints
# ---------------------------------------------------------------------------


@router.post(
    "/swap-offers",
    response_model=SwapOfferOut,
    status_code=status.HTTP_201_CREATED,
)
def create_offer(
    payload: CreateOfferRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapOfferOut:
    a = _assignment_or_404(ctx, payload.assignment_id)
    if a.person_id != ctx.person.id:
        raise HTTPException(
            status_code=403,
            detail="Solo puedes ofrecer tus propios turnos",
        )
    _published_or_400(ctx, a)
    if a.locked_at is not None:
        raise HTTPException(
            status_code=400,
            detail="Este turno está bloqueado por el admin",
        )

    obj = ShiftSwapOffer(
        tenant_id=ctx.tenant.id,
        assignment_id=a.id,
        requested_by_membership_id=ctx.membership.id,
        status="open",
        notes=payload.notes,
    )
    ctx.db.add(obj)
    try:
        ctx.db.flush()
    except IntegrityError:
        ctx.db.rollback()
        raise HTTPException(
            status_code=409,
            detail="Ya hay una solicitud abierta para este turno",
        )

    # Email every active member of the tenant EXCEPT the requester.
    _notify_offer_created(ctx, obj, a)
    return _serialize_offer(ctx, obj)


@router.get("/swap-offers", response_model=list[SwapOfferOut])
def list_offers(
    status_: str | None = None,
    mine: bool = False,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SwapOfferOut]:
    """List swap offers. By default returns open offers (anywhere in
    tenant) plus any of the user's own offers regardless of status.
    `status` query param filters by status; `mine=true` limits to user's
    own offers."""
    q = ctx.db.query(ShiftSwapOffer)
    if status_:
        q = q.filter(ShiftSwapOffer.status == status_)
    if mine:
        q = q.filter(
            ShiftSwapOffer.requested_by_membership_id == ctx.membership.id
        )
    rows = q.order_by(ShiftSwapOffer.created_at.desc()).all()
    return [_serialize_offer(ctx, o) for o in rows]


@router.post(
    "/swap-offers/{offer_id}/cancel", response_model=SwapOfferOut
)
def cancel_offer(
    offer_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapOfferOut:
    o = _offer_or_404(ctx, offer_id)
    if o.requested_by_membership_id != ctx.membership.id:
        raise HTTPException(status_code=403, detail="No es tu solicitud")
    if o.status != "open":
        raise HTTPException(status_code=400, detail="La solicitud ya está cerrada")
    o.status = "cancelled"
    o.closed_at = datetime.now(timezone.utc)
    # Mark all pending responses as withdrawn.
    for r in ctx.db.query(ShiftSwapResponse).filter(
        ShiftSwapResponse.offer_id == o.id,
        ShiftSwapResponse.status == "pending",
    ):
        r.status = "withdrawn"
        r.decided_at = o.closed_at
    ctx.db.flush()
    return _serialize_offer(ctx, o)


@router.post(
    "/swap-offers/{offer_id}/respond",
    response_model=SwapResponseOut,
    status_code=status.HTTP_201_CREATED,
)
def respond_to_offer(
    offer_id: int,
    payload: CreateResponseRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapResponseOut:
    o = _offer_or_404(ctx, offer_id)
    if o.status != "open":
        raise HTTPException(status_code=400, detail="La solicitud no está abierta")
    if o.requested_by_membership_id == ctx.membership.id:
        raise HTTPException(
            status_code=400, detail="No puedes responder a tu propia solicitud"
        )

    if payload.kind == "swap" and payload.swap_assignment_id is None:
        raise HTTPException(
            status_code=400,
            detail="Para un cambio debes ofrecer un turno propio",
        )
    if payload.kind == "cover" and payload.swap_assignment_id is not None:
        raise HTTPException(
            status_code=400,
            detail="Para cubrir no se ofrece otro turno",
        )

    swap_assignment = None
    if payload.kind == "swap":
        swap_assignment = _assignment_or_404(ctx, payload.swap_assignment_id)  # type: ignore[arg-type]
        if swap_assignment.person_id != ctx.person.id:
            raise HTTPException(
                status_code=400,
                detail="Solo puedes ofrecer tus propios turnos",
            )
        _published_or_400(ctx, swap_assignment)
        if swap_assignment.locked_at is not None:
            raise HTTPException(
                status_code=400,
                detail="Tu turno está bloqueado por el admin",
            )

    r = ShiftSwapResponse(
        tenant_id=ctx.tenant.id,
        offer_id=o.id,
        responder_membership_id=ctx.membership.id,
        kind=payload.kind,
        swap_assignment_id=(
            swap_assignment.id if swap_assignment else None
        ),
        status="pending",
        notes=payload.notes,
    )
    ctx.db.add(r)
    ctx.db.flush()

    _notify_response_created(ctx, o, r)
    return _serialize_response(ctx, r)


@router.post(
    "/swap-offers/{offer_id}/responses/{response_id}/accept",
    response_model=SwapOfferOut,
)
def accept_response(
    offer_id: int,
    response_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapOfferOut:
    o = _offer_or_404(ctx, offer_id)
    if o.requested_by_membership_id != ctx.membership.id:
        raise HTTPException(status_code=403, detail="No es tu solicitud")
    if o.status != "open":
        raise HTTPException(status_code=400, detail="La solicitud ya está cerrada")

    r = _response_or_404(ctx, o, response_id)
    if r.status != "pending":
        raise HTTPException(
            status_code=400, detail="Esta respuesta ya está decidida"
        )

    original = _assignment_or_404(ctx, o.assignment_id)
    responder_m = ctx.db.get(Membership, r.responder_membership_id)
    if responder_m is None:
        raise HTTPException(status_code=400, detail="Respondedor inválido")

    # Re-check eligibility AT ACCEPT TIME — the schedule may have changed.
    reason = _check_eligibility_for_slot(
        ctx, responder_m.person_id, original
    )
    if reason:
        raise HTTPException(
            status_code=400,
            detail=f"El respondedor ya no es elegible: {reason}",
        )

    if r.kind == "swap":
        if r.swap_assignment_id is None:
            raise HTTPException(
                status_code=500, detail="Swap response sin asignación destino"
            )
        their_assignment = _assignment_or_404(ctx, r.swap_assignment_id)
        if their_assignment.person_id != responder_m.person_id:
            raise HTTPException(
                status_code=400,
                detail="El turno propuesto ya no pertenece al respondedor",
            )
        # Reverse check: asker must be eligible for responder's slot.
        reverse_reason = _check_eligibility_for_slot(
            ctx, ctx.person.id, their_assignment
        )
        if reverse_reason:
            raise HTTPException(
                status_code=400,
                detail=f"No eres elegible para su turno: {reverse_reason}",
            )
        # Swap the person_ids.
        original.person_id = responder_m.person_id
        their_assignment.person_id = ctx.person.id
        original.notes = (
            (original.notes or "")
            + f" [swap #{o.id}]"
        ).strip()
        their_assignment.notes = (
            (their_assignment.notes or "")
            + f" [swap #{o.id}]"
        ).strip()
    else:
        # Cover: responder takes the assignment.
        original.person_id = responder_m.person_id
        original.notes = (
            (original.notes or "")
            + f" [cubierto via swap #{o.id}]"
        ).strip()

    now = datetime.now(timezone.utc)
    r.status = "accepted"
    r.decided_at = now
    o.status = "fulfilled"
    o.closed_at = now

    # Decline all other pending responses on this offer.
    others = (
        ctx.db.query(ShiftSwapResponse)
        .filter(
            ShiftSwapResponse.offer_id == o.id,
            ShiftSwapResponse.status == "pending",
            ShiftSwapResponse.id != r.id,
        )
        .all()
    )
    for other in others:
        other.status = "declined"
        other.decided_at = now

    ctx.db.flush()

    _notify_response_accepted(ctx, o, r, original)
    _notify_admins(ctx, o, r, original)
    return _serialize_offer(ctx, o)


@router.post(
    "/swap-offers/{offer_id}/responses/{response_id}/decline",
    response_model=SwapResponseOut,
)
def decline_response(
    offer_id: int,
    response_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapResponseOut:
    o = _offer_or_404(ctx, offer_id)
    if o.requested_by_membership_id != ctx.membership.id:
        raise HTTPException(status_code=403, detail="No es tu solicitud")
    r = _response_or_404(ctx, o, response_id)
    if r.status != "pending":
        raise HTTPException(status_code=400, detail="Ya decidida")
    r.status = "declined"
    r.decided_at = datetime.now(timezone.utc)
    ctx.db.flush()
    return _serialize_response(ctx, r)


@router.post(
    "/swap-offers/{offer_id}/responses/{response_id}/withdraw",
    response_model=SwapResponseOut,
)
def withdraw_response(
    offer_id: int,
    response_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapResponseOut:
    o = _offer_or_404(ctx, offer_id)
    r = _response_or_404(ctx, o, response_id)
    if r.responder_membership_id != ctx.membership.id:
        raise HTTPException(status_code=403, detail="No es tu respuesta")
    if r.status != "pending":
        raise HTTPException(status_code=400, detail="Ya decidida")
    r.status = "withdrawn"
    r.decided_at = datetime.now(timezone.utc)
    ctx.db.flush()
    return _serialize_response(ctx, r)


# ---------------------------------------------------------------------------
# Email notifications
# ---------------------------------------------------------------------------


def _shift_label(a: Assignment, slot: Slot | None) -> tuple[str, str]:
    return (
        slot.name if slot else f"#{a.slot_id}",
        format_spanish_date(datetime(a.date.year, a.date.month, a.date.day)),
    )


def _notify_offer_created(
    ctx: RequestContext, offer: ShiftSwapOffer, original: Assignment
) -> None:
    slot = ctx.db.get(Slot, original.slot_id)
    requester = ctx.db.get(Person, ctx.person.id)
    slot_name, shift_date = _shift_label(original, slot)
    requester_name = requester.name if requester else "Un compañero"
    # Email every membership in this tenant except the requester.
    recipients = (
        ctx.db.query(Person)
        .join(Membership, Membership.person_id == Person.id)
        .filter(Membership.id != ctx.membership.id)
        .all()
    )
    for p in recipients:
        subject, body = swap_offer_created_email(
            recipient_name=p.name,
            requester_name=requester_name,
            slot_name=slot_name,
            shift_date=shift_date,
            notes=offer.notes,
            app_url=settings.public_base_url,
        )
        send_email(p.email, subject, body)


def _notify_response_created(
    ctx: RequestContext,
    offer: ShiftSwapOffer,
    response: ShiftSwapResponse,
) -> None:
    original = ctx.db.get(Assignment, offer.assignment_id)
    if original is None:
        return
    slot = ctx.db.get(Slot, original.slot_id)
    slot_name, shift_date = _shift_label(original, slot)
    requester_m = ctx.db.get(Membership, offer.requested_by_membership_id)
    if requester_m is None:
        return
    requester = ctx.db.get(Person, requester_m.person_id)
    if requester is None:
        return
    responder = ctx.db.get(Person, ctx.person.id)
    responder_name = responder.name if responder else "Un compañero"

    swap_slot_name = None
    swap_date = None
    if response.kind == "swap" and response.swap_assignment_id is not None:
        sa = ctx.db.get(Assignment, response.swap_assignment_id)
        if sa is not None:
            sa_slot = ctx.db.get(Slot, sa.slot_id)
            sa_slot_name, sa_date = _shift_label(sa, sa_slot)
            swap_slot_name = sa_slot_name
            swap_date = sa_date

    subject, body = swap_response_email(
        requester_name=requester.name,
        responder_name=responder_name,
        kind=response.kind,
        slot_name=slot_name,
        shift_date=shift_date,
        swap_slot_name=swap_slot_name,
        swap_date=swap_date,
        notes=response.notes,
        app_url=settings.public_base_url,
    )
    send_email(requester.email, subject, body)


def _notify_response_accepted(
    ctx: RequestContext,
    offer: ShiftSwapOffer,
    response: ShiftSwapResponse,
    original: Assignment,
) -> None:
    slot = ctx.db.get(Slot, original.slot_id)
    slot_name, shift_date = _shift_label(original, slot)
    responder_m = ctx.db.get(Membership, response.responder_membership_id)
    if responder_m is None:
        return
    responder = ctx.db.get(Person, responder_m.person_id)
    requester = ctx.db.get(Person, ctx.person.id)
    if responder is None or requester is None:
        return
    subject, body = swap_accepted_email(
        responder_name=responder.name,
        requester_name=requester.name,
        kind=response.kind,
        slot_name=slot_name,
        shift_date=shift_date,
        app_url=settings.public_base_url,
    )
    send_email(responder.email, subject, body)


def _notify_admins(
    ctx: RequestContext,
    offer: ShiftSwapOffer,
    response: ShiftSwapResponse,
    original: Assignment,
) -> None:
    slot = ctx.db.get(Slot, original.slot_id)
    slot_name, shift_date = _shift_label(original, slot)
    responder_m = ctx.db.get(Membership, response.responder_membership_id)
    responder = (
        ctx.db.get(Person, responder_m.person_id) if responder_m else None
    )
    requester = ctx.db.get(Person, ctx.person.id)
    if not responder or not requester:
        return

    # Membership.roles is a generic ARRAY(String), which doesn't support
    # SQLAlchemy's .contains() — that's only on postgresql.ARRAY. Fetch all
    # memberships and filter in Python. Cheap: typical tenant has handfuls
    # of memberships.
    admin_persons: list[Person] = []
    for m, p in (
        ctx.db.query(Membership, Person)
        .join(Person, Person.id == Membership.person_id)
        .all()
    ):
        if "admin" in (m.roles or []):
            admin_persons.append(p)
    for admin_p in admin_persons:
        subject, body = swap_admin_notification_email(
            admin_name=admin_p.name,
            requester_name=requester.name,
            responder_name=responder.name,
            kind=response.kind,
            slot_name=slot_name,
            shift_date=shift_date,
            app_url=settings.public_base_url,
        )
        send_email(admin_p.email, subject, body)


# ---------------------------------------------------------------------------
# Admin audit endpoint
# ---------------------------------------------------------------------------


@router.get("/admin/swaps", response_model=list[SwapOfferOut])
def admin_audit_log(
    ctx: RequestContext = Depends(get_current_context),
) -> list[SwapOfferOut]:
    """Admin-only read-only view of all swap offers in the tenant."""
    if "admin" not in ctx.membership.roles:
        raise HTTPException(status_code=403, detail="Admin role required")
    rows = (
        ctx.db.query(ShiftSwapOffer)
        .order_by(ShiftSwapOffer.created_at.desc())
        .all()
    )
    return [_serialize_offer(ctx, o) for o in rows]
