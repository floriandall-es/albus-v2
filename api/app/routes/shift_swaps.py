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
    SlotAllowedPerson,
    SlotCategory,
    SlotTeamRole,
    SlotTeamRoleCategory,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.shift_swap import (
    AdminVetoRequest,
    AssignmentSummary,
    CreateOfferRequest,
    CreateResponseRequest,
    SwapOfferOut,
    SwapResponseOut,
)
from app.services.email import send_email, should_email_person
from app.services.notifications import (
    EmailPayload,
    PushPayload,
    try_push_or_email,
)
from app.services.email_templates import (
    format_spanish_date,
    swap_accepted_email,
    swap_admin_notification_email,
    swap_admin_pending_approval_email,
    swap_offer_created_email,
    swap_response_email,
    swap_vetoed_email,
)
from app.services.scheduler import slots_overlap_in_time
from app.services.violations import (
    Violation,
    find_violations,
    violation_signature,
)

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


def _month_range(d: date_t) -> tuple[date_t, date_t]:
    """First and last day of d's month (inclusive)."""
    from datetime import timedelta
    first = date_t(d.year, d.month, 1)
    if d.month == 12:
        next_first = date_t(d.year + 1, 1, 1)
    else:
        next_first = date_t(d.year, d.month + 1, 1)
    last = next_first - timedelta(days=1)
    return first, last


def _swap_count_for_person_in_month(
    ctx: RequestContext, person_id: int, period_date: date_t
) -> int:
    """Count fulfilled swap offers this person REQUESTED, scoped to
    the month of the original assignment. Used to enforce
    `tenant.max_swaps_per_member_per_month` at offer / accept time
    and surface usage via /api/me/swap-quota.

    Only the requester is charged a cambio — the responder is doing
    a favour and shouldn't be penalised for helping. Customers asked
    for this so a colleague who often covers for others doesn't
    burn through their own monthly quota.
    """
    first, last = _month_range(period_date)
    rows = (
        ctx.db.query(ShiftSwapOffer.id)
        .join(
            Membership,
            Membership.id == ShiftSwapOffer.requested_by_membership_id,
        )
        .join(Assignment, Assignment.id == ShiftSwapOffer.assignment_id)
        .filter(
            ShiftSwapOffer.tenant_id == ctx.tenant.id,
            ShiftSwapOffer.status == "fulfilled",
            Membership.person_id == person_id,
            Assignment.date >= first,
            Assignment.date <= last,
        )
        .all()
    )
    return len(rows)


def _enforce_swap_quota(
    ctx: RequestContext, person_id: int, period_date: date_t, label: str
) -> None:
    """Raise 400 when accepting this swap would push `person_id` past
    the tenant's per-month cap. `label` is used in the error message
    (e.g. "tú" or last-name) so the UI can show which side is over.
    """
    limit = ctx.tenant.max_swaps_per_member_per_month
    if limit is None:
        return
    used = _swap_count_for_person_in_month(ctx, person_id, period_date)
    if used >= limit:
        raise HTTPException(
            status_code=400,
            detail=(
                f"{label} ya ha alcanzado el límite de {limit} "
                f"cambios para {period_date.strftime('%Y-%m')}."
            ),
        )


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
    # Migration 0084. Look up the deciding admin's display name for
    # the audit trail. Cheap (single get); skipped entirely when no
    # admin decision was recorded.
    admin_person_name: str | None = None
    if o.admin_decided_by_membership_id is not None:
        admin_m = ctx.db.get(Membership, o.admin_decided_by_membership_id)
        if admin_m is not None:
            admin_p = ctx.db.get(Person, admin_m.person_id)
            if admin_p is not None:
                admin_person_name = admin_p.name
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
        audience_membership_ids=(
            list(o.audience_membership_ids)
            if o.audience_membership_ids is not None
            else None
        ),
        accepts=o.accepts,  # type: ignore[arg-type]
        admin_decided_at=o.admin_decided_at,
        admin_decided_by_membership_id=o.admin_decided_by_membership_id,
        admin_decided_by_person_name=admin_person_name,
        admin_decision_notes=o.admin_decision_notes,
        responses=[_serialize_response(ctx, r) for r in responses],
    )


from datetime import timedelta as _td

_ONE_DAY = _td(days=1)


def _check_eligibility_for_slot(
    ctx: RequestContext,
    person_id: int,
    target: Assignment,
    *,
    exclude_assignment_ids: set[int] | None = None,
) -> str | None:
    """Mirror of scheduler eligibility for a single person × slot × date.
    Returns a Spanish reason if the person CAN'T take the assignment,
    None if they can. Used at accept-time to reject swaps that would
    violate solver constraints.

    Covers:
    - pool membership, hard skills, availability blocks (via scheduler)
    - time-overlap with other PUBLISHED assignments on adjacent days
    - post_slot_rest (yesterday's slot rests today, or today's rests
      tomorrow and that conflicts)
    - same-slot/date duplicate (same person already on this slot+date)
    - same-day succession-rule (days_after=0) incompatibilities

    `exclude_assignment_ids` lets the caller drop assignments that are
    going AWAY in the swap (otherwise they'd self-conflict).
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

    excluded = exclude_assignment_ids or set()

    # All of this person's other PUBLISHED assignments on D-1, D, D+1.
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
        if other.id in excluded:
            continue
        other_slot = ctx.db.get(Slot, other.slot_id)
        if other_slot is None:
            continue
        # Same slot+date duplicate (e.g. team_composition with two roles)
        if other.slot_id == target.slot_id and other.date == target.date:
            return (
                f"Ya tienes este turno asignado el "
                f"{target.date.isoformat()}"
            )
        # Time overlap.
        if slots_overlap_in_time(slot, target.date, other_slot, other.date):
            return (
                f"Solape horario con {other_slot.name} el "
                f"{other.date.isoformat()}"
            )
        # post_slot_rest: if THIS new slot has rest=True, person can't
        # have ANY shift the next day. If a PRIOR slot has rest=True,
        # person can't have THIS shift the next day.
        if slot.post_slot_rest and other.date == target.date + _ONE_DAY:
            return (
                f"Este turno requiere descanso al día siguiente, "
                f"y ya estás asignado al "
                f"{other.date.isoformat()}"
            )
        if other_slot.post_slot_rest and other.date == target.date - _ONE_DAY:
            return (
                f"El turno del {other.date.isoformat()} requiere "
                f"descanso al día siguiente"
            )

    # Same-day succession rules (days_after=0). The solver enforces
    # these as hard constraints when severity='hard'; swaps must too.
    from app.models import SlotSuccessionRule  # noqa: WPS433

    same_day_rules = (
        ctx.db.query(SlotSuccessionRule)
        .filter(
            SlotSuccessionRule.applies_to == "same_person",
            SlotSuccessionRule.days_after == 0,
            SlotSuccessionRule.severity == "hard",
        )
        .all()
    )
    if same_day_rules:
        # All of person's PUBLISHED assignments same date (excluding
        # target itself + excluded list).
        same_date = (
            ctx.db.query(Assignment, Schedule)
            .join(Schedule, Schedule.id == Assignment.schedule_id)
            .filter(
                Assignment.person_id == person_id,
                Schedule.status == "published",
                Assignment.id != target.id,
                Assignment.date == target.date,
            )
            .all()
        )
        other_slot_ids = {
            a.slot_id for a, _s in same_date if a.id not in excluded
        }
        for r in same_day_rules:
            if (
                r.after_slot_id == target.slot_id
                and r.forbid_slot_id in other_slot_ids
            ) or (
                r.forbid_slot_id == target.slot_id
                and r.after_slot_id in other_slot_ids
            ):
                other_slot = ctx.db.get(
                    Slot,
                    r.forbid_slot_id
                    if r.after_slot_id == target.slot_id
                    else r.after_slot_id,
                )
                other_name = other_slot.name if other_slot else "otro turno"
                return (
                    f"Regla del mismo día: no se puede combinar con "
                    f"{other_name}"
                )

    return None


def _eligible_membership_ids_for_assignment(
    ctx: RequestContext, a: Assignment
) -> set[int]:
    """Membership ids that are configured to cover this assignment's
    slot — used to narrow the swap-offer audience.

    Honours the *static* slot configuration only:
      - SlotAllowedPerson (per-slot allow-list)
      - SlotCategory (per-slot categoría restriction)
      - SlotTeamRoleCategory (per-role categoría restriction, only
        when the assignment has a team_role_id)

    Deliberately *does not* check availability blocks, schedule
    conflicts, or quotas: those are about "can take it on this
    specific date" and are re-checked at accept time (see
    `_check_eligibility_for_slot`). The audience picker only wants
    to hide people the admin never authorised to touch this turno —
    an "Equipo autorizado" allow-list should be respected, the slot
    categoría restriction filters out incompatible categorías, etc.
    """
    # Per-slot allow-list. NULL/empty set = no restriction.
    allowed_persons: set[int] = {
        row[0]
        for row in ctx.db.query(SlotAllowedPerson.person_id)
        .filter(SlotAllowedPerson.slot_id == a.slot_id)
        .all()
    }
    # Per-slot categoría restriction.
    slot_cats: set[int] = {
        row[0]
        for row in ctx.db.query(SlotCategory.category_id)
        .filter(SlotCategory.slot_id == a.slot_id)
        .all()
    }
    # Per-role categoría restriction (only when the assignment is a
    # team_composition role).
    role_cats: set[int] = set()
    if a.team_role_id is not None:
        role_cats = {
            row[0]
            for row in ctx.db.query(SlotTeamRoleCategory.category_id)
            .filter(
                SlotTeamRoleCategory.slot_team_role_id == a.team_role_id
            )
            .all()
        }

    q = ctx.db.query(
        Membership.id, Membership.person_id, Membership.category_id
    ).filter(
        Membership.tenant_id == ctx.tenant.id,
        Membership.disabled_at.is_(None),
    )
    rows = q.all()
    out: set[int] = set()
    for mid, pid, cid in rows:
        if allowed_persons and pid not in allowed_persons:
            continue
        if slot_cats and cid not in slot_cats:
            continue
        if role_cats and cid not in role_cats:
            continue
        out.add(mid)
    return out


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

    # If the tenant has a monthly cap, refuse to open an offer the
    # requester wouldn't be able to accept anyway. Strictly a UX
    # courtesy — the accept path re-enforces the cap (the requester
    # could otherwise hit it via parallel offers).
    _enforce_swap_quota(
        ctx, ctx.person.id, a.date, ctx.person.last_name or ctx.person.name or "Tú"
    )

    # Resolve the optional audience. We validate that every id
    # belongs to the same tenant (no cross-tenant smuggling) and
    # de-dupe. We also drop the requester's own membership id if
    # they accidentally included themselves — they can't respond
    # to their own offer anyway, so including them just sends a
    # confusing "you have a new request" email to themselves.
    audience_ids: list[int] | None = None
    if payload.audience_membership_ids is not None:
        if not payload.audience_membership_ids:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Selecciona al menos una persona a la que enviar la "
                    "solicitud."
                ),
            )
        requested = {
            int(i) for i in payload.audience_membership_ids
            if int(i) != ctx.membership.id
        }
        if not requested:
            raise HTTPException(
                status_code=422,
                detail=(
                    "La audiencia no puede ser sólo tú — incluye al menos "
                    "una persona del equipo."
                ),
            )
        valid = {
            row[0]
            for row in ctx.db.query(Membership.id)
            .filter(
                Membership.id.in_(requested),
                Membership.tenant_id == ctx.tenant.id,
            )
            .all()
        }
        if valid != requested:
            raise HTTPException(
                status_code=422,
                detail="Algún miembro de la audiencia no es válido.",
            )
        # Restrict to people configured to cover this slot in the
        # actividad settings. The modal already filters its picker
        # to the same set, so a normal client never trips this — the
        # check exists for API clients and for safety if the slot's
        # allow-list / categoría restriction tightens between modal
        # open and submit.
        eligible = _eligible_membership_ids_for_assignment(ctx, a)
        not_eligible = valid - eligible
        if not_eligible:
            raise HTTPException(
                status_code=422,
                detail=(
                    "Algún miembro elegido no está autorizado a cubrir "
                    "este turno."
                ),
            )
        audience_ids = sorted(valid)

    obj = ShiftSwapOffer(
        tenant_id=ctx.tenant.id,
        assignment_id=a.id,
        requested_by_membership_id=ctx.membership.id,
        status="open",
        notes=payload.notes,
        audience_membership_ids=audience_ids,
        accepts=payload.accepts,
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

    # Email the audience (or every active tenant member if the
    # audience is unset — back-compat for API clients that didn't
    # send the field).
    _notify_offer_created(ctx, obj, a)
    return _serialize_offer(ctx, obj)


@router.get("/swap-offers", response_model=list[SwapOfferOut])
def list_offers(
    status_: str | None = None,
    mine: bool = False,
    ctx: RequestContext = Depends(get_current_context),
) -> list[SwapOfferOut]:
    """List swap offers. By default returns open offers visible to
    the caller plus any of the user's own offers regardless of
    status. `status` query param filters by status; `mine=true`
    limits to user's own offers.

    Visibility rules:
      - requester always sees their own offers
      - everyone else: the offer's explicit audience (migration
        0063) gates the listing. An offer with a non-null
        audience_membership_ids only surfaces to callers whose
        membership id is in the array. NULL audience = visible
        to every tenant member.
    """
    from sqlalchemy import or_

    q = ctx.db.query(ShiftSwapOffer)
    if status_:
        q = q.filter(ShiftSwapOffer.status == status_)
    if mine:
        q = q.filter(
            ShiftSwapOffer.requested_by_membership_id == ctx.membership.id
        )
    else:
        q = q.filter(
            or_(
                # Requester always sees their own.
                ShiftSwapOffer.requested_by_membership_id
                == ctx.membership.id,
                # Otherwise the explicit audience (if any) has to
                # include the caller.
                ShiftSwapOffer.audience_membership_ids.is_(None),
                ShiftSwapOffer.audience_membership_ids.any(
                    ctx.membership.id
                ),
            )
        )
    rows = q.order_by(ShiftSwapOffer.created_at.desc()).all()
    return [_serialize_offer(ctx, o) for o in rows]


@router.get(
    "/swap-offers/eligible-coverers/{assignment_id}",
    response_model=list[int],
)
def list_eligible_coverers(
    assignment_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[int]:
    """Membership ids configured to cover this assignment's slot.

    Used by the "Pedir cobertura" modal to narrow the audience
    picker — the requester can only send their offer to people the
    actividad's settings actually authorise (allow-list + slot
    categoría + role categoría). The requester's own membership is
    included if eligible; the frontend drops it from the candidate
    list before rendering.
    """
    a = _assignment_or_404(ctx, assignment_id)
    # Only the assignment's own person can ask — same scope as
    # create_offer. Avoids a fishing endpoint for "who could cover
    # X's shifts".
    if a.person_id != ctx.person.id:
        raise HTTPException(
            status_code=403,
            detail="Solo puedes consultar la audiencia de tus turnos",
        )
    return sorted(_eligible_membership_ids_for_assignment(ctx, a))


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
    # Cancellable from either 'open' or 'pending_admin'. The
    # pending_admin case lets the requester back out while the admin
    # hasn't decided yet — the staged swap simply never happens.
    if o.status not in ("open", "pending_admin"):
        raise HTTPException(status_code=400, detail="La solicitud ya está cerrada")
    o.status = "cancelled"
    o.closed_at = datetime.now(timezone.utc)
    # Mark every still-undecided response as withdrawn. Catches both
    # plain 'pending' responses on a normal cancel AND the
    # 'pending_admin' response (the one the requester had accepted)
    # when cancelling out of pending_admin.
    for r in ctx.db.query(ShiftSwapResponse).filter(
        ShiftSwapResponse.offer_id == o.id,
        ShiftSwapResponse.status.in_(("pending", "pending_admin")),
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
    # Audience gate (migration 0063). When the offer was sent to a
    # narrower group, callers outside that group get 404 — same
    # shape as "offer doesn't exist for you", which is what they
    # see in their listing too. 403 would leak the offer's
    # existence.
    if (
        o.audience_membership_ids is not None
        and ctx.membership.id not in o.audience_membership_ids
    ):
        raise HTTPException(
            status_code=404, detail="Solicitud no encontrada"
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
    # Migration 0064: enforce the requester's response-kind
    # preference. Hard-stops responses that wouldn't be useful so
    # the responder doesn't waste effort proposing something the
    # requester will inevitably decline.
    if o.accepts == "cover_only" and payload.kind != "cover":
        raise HTTPException(
            status_code=400,
            detail=(
                "Esta solicitud sólo acepta cobertura, no propuestas "
                "de cambio."
            ),
        )
    if o.accepts == "swap_only" and payload.kind != "swap":
        raise HTTPException(
            status_code=400,
            detail=(
                "Esta solicitud sólo acepta propuestas de cambio, no "
                "cobertura."
            ),
        )

    # Quota note: as of the only-requester-counts change, the
    # responder is never charged a cambio, so there's nothing to
    # enforce here. We deliberately don't gate response creation on
    # the requester's quota either — they already passed that check
    # at create_offer time and accept_response will recheck before
    # actually fulfilling. Letting the responder propose freely
    # keeps the colleague-helps-colleague flow friction-free.

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


def _finalize_swap(
    ctx: RequestContext,
    o: ShiftSwapOffer,
    r: ShiftSwapResponse,
    original: Assignment,
    responder_m: Membership,
    *,
    decided_by_membership_id: int | None = None,
    decision_notes: str | None = None,
) -> None:
    """Apply a fulfilled swap end-to-end.

    Shared between the direct-path requester accept (legacy /
    tenant-flag-off) and the admin-approve endpoint. Re-runs
    eligibility (the schedule may have shifted since the requester
    clicked accept), charges the requester's monthly quota, mutates
    the assignments, marks the response accepted + offer fulfilled,
    declines every sibling response, and fires the responder +
    admin notification emails. Raises 400 on any blocker so the
    caller can surface a clean error.

    `decided_by_membership_id` is set ONLY when this fires from the
    admin-approval path — it stamps the audit trail on the offer.
    `decision_notes` is optional admin-supplied context, also for
    the audit trail.

    The responder/requester eligibility messages reference the
    parties by name (not "tú") so the same wording works whether
    the caller is the requester (direct path) or an admin
    (approval path)."""
    requester_m = ctx.db.get(Membership, o.requested_by_membership_id)
    if requester_m is None:
        raise HTTPException(status_code=400, detail="Solicitante inválido")
    requester_p = ctx.db.get(Person, requester_m.person_id)
    responder_p = ctx.db.get(Person, responder_m.person_id)
    requester_name = (
        requester_p.last_name or requester_p.name
        if requester_p
        else "El solicitante"
    )
    responder_name = (
        responder_p.last_name or responder_p.name
        if responder_p
        else "El respondedor"
    )

    # Quota charge on the requester. Done BEFORE eligibility so the
    # admin sees the "over cap" error first if both apply — it's
    # the cheaper fix (raise the cap) vs the harder one (re-edit
    # the schedule).
    _enforce_swap_quota(
        ctx, requester_m.person_id, original.date, requester_name
    )

    # Re-check eligibility. For a SWAP each person is GIVING UP
    # their own assignment, so it shouldn't count as a self-conflict
    # for the new shift they're taking.
    swap_exclude_for_responder: set[int] = set()
    swap_exclude_for_requester: set[int] = set()
    if r.kind == "swap" and r.swap_assignment_id is not None:
        swap_exclude_for_responder.add(r.swap_assignment_id)
        swap_exclude_for_requester.add(original.id)

    reason = _check_eligibility_for_slot(
        ctx,
        responder_m.person_id,
        original,
        exclude_assignment_ids=swap_exclude_for_responder,
    )
    if reason:
        raise HTTPException(
            status_code=400,
            detail=f"{responder_name} ya no es elegible: {reason}",
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
        reverse_reason = _check_eligibility_for_slot(
            ctx,
            requester_m.person_id,
            their_assignment,
            exclude_assignment_ids=swap_exclude_for_requester,
        )
        if reverse_reason:
            raise HTTPException(
                status_code=400,
                detail=(
                    f"{requester_name} ya no es elegible para el turno "
                    f"propuesto: {reverse_reason}"
                ),
            )
        original.person_id = responder_m.person_id
        their_assignment.person_id = requester_m.person_id
        original.swap_offer_id = o.id
        their_assignment.swap_offer_id = o.id
    else:
        # Cover: responder takes the assignment.
        original.person_id = responder_m.person_id
        original.swap_offer_id = o.id

    now = datetime.now(timezone.utc)
    r.status = "accepted"
    r.decided_at = now
    o.status = "fulfilled"
    o.closed_at = now
    if decided_by_membership_id is not None:
        o.admin_decided_by_membership_id = decided_by_membership_id
        o.admin_decided_at = now
        o.admin_decision_notes = decision_notes

    # Decline every still-undecided sibling response (both 'pending'
    # and 'pending_admin' — the latter shouldn't happen at runtime
    # since only one response is in pending_admin at a time, but
    # we include it for safety).
    others = (
        ctx.db.query(ShiftSwapResponse)
        .filter(
            ShiftSwapResponse.offer_id == o.id,
            ShiftSwapResponse.status.in_(("pending", "pending_admin")),
            ShiftSwapResponse.id != r.id,
        )
        .all()
    )
    for other in others:
        other.status = "declined"
        other.decided_at = now

    ctx.db.flush()

    _notify_response_accepted(ctx, o, r, original, requester_p, responder_p)
    _notify_admins(ctx, o, r, original, requester_p, responder_p)


@router.post(
    "/swap-offers/{offer_id}/responses/{response_id}/accept",
    response_model=SwapOfferOut,
)
def accept_response(
    offer_id: int,
    response_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapOfferOut:
    """Requester picks one of the responses on their offer.

    Two paths depending on the tenant's admin-approval flag (read
    at *this* moment, not at offer-creation time):

      - flag OFF (default / legacy): runs _finalize_swap inline,
        the offer becomes 'fulfilled' immediately.
      - flag ON: stages the swap as 'pending_admin' and notifies
        admins. No assignments mutate and the requester's quota
        is NOT charged yet — both happen later, only if an admin
        clicks approve.
    """
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

    if ctx.tenant.swap_requires_admin_approval:
        # Admin-approval path. We still run eligibility + quota as a
        # courtesy filter so we don't park clearly-broken swaps in
        # the admin's queue — easier to fix at the source.
        requester_label = ctx.person.last_name or ctx.person.name or "tú"
        _enforce_swap_quota(
            ctx, ctx.person.id, original.date, requester_label
        )
        swap_exclude_for_responder: set[int] = set()
        if r.kind == "swap" and r.swap_assignment_id is not None:
            swap_exclude_for_responder.add(r.swap_assignment_id)
        reason = _check_eligibility_for_slot(
            ctx,
            responder_m.person_id,
            original,
            exclude_assignment_ids=swap_exclude_for_responder,
        )
        if reason:
            raise HTTPException(
                status_code=400,
                detail=f"El respondedor ya no es elegible: {reason}",
            )
        # Stage. Other 'pending' responses stay as-is so a veto can
        # cleanly reopen the offer and let the requester pick a
        # different colleague without re-soliciting responses.
        r.status = "pending_admin"
        o.status = "pending_admin"
        ctx.db.flush()
        _notify_admins_pending_approval(ctx, o, r, original)
        return _serialize_offer(ctx, o)

    # Legacy direct path: do everything inline.
    _finalize_swap(ctx, o, r, original, responder_m)
    return _serialize_offer(ctx, o)


@router.post(
    "/swap-offers/{offer_id}/responses/{response_id}/admin-approve",
    response_model=SwapOfferOut,
)
def admin_approve_response(
    offer_id: int,
    response_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapOfferOut:
    """Admin signs off on a pending_admin swap and applies it.

    Re-runs eligibility + quota via _finalize_swap; if anything
    has broken since the requester clicked accept the call 400s
    and the admin should veto instead (the message body explains
    what changed). On success the assignment swap fires, both
    parties are notified, and the audit trail records which admin
    decided + when.

    An admin who is the requester or responder may still approve —
    they already control assignments directly, so a separate-admin
    requirement would only deadlock single-admin teams.
    """
    if "admin" not in ctx.membership.roles:
        raise HTTPException(status_code=403, detail="Admin role required")
    o = _offer_or_404(ctx, offer_id)
    if o.status != "pending_admin":
        raise HTTPException(
            status_code=400, detail="La solicitud no está esperando aprobación"
        )
    r = _response_or_404(ctx, o, response_id)
    if r.status != "pending_admin":
        raise HTTPException(
            status_code=400, detail="Esta respuesta ya está decidida"
        )
    responder_m = ctx.db.get(Membership, r.responder_membership_id)
    if responder_m is None:
        raise HTTPException(status_code=400, detail="Respondedor inválido")
    # NOTE: an admin who is the requester or responder CAN approve. The
    # admin already has full authority over assignments (direct edit),
    # so a self-approval block adds no real protection and only
    # deadlocks single-admin teams.
    original = _assignment_or_404(ctx, o.assignment_id)
    _finalize_swap(
        ctx,
        o,
        r,
        original,
        responder_m,
        decided_by_membership_id=ctx.membership.id,
    )
    return _serialize_offer(ctx, o)


@router.post(
    "/swap-offers/{offer_id}/responses/{response_id}/admin-veto",
    response_model=SwapOfferOut,
)
def admin_veto_response(
    offer_id: int,
    response_id: int,
    payload: AdminVetoRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapOfferOut:
    """Admin rejects a pending_admin swap.

    `scope` decides what happens to the offer:
      - "response_only": this one response → 'declined', offer
        reopens to 'open' so the requester can pick another
        responder (siblings stay pending). Right call when the
        responder isn't the issue — wrong colleague for this
        shift, scheduling conflict on their side, etc.
      - "entire_offer": this response → 'declined', every
        still-pending sibling → 'declined', offer → 'vetoed'.
        Closes the door entirely. Right call when the *shift*
        shouldn't be swappable (admin needs the requester on
        this one, or the schedule is about to change).

    Like approve, an admin who is a party to the cambio may still
    decide it.
    """
    if "admin" not in ctx.membership.roles:
        raise HTTPException(status_code=403, detail="Admin role required")
    o = _offer_or_404(ctx, offer_id)
    if o.status != "pending_admin":
        raise HTTPException(
            status_code=400, detail="La solicitud no está esperando aprobación"
        )
    r = _response_or_404(ctx, o, response_id)
    if r.status != "pending_admin":
        raise HTTPException(
            status_code=400, detail="Esta respuesta ya está decidida"
        )
    responder_m = ctx.db.get(Membership, r.responder_membership_id)
    if responder_m is None:
        raise HTTPException(status_code=400, detail="Respondedor inválido")
    # Same as approve: an admin who is a party to the cambio may still
    # decide it (no separate-admin requirement).

    now = datetime.now(timezone.utc)
    r.status = "declined"
    r.decided_at = now
    o.admin_decided_by_membership_id = ctx.membership.id
    o.admin_decided_at = now
    o.admin_decision_notes = payload.notes

    other_declined_responses: list[ShiftSwapResponse] = []
    if payload.scope == "entire_offer":
        # Close the whole offer. Decline every still-pending sibling
        # too so nobody sees a stale "Aceptar" button later.
        siblings = (
            ctx.db.query(ShiftSwapResponse)
            .filter(
                ShiftSwapResponse.offer_id == o.id,
                ShiftSwapResponse.status == "pending",
                ShiftSwapResponse.id != r.id,
            )
            .all()
        )
        for other in siblings:
            other.status = "declined"
            other.decided_at = now
            other_declined_responses.append(other)
        o.status = "vetoed"
        o.closed_at = now
    else:
        # Just this response. Offer reopens so the requester can pick
        # another colleague (or cancel if there are no other options).
        o.status = "open"

    ctx.db.flush()

    original = _assignment_or_404(ctx, o.assignment_id)
    _notify_veto(
        ctx,
        o,
        r,
        original,
        scope=payload.scope,
        other_declined_responses=other_declined_responses,
        notes=payload.notes,
    )
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
    # Only fresh responses can be declined here. A 'pending_admin'
    # response is past the requester's hands (admin is reviewing it)
    # — the requester wanting to back out should cancel the offer
    # entirely, which also withdraws the pending_admin response.
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
    # Recipient set:
    #   - Audience present: only those memberships' persons.
    #   - Audience NULL (legacy): every membership in the tenant
    #     except the requester.
    # The requester is never in `audience_membership_ids` (route
    # strips them out at create time), so the "except requester"
    # filter only matters for the legacy path.
    recipients_q = ctx.db.query(Person).join(
        Membership, Membership.person_id == Person.id
    )
    if offer.audience_membership_ids is not None:
        recipients_q = recipients_q.filter(
            Membership.id.in_(offer.audience_membership_ids)
        )
    else:
        recipients_q = recipients_q.filter(
            Membership.id != ctx.membership.id
        )
    recipients = recipients_q.all()
    for p in recipients:
        subject, body = swap_offer_created_email(
            recipient_name=p.name,
            requester_name=requester_name,
            slot_name=slot_name,
            shift_date=shift_date,
            notes=offer.notes,
            app_url=settings.public_base_url,
        )
        try_push_or_email(
            p,
            push=PushPayload(
                title=f"{requester_name} pide cobertura",
                body=f"{slot_name} · {shift_date}",
                path="/me/swaps",
                tag=f"swap:offer:{offer.id}",
            ),
            email=EmailPayload(subject=subject, body=body),
        )


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
    # Push title varies by kind so a glance at the lock screen
    # tells you whether someone wants to cover (no reciprocal) or
    # swap (reciprocal): the requester will likely act on each
    # differently.
    push_title = (
        f"{responder_name} ofrece cambio"
        if response.kind == "swap"
        else f"{responder_name} cubre tu turno"
    )
    try_push_or_email(
        requester,
        push=PushPayload(
            title=push_title,
            body=f"{slot_name} · {shift_date}",
            path="/me/swaps",
            tag=f"swap:offer:{offer.id}",
        ),
        email=EmailPayload(subject=subject, body=body),
    )


def _notify_response_accepted(
    ctx: RequestContext,
    offer: ShiftSwapOffer,
    response: ShiftSwapResponse,
    original: Assignment,
    requester: Person | None = None,
    responder: Person | None = None,
) -> None:
    """Notify the responder that their offer was accepted.

    Pre-fetched `requester` and `responder` Person rows are supplied
    by _finalize_swap — needed because in the admin-approval path
    ctx.person is the admin, not the requester, so we can't infer
    them from context alone."""
    slot = ctx.db.get(Slot, original.slot_id)
    slot_name, shift_date = _shift_label(original, slot)
    if responder is None:
        responder_m = ctx.db.get(Membership, response.responder_membership_id)
        responder = (
            ctx.db.get(Person, responder_m.person_id) if responder_m else None
        )
    if requester is None:
        requester_m = ctx.db.get(Membership, offer.requested_by_membership_id)
        requester = (
            ctx.db.get(Person, requester_m.person_id) if requester_m else None
        )
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
    try_push_or_email(
        responder,
        push=PushPayload(
            title=f"{requester.name} aceptó tu propuesta",
            body=f"{slot_name} · {shift_date}",
            path="/me/swaps",
            tag=f"swap:offer:{offer.id}",
        ),
        email=EmailPayload(subject=subject, body=body),
    )


def _list_tenant_admin_persons(ctx: RequestContext) -> list[Person]:
    """Every admin in the caller's tenant. Membership.roles is a
    generic ARRAY(String), so we filter in Python — tenant
    memberships are small (handfuls)."""
    admins: list[Person] = []
    for m, p in (
        ctx.db.query(Membership, Person)
        .join(Person, Person.id == Membership.person_id)
        .all()
    ):
        if "admin" in (m.roles or []):
            admins.append(p)
    return admins


def _notify_admins(
    ctx: RequestContext,
    offer: ShiftSwapOffer,
    response: ShiftSwapResponse,
    original: Assignment,
    requester: Person | None = None,
    responder: Person | None = None,
) -> None:
    """Notify every tenant admin that a swap has fulfilled.

    Same audit-log purpose as before but takes pre-fetched parties
    so it works from both the direct path AND the admin-approval
    path (where ctx.person is the deciding admin)."""
    slot = ctx.db.get(Slot, original.slot_id)
    slot_name, shift_date = _shift_label(original, slot)
    if responder is None:
        responder_m = ctx.db.get(Membership, response.responder_membership_id)
        responder = (
            ctx.db.get(Person, responder_m.person_id) if responder_m else None
        )
    if requester is None:
        requester_m = ctx.db.get(Membership, offer.requested_by_membership_id)
        requester = (
            ctx.db.get(Person, requester_m.person_id) if requester_m else None
        )
    if not responder or not requester:
        return
    for admin_p in _list_tenant_admin_persons(ctx):
        if not should_email_person(admin_p.hashed_password):
            continue
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


def _notify_admins_pending_approval(
    ctx: RequestContext,
    offer: ShiftSwapOffer,
    response: ShiftSwapResponse,
    original: Assignment,
) -> None:
    """Tenant flag is on, requester just accepted, swap is parked
    in pending_admin — every admin gets an email saying it's their
    turn to decide. ctx.person here is the requester (this is
    always called from accept_response), so we read the requester
    directly from ctx."""
    slot = ctx.db.get(Slot, original.slot_id)
    slot_name, shift_date = _shift_label(original, slot)
    responder_m = ctx.db.get(Membership, response.responder_membership_id)
    responder = (
        ctx.db.get(Person, responder_m.person_id) if responder_m else None
    )
    requester = ctx.db.get(Person, ctx.person.id)
    if not responder or not requester:
        return
    for admin_p in _list_tenant_admin_persons(ctx):
        subject, body = swap_admin_pending_approval_email(
            admin_name=admin_p.name,
            requester_name=requester.name,
            responder_name=responder.name,
            kind=response.kind,
            slot_name=slot_name,
            shift_date=shift_date,
            app_url=settings.public_base_url,
        )
        try_push_or_email(
            admin_p,
            push=PushPayload(
                title="Cambio pendiente de aprobar",
                body=(
                    f"{requester.name} ↔ {responder.name} · "
                    f"{slot_name} · {shift_date}"
                ),
                path="/admin/swaps",
                tag=f"swap:pending:{offer.id}",
            ),
            email=EmailPayload(subject=subject, body=body),
        )


def _notify_veto(
    ctx: RequestContext,
    offer: ShiftSwapOffer,
    response: ShiftSwapResponse,
    original: Assignment,
    *,
    scope: str,
    other_declined_responses: list[ShiftSwapResponse],
    notes: str | None,
) -> None:
    """Admin vetoed a pending_admin swap — email the requester and
    the affected responders so neither is left wondering.

    With scope='entire_offer' the requester learns the cambio is
    permanently off the table; every still-pending responder also
    gets an email (they were waiting on an answer that won't come).
    With scope='response_only' only the requester + this one
    responder get told; the offer is open again so siblings stay
    relevant."""
    slot = ctx.db.get(Slot, original.slot_id)
    slot_name, shift_date = _shift_label(original, slot)
    requester_m = ctx.db.get(Membership, offer.requested_by_membership_id)
    requester = (
        ctx.db.get(Person, requester_m.person_id) if requester_m else None
    )
    responder_m = ctx.db.get(Membership, response.responder_membership_id)
    responder = (
        ctx.db.get(Person, responder_m.person_id) if responder_m else None
    )
    admin = ctx.db.get(Person, ctx.person.id)
    admin_name = admin.name if admin else "Un admin"

    def _send(p: Person | None, *, audience: str) -> None:
        if p is None:
            return
        subject, body = swap_vetoed_email(
            recipient_name=p.name,
            audience=audience,
            admin_name=admin_name,
            scope=scope,
            slot_name=slot_name,
            shift_date=shift_date,
            notes=notes,
            app_url=settings.public_base_url,
        )
        try_push_or_email(
            p,
            push=PushPayload(
                title=f"{admin_name} vetó el cambio",
                body=f"{slot_name} · {shift_date}",
                path="/me/swaps",
                tag=f"swap:veto:{offer.id}",
            ),
            email=EmailPayload(subject=subject, body=body),
        )

    _send(requester, audience="requester")
    _send(responder, audience="responder")
    if scope == "entire_offer":
        for other in other_declined_responses:
            other_m = ctx.db.get(Membership, other.responder_membership_id)
            other_p = (
                ctx.db.get(Person, other_m.person_id) if other_m else None
            )
            _send(other_p, audience="other_responder")


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


# ---------------------------------------------------------------------------
# Quota endpoint
# ---------------------------------------------------------------------------


from pydantic import BaseModel


class SwapQuotaOut(BaseModel):
    """Per-person view of swap usage in a given month.

    `limit` is the tenant's `max_swaps_per_member_per_month` (null =
    unlimited). `used` counts fulfilled offers the caller REQUESTED
    in that month — covering someone else's shift no longer charges
    the responder. The frontend uses both to render "X de N cambios
    este mes" and disable swap actions when used >= limit.
    """

    period: str  # YYYY-MM
    used: int
    limit: int | None


@router.get("/me/swap-quota", response_model=SwapQuotaOut)
def my_swap_quota(
    period: str,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapQuotaOut:
    try:
        period_date = date_t.fromisoformat(f"{period}-01")
    except ValueError as exc:
        raise HTTPException(
            status_code=422, detail="period must be YYYY-MM"
        ) from exc
    used = _swap_count_for_person_in_month(
        ctx, ctx.person.id, period_date
    )
    return SwapQuotaOut(
        period=period_date.strftime("%Y-%m"),
        used=used,
        limit=ctx.tenant.max_swaps_per_member_per_month,
    )


# ---------------------------------------------------------------------------
# Rule-violation simulation — "would applying this swap break any rules?"
# ---------------------------------------------------------------------------


class SwapSimViolation(BaseModel):
    kind: str
    message: str
    severity: str | None = None


class SwapSimulationOut(BaseModel):
    """Result of dry-running a swap through the rule engine. `violations`
    are the rule breaches the swap would NEWLY introduce (pre-existing
    conflicts are excluded). Advisory only — never blocks the swap."""

    would_violate: bool
    violations: list[SwapSimViolation]


def _simulate_swap_violations(
    ctx: RequestContext,
    o: ShiftSwapOffer,
    r: ShiftSwapResponse,
) -> list[Violation]:
    """Replay this (offer, response) through the rule engine without
    persisting, and return the violations it would NEWLY create.

    A swap only mutates `Assignment.person_id` on one (cover) or two
    (swap) rows. We snapshot the affected schedule(s)' current
    violations, apply that mutation inside a SAVEPOINT, re-run
    find_violations, roll the savepoint back, and diff by signature so
    only swap-introduced breaches survive. Cheap (find_violations is a
    few queries); safe (nothing commits)."""
    original = ctx.db.get(Assignment, o.assignment_id)
    if original is None:
        return []
    responder_m = ctx.db.get(Membership, r.responder_membership_id)
    requester_m = ctx.db.get(Membership, o.requested_by_membership_id)
    if responder_m is None or requester_m is None:
        return []

    their: Assignment | None = None
    if r.kind == "swap" and r.swap_assignment_id is not None:
        their = ctx.db.get(Assignment, r.swap_assignment_id)

    schedule_ids = {original.schedule_id}
    if their is not None:
        schedule_ids.add(their.schedule_id)
    schedules = [
        s
        for s in (ctx.db.get(Schedule, sid) for sid in schedule_ids)
        if s is not None
    ]

    # Baseline: conflicts that already exist (so we don't blame the
    # swap for pre-existing breaches).
    baseline: set[str] = set()
    for s in schedules:
        for v in find_violations(ctx.db, s):
            baseline.add(violation_signature(v))

    # Dry-run the mutation inside a savepoint, then roll back.
    after: list[Violation] = []
    sp = ctx.db.begin_nested()
    try:
        original.person_id = responder_m.person_id
        if their is not None:
            their.person_id = requester_m.person_id
        ctx.db.flush()
        for s in schedules:
            after.extend(find_violations(ctx.db, s))
    finally:
        sp.rollback()

    seen: set[str] = set()
    new_violations: list[Violation] = []
    for v in after:
        sig = violation_signature(v)
        if sig in baseline or sig in seen:
            continue
        seen.add(sig)
        new_violations.append(v)
    return new_violations


@router.get(
    "/swap-offers/{offer_id}/responses/{response_id}/simulate",
    response_model=SwapSimulationOut,
)
def simulate_swap_response(
    offer_id: int,
    response_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> SwapSimulationOut:
    """Preview the rule violations applying this response would create.

    Visible to the offer's requester (the member-accept flow) and to
    admins (the approval card). Advisory — does not change anything."""
    o = _offer_or_404(ctx, offer_id)
    is_requester = o.requested_by_membership_id == ctx.membership.id
    is_admin = "admin" in ctx.membership.roles
    if not (is_requester or is_admin):
        raise HTTPException(status_code=403, detail="No autorizado")
    r = _response_or_404(ctx, o, response_id)
    violations = _simulate_swap_violations(ctx, o, r)
    return SwapSimulationOut(
        would_violate=len(violations) > 0,
        violations=[
            SwapSimViolation(
                kind=v.kind, message=v.message, severity=v.severity
            )
            for v in violations
        ],
    )
