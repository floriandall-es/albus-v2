"""Schedule + assignment endpoints (admin-only).

Sprint 4 ships the greedy stub generator behind these endpoints. Editing
individual assignments is out of scope (Sprint 5).
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status

from app.models import (
    Assignment,
    Membership,
    Person,
    Schedule,
    Slot,
    SlotTeamRole,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.schedule import (
    AssignmentOut,
    AssignmentPatch,
    EligiblePersonOut,
    ScheduleDetail,
    ScheduleGenerateRequest,
    ScheduleOut,
)
from app.services import scheduler
from app.services.scheduler import _Context, is_eligible

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _serialize_detail(ctx: RequestContext, schedule: Schedule) -> ScheduleDetail:
    rows = (
        ctx.db.query(Assignment, Slot, Person, SlotTeamRole)
        .join(Slot, Slot.id == Assignment.slot_id)
        .outerjoin(Person, Person.id == Assignment.person_id)
        .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
        .filter(Assignment.schedule_id == schedule.id)
        .order_by(Assignment.date, Assignment.slot_id, Assignment.id)
        .all()
    )
    assignments = [
        AssignmentOut(
            id=a.id,
            schedule_id=a.schedule_id,
            slot_id=a.slot_id,
            slot_name=s.name,
            slot_color=s.color,
            date=a.date,
            person_id=a.person_id,
            person_name=p.name if p else None,
            person_avatar_url=p.avatar_url if p else None,
            team_role_id=a.team_role_id,
            team_role_label=tr.role_label if tr else None,
            notes=a.notes,
            locked_at=a.locked_at,
            locked_by_membership_id=a.locked_by_membership_id,
            swap_offer_id=a.swap_offer_id,
        )
        for a, s, p, tr in rows
    ]
    return ScheduleDetail(
        id=schedule.id,
        tenant_id=schedule.tenant_id,
        period=schedule.period,
        status=schedule.status,  # type: ignore[arg-type]
        generated_at=schedule.generated_at,
        published_at=schedule.published_at,
        reopened_at=schedule.reopened_at,
        solver_used=schedule.solver_used,  # type: ignore[arg-type]
        created_at=schedule.created_at,
        assignments=assignments,
    )


@router.get("/schedules", response_model=list[ScheduleOut])
def list_schedules(
    ctx: RequestContext = Depends(get_current_context),
) -> list[Schedule]:
    return (
        ctx.db.query(Schedule)
        .order_by(Schedule.period.desc(), Schedule.id.desc())
        .all()
    )


@router.get("/schedules/{schedule_id}", response_model=ScheduleDetail)
def get_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> ScheduleDetail:
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _serialize_detail(ctx, s)


@router.post(
    "/schedules/generate",
    response_model=ScheduleDetail,
    status_code=status.HTTP_201_CREATED,
)
def generate(
    payload: ScheduleGenerateRequest,
    ctx: RequestContext = Depends(get_current_context),
) -> ScheduleDetail:
    _require_admin(ctx)
    period = date(payload.period.year, payload.period.month, 1)

    existing = (
        ctx.db.query(Schedule)
        .filter(Schedule.period == period)
        .first()
    )
    locked_carry: list[Assignment] = []
    if existing:
        if existing.status == "published":
            raise HTTPException(
                status_code=400,
                detail=(
                    "Ya hay una planificación publicada para "
                    f"{period.strftime('%Y-%m')} — archívala primero"
                ),
            )
        # Carry forward locked assignments before deleting the old draft.
        locked_carry = (
            ctx.db.query(Assignment)
            .filter(
                Assignment.schedule_id == existing.id,
                Assignment.locked_at.isnot(None),
            )
            .all()
        )
        # Detach so cascading delete doesn't take them — copy to plain
        # dataclasses-by-value via expunge.
        for a in locked_carry:
            ctx.db.expunge(a)
        ctx.db.delete(existing)
        ctx.db.flush()

    schedule = scheduler.generate_draft(
        ctx.db,
        tenant_id=ctx.tenant.id,
        period=period,
        membership_id=ctx.membership.id,
        locked=locked_carry,
    )
    return _serialize_detail(ctx, schedule)


@router.post("/schedules/{schedule_id}/publish", response_model=ScheduleOut)
def publish_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Schedule:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "draft":
        raise HTTPException(
            status_code=400, detail="Solo se pueden publicar planificaciones en borrador"
        )
    scheduler.publish(ctx.db, s)
    return s


@router.post("/schedules/{schedule_id}/archive", response_model=ScheduleOut)
def archive_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Schedule:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    scheduler.archive(ctx.db, s)
    return s


@router.post(
    "/schedules/{schedule_id}/unarchive", response_model=ScheduleOut
)
def unarchive_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Schedule:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "archived":
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden desarchivar planificaciones archivadas",
        )
    scheduler.unarchive(ctx.db, s)
    return s


@router.post(
    "/schedules/{schedule_id}/reopen", response_model=ScheduleOut
)
def reopen_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Schedule:
    """Flip published → draft so the admin can edit cells again. The
    schedule disappears from /me/turnos until re-published.

    Side effects:
    - All open swap offers for the schedule's assignments get
      cancelled; the requester gets an email saying so.
    - Every team member with at least one assignment in this
      schedule gets a heads-up email so they understand why the
      planning disappeared from their view.
    Email sending is best-effort — failures don't roll back the
    status change."""
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "published":
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden reabrir planificaciones publicadas",
        )

    # Gather what we need BEFORE flipping status so we know who to
    # notify. Imports are inside the function to avoid pulling email
    # / swap models at module-import time.
    from app.core.config import settings
    from app.models.shift_swap import ShiftSwapOffer, ShiftSwapResponse
    from app.services.email import send_email
    from app.services.email_templates import (
        schedule_reopened_member_email,
        swap_cancelled_due_to_reopen_email,
    )

    # Open swap offers tied to assignments of this schedule.
    open_offers = (
        ctx.db.query(ShiftSwapOffer, Assignment, Slot, Person)
        .join(Assignment, Assignment.id == ShiftSwapOffer.assignment_id)
        .join(Slot, Slot.id == Assignment.slot_id)
        .join(
            Membership,
            Membership.id == ShiftSwapOffer.requested_by_membership_id,
        )
        .join(Person, Person.id == Membership.person_id)
        .filter(
            Assignment.schedule_id == s.id,
            ShiftSwapOffer.status == "open",
        )
        .all()
    )
    period_label = s.period.strftime("%B %Y")
    app_url = settings.public_base_url
    now = datetime.now(timezone.utc)

    # Cancel each offer + any pending responses, send a notification
    # to the requester.
    for offer, assignment, slot_row, requester in open_offers:
        offer.status = "cancelled"
        offer.closed_at = now
        (
            ctx.db.query(ShiftSwapResponse)
            .filter(
                ShiftSwapResponse.offer_id == offer.id,
                ShiftSwapResponse.status == "pending",
            )
            .update(
                {"status": "withdrawn", "decided_at": now},
                synchronize_session=False,
            )
        )
        if requester.email:
            subject, body = swap_cancelled_due_to_reopen_email(
                recipient_name=requester.name,
                slot_name=slot_row.name,
                shift_date=assignment.date.isoformat(),
                period_label=period_label,
                app_url=app_url,
            )
            send_email(to=requester.email, subject=subject, body_text=body)

    # Heads-up email to every distinct member with an assignment in
    # this schedule.
    member_rows = (
        ctx.db.query(Person)
        .join(Assignment, Assignment.person_id == Person.id)
        .filter(Assignment.schedule_id == s.id)
        .distinct()
        .all()
    )
    for person in member_rows:
        if not person.email:
            continue
        subject, body = schedule_reopened_member_email(
            recipient_name=person.name,
            period_label=period_label,
            app_url=app_url,
        )
        send_email(to=person.email, subject=subject, body_text=body)

    # Now flip the status (after enumerations so we still see the
    # "published" assignments + open offers).
    scheduler.reopen(ctx.db, s, membership_id=ctx.membership.id)
    return s


@router.delete(
    "/schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    """Delete a draft schedule. Cascades to its assignments. Published
    or archived schedules cannot be deleted — archive them first if you
    want them out of the active list."""
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "draft":
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden eliminar planificaciones en borrador",
        )
    scheduler.delete_draft(ctx.db, s)


# ---------------------------------------------------------------------------
# Manual assignment editing (Sprint 5 part B)
# ---------------------------------------------------------------------------


def _get_draft_schedule_or_400(ctx: RequestContext, schedule_id: int) -> Schedule:
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "draft":
        raise HTTPException(
            status_code=400,
            detail="Solo se pueden editar planificaciones en borrador",
        )
    return s


def _get_assignment(
    ctx: RequestContext, schedule: Schedule, assignment_id: int
) -> Assignment:
    a = ctx.db.get(Assignment, assignment_id)
    if not a or a.tenant_id != ctx.tenant.id or a.schedule_id != schedule.id:
        raise HTTPException(status_code=404, detail="Assignment not found")
    return a


def _serialize_assignment(ctx: RequestContext, a: Assignment) -> AssignmentOut:
    s = ctx.db.get(Slot, a.slot_id)
    p = ctx.db.get(Person, a.person_id) if a.person_id else None
    tr = ctx.db.get(SlotTeamRole, a.team_role_id) if a.team_role_id else None
    assert s is not None
    return AssignmentOut(
        id=a.id,
        schedule_id=a.schedule_id,
        slot_id=a.slot_id,
        slot_name=s.name,
        slot_color=s.color,
        date=a.date,
        person_id=a.person_id,
        person_name=p.name if p else None,
        person_avatar_url=p.avatar_url if p else None,
        team_role_id=a.team_role_id,
        team_role_label=tr.role_label if tr else None,
        notes=a.notes,
        locked_at=a.locked_at,
        locked_by_membership_id=a.locked_by_membership_id,
        swap_offer_id=a.swap_offer_id,
    )


@router.patch(
    "/schedules/{schedule_id}/assignments/{assignment_id}",
    response_model=AssignmentOut,
)
def patch_assignment(
    schedule_id: int,
    assignment_id: int,
    payload: AssignmentPatch,
    ctx: RequestContext = Depends(get_current_context),
) -> AssignmentOut:
    _require_admin(ctx)
    schedule = _get_draft_schedule_or_400(ctx, schedule_id)
    a = _get_assignment(ctx, schedule, assignment_id)
    data = payload.model_dump(exclude_unset=True)
    clear = data.pop("clear_person", False)

    # Optional team_role change (rare — usually fixed, but we allow it).
    if "team_role_id" in data:
        tr_id = data["team_role_id"]
        if tr_id is not None:
            tr = ctx.db.get(SlotTeamRole, tr_id)
            if not tr or tr.tenant_id != ctx.tenant.id or tr.slot_id != a.slot_id:
                raise HTTPException(
                    status_code=422, detail="team_role_id no pertenece a este slot"
                )
        a.team_role_id = tr_id

    if clear:
        a.person_id = None
        a.notes = "No hay personal disponible"
    elif "person_id" in data:
        new_pid = data["person_id"]
        if new_pid is None:
            a.person_id = None
            a.notes = "No hay personal disponible"
        else:
            slot = ctx.db.get(Slot, a.slot_id)
            assert slot is not None
            sctx = _Context(ctx.db, ctx.tenant.id, schedule.period)
            ok, reason = is_eligible(
                sctx, new_pid, slot, a.date, team_role_id=a.team_role_id
            )
            if not ok:
                raise HTTPException(status_code=422, detail=reason or "No elegible")
            a.person_id = new_pid
            a.notes = None

    ctx.db.flush()
    return _serialize_assignment(ctx, a)


@router.post(
    "/schedules/{schedule_id}/assignments/{assignment_id}/lock",
    response_model=AssignmentOut,
)
def lock_assignment(
    schedule_id: int,
    assignment_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> AssignmentOut:
    _require_admin(ctx)
    schedule = _get_draft_schedule_or_400(ctx, schedule_id)
    a = _get_assignment(ctx, schedule, assignment_id)
    a.locked_at = datetime.now(timezone.utc)
    a.locked_by_membership_id = ctx.membership.id
    ctx.db.flush()
    return _serialize_assignment(ctx, a)


@router.delete(
    "/schedules/{schedule_id}/assignments/{assignment_id}/lock",
    response_model=AssignmentOut,
)
def unlock_assignment(
    schedule_id: int,
    assignment_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> AssignmentOut:
    _require_admin(ctx)
    schedule = _get_draft_schedule_or_400(ctx, schedule_id)
    a = _get_assignment(ctx, schedule, assignment_id)
    a.locked_at = None
    a.locked_by_membership_id = None
    ctx.db.flush()
    return _serialize_assignment(ctx, a)


@router.get(
    "/schedules/{schedule_id}/assignments/{assignment_id}/eligible-persons",
    response_model=list[EligiblePersonOut],
)
def list_eligible_persons(
    schedule_id: int,
    assignment_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[EligiblePersonOut]:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    a = _get_assignment(ctx, s, assignment_id)
    slot = ctx.db.get(Slot, a.slot_id)
    assert slot is not None
    sctx = _Context(ctx.db, ctx.tenant.id, s.period)
    out: list[EligiblePersonOut] = []
    rows = (
        ctx.db.query(Membership, Person)
        .join(Person, Person.id == Membership.person_id)
        .order_by(Person.name)
        .all()
    )
    for m, p in rows:
        ok, _ = is_eligible(sctx, m.person_id, slot, a.date, team_role_id=a.team_role_id)
        if ok:
            out.append(EligiblePersonOut(person_id=m.person_id, person_name=p.name))
    return out


@router.delete(
    "/schedules/{schedule_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_schedule(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    _require_admin(ctx)
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    if s.status != "draft":
        raise HTTPException(
            status_code=400, detail="Solo se pueden eliminar planificaciones en borrador"
        )
    ctx.db.delete(s)
    ctx.db.flush()
