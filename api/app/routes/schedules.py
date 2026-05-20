"""Schedule + assignment endpoints (admin-only).

Sprint 4 ships the greedy stub generator behind these endpoints. Editing
individual assignments is out of scope (Sprint 5).
"""

from __future__ import annotations

from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Query, Response, status
from sqlalchemy.orm import Session

from app.models import (
    Assignment,
    AvailabilityBlock,
    Group,
    Holiday,
    Membership,
    Person,
    Schedule,
    ScheduleGroupPublication,
    Slot,
    SlotTeamRole,
)
from app.routes.deps import RequestContext, get_current_context
from app.routes.scope import caller_scope
from app.schemas.schedule import (
    AssignmentCreate,
    AssignmentOut,
    AssignmentPatch,
    AssignmentSaveResponse,
    EligiblePersonOut,
    ScheduleDetail,
    ScheduleGenerateRequest,
    ScheduleOut,
    ViolationCellOut,
    ViolationOut,
)
from app.services import scheduler
from app.services.scheduler import _Context, is_eligible
from app.services.violations import find_violations as _find_violations
from app.services.pdf import (
    PdfAbsence,
    build_absences_by_date,
    build_rows_from_assignments,
    render_schedule_pdf,
    schedule_pdf_filename,
)

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _published_group_ids_for(
    ctx: RequestContext, schedule_id: int
) -> list[int]:
    """All group ids whose lead has published the group's plan for
    this schedule. Sorted ascending so the response is stable."""
    rows = (
        ctx.db.query(ScheduleGroupPublication.group_id)
        .filter(ScheduleGroupPublication.schedule_id == schedule_id)
        .order_by(ScheduleGroupPublication.group_id)
        .all()
    )
    return [r[0] for r in rows]


def _serialize_detail(
    ctx: RequestContext,
    schedule: Schedule,
    override_group_id: int | None = None,
) -> ScheduleDetail:
    """Serialize a schedule's assignments per caller context.

    `override_group_id` lets a tenant admin pin the view to a
    specific group (the new /admin/groups/[id]/planificacion page
    uses it). Group leads can also pass their own group_id but
    not anyone else's — passing a foreign group is a 403.
    """
    from app.routes.scope import caller_scope

    scope = caller_scope(ctx)
    published_group_ids = _published_group_ids_for(ctx, schedule.id)
    published_group_set = set(published_group_ids)

    if override_group_id is not None:
        if scope.is_tenant_admin:
            pass  # admin can see any group, any status
        elif scope.is_group_lead and scope.group_id == override_group_id:
            pass  # lead sees their own group at any status (drafts too)
        else:
            # Plain member (or lead peeking at a foreign group):
            # allowed only when the group is published for THIS
            # schedule. Drafts stay private to the lead + tenant
            # admin.
            if override_group_id not in published_group_set:
                raise HTTPException(
                    status_code=403,
                    detail="La planificación de ese sub-equipo todavía no está publicada.",
                )

    rows = (
        ctx.db.query(Assignment, Slot, Person, SlotTeamRole, Group)
        .join(Slot, Slot.id == Assignment.slot_id)
        .outerjoin(Person, Person.id == Assignment.person_id)
        .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
        .outerjoin(Group, Group.id == Slot.group_id)
        .filter(Assignment.schedule_id == schedule.id)
        .order_by(Assignment.date, Assignment.slot_id, Assignment.id)
        .all()
    )

    # Strict context filter: a Schedule entity carries assignments
    # for BOTH the main team and group sub-teams in one row set,
    # but no caller ever wants to see both mixed together. We slice
    # to the caller's relevant context here so the admin's main
    # view, PDF, stats, etc. all naturally stay clean.
    #
    #   Tenant admin   → main team only (slot.group_id IS NULL).
    #                    Group plans live in /lead/planificacion;
    #                    admins peek at them only via a future
    #                    dedicated route, never mixed here.
    #   Group lead     → their group's assignments only (the only
    #                    rows they manage).
    #   Plain member   → their OWN context:
    #                      - in a group → that group's assignments,
    #                        gated by per-group publish state
    #                      - not in a group → main team only, gated
    #                        by the existing Schedule.status gate
    is_published = schedule.status == "published"
    member_group_id: int | None = ctx.membership.group_id

    def _visible(s: Slot) -> bool:
        # When the caller explicitly asked for a specific group's
        # view, narrow to that group. This is the
        # /admin/groups/[id]/planificacion path; the auth check
        # above already guaranteed the caller is allowed to see it.
        if override_group_id is not None:
            return s.group_id == override_group_id
        if scope.is_tenant_admin:
            return s.group_id is None
        if scope.is_group_lead:
            return s.group_id == scope.group_id
        # Plain member: context is their membership's group_id.
        if member_group_id is None:
            return s.group_id is None and is_published
        if s.group_id != member_group_id:
            return False
        return member_group_id in published_group_set

    rows = [t for t in rows if _visible(t[1])]
    assignments = [
        AssignmentOut(
            id=a.id,
            schedule_id=a.schedule_id,
            slot_id=a.slot_id,
            slot_name=s.name,
            slot_color=s.color,
            slot_position=s.position,
            slot_group_id=g.id if g else None,
            slot_group_name=g.name if g else None,
            slot_start_time=s.start_time.isoformat() if s.start_time else None,
            slot_end_time=s.end_time.isoformat() if s.end_time else None,
            date=a.date,
            person_id=a.person_id,
            person_name=p.name if p else None,
            person_first_name=p.first_name if p else None,
            person_last_name=p.last_name if p else None,
            person_avatar_url=p.avatar_url if p else None,
            team_role_id=a.team_role_id,
            team_role_label=tr.role_label if tr else None,
            notes=a.notes,
            locked_at=a.locked_at,
            locked_by_membership_id=a.locked_by_membership_id,
            swap_offer_id=a.swap_offer_id,
        )
        for a, s, p, tr, g in rows
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
        published_group_ids=published_group_ids,
        created_at=schedule.created_at,
        assignments=assignments,
    )


@router.get("/schedules", response_model=list[ScheduleOut])
def list_schedules(
    ctx: RequestContext = Depends(get_current_context),
) -> list[ScheduleOut]:
    schedules = (
        ctx.db.query(Schedule)
        .order_by(Schedule.period.desc(), Schedule.id.desc())
        .all()
    )
    # Batch-load published_group_ids per schedule. One query
    # regardless of how many schedules there are.
    pub_rows = (
        ctx.db.query(
            ScheduleGroupPublication.schedule_id,
            ScheduleGroupPublication.group_id,
        )
        .filter(
            ScheduleGroupPublication.schedule_id.in_([s.id for s in schedules])
        )
        .all()
        if schedules
        else []
    )
    pub_by_sched: dict[int, list[int]] = {}
    for sid, gid in pub_rows:
        pub_by_sched.setdefault(sid, []).append(gid)
    return [
        ScheduleOut(
            id=s.id,
            tenant_id=s.tenant_id,
            period=s.period,
            status=s.status,  # type: ignore[arg-type]
            generated_at=s.generated_at,
            published_at=s.published_at,
            reopened_at=s.reopened_at,
            solver_used=s.solver_used,  # type: ignore[arg-type]
            published_group_ids=sorted(pub_by_sched.get(s.id, [])),
            created_at=s.created_at,
        )
        for s in schedules
    ]


def _serialize_violations(schedule: Schedule, db: Session) -> list[ViolationOut]:
    """Run the violations engine and convert its dataclasses into the
    Pydantic wire shape. Used by GET /schedules/{id}/violations and
    inside the PATCH/POST assignment responses."""
    raw = _find_violations(db, schedule)
    return [
        ViolationOut(
            kind=v.kind,  # type: ignore[arg-type]
            message=v.message,
            cells=[
                ViolationCellOut(
                    assignment_id=c.assignment_id,
                    date=c.date,
                    slot_id=c.slot_id,
                    person_id=c.person_id,
                )
                for c in v.cells
            ],
            rule_id=v.rule_id,
            severity=v.severity,  # type: ignore[arg-type]
        )
        for v in raw
    ]


@router.get(
    "/schedules/{schedule_id}/violations",
    response_model=list[ViolationOut],
)
def get_schedule_violations(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> list[ViolationOut]:
    """Return every rule breach detected against the schedule's
    current assignments. Warning data only — never blocks anything.
    The schedule detail page calls this to drive the violations
    banner + per-cell markers.

    Visible to any caller who can read the schedule itself (tenant
    admin always; group leads on their own group's slots; plain
    members get only their assignments, but they don't see this
    endpoint surface in the UI today)."""
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _serialize_violations(s, ctx.db)


@router.get("/schedules/{schedule_id}", response_model=ScheduleDetail)
def get_schedule(
    schedule_id: int,
    group_id: int | None = Query(
        default=None,
        description=(
            "Optional: narrow the response to one group's "
            "assignments. Tenant admin uses this to view a "
            "specific group's plan from /admin/groups/{id}/"
            "planificacion. Group leads can only pass their own "
            "group's id; anything else returns 403."
        ),
    ),
    ctx: RequestContext = Depends(get_current_context),
) -> ScheduleDetail:
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    return _serialize_detail(ctx, s, override_group_id=group_id)


@router.get("/schedules/{schedule_id}/pdf")
def get_schedule_pdf(
    schedule_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Response:
    """Render the full schedule as a landscape PDF. Same content for
    admins and members; the only access difference is that members
    can't download a DRAFT (admin-only until published)."""
    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    is_admin = "admin" in ctx.membership.roles
    if s.status == "draft" and not is_admin:
        raise HTTPException(
            status_code=403,
            detail="La planificación todavía está en borrador",
        )

    # Pull the same assignment + slot + person + role tuple shape that
    # _serialize_detail uses, so build_rows_from_assignments can pivot
    # the data exactly like the planning grid does.
    rows = (
        ctx.db.query(Assignment, Slot, Person, SlotTeamRole)
        .join(Slot, Slot.id == Assignment.slot_id)
        .outerjoin(Person, Person.id == Assignment.person_id)
        .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
        .filter(
            Assignment.schedule_id == s.id,
            # Strict context: the PDF is the admin's main-team
            # plan; group sub-team plans never appear here.
            # Sub-team admins publish + export their own plans
            # separately (planned, not in v1).
            Slot.group_id.is_(None),
        )
        .order_by(Assignment.date, Assignment.slot_id, Assignment.id)
        .all()
    )
    pdf_rows = build_rows_from_assignments(rows)

    # Approved absences covering the schedule's month — fed into the
    # Libre row, same as the on-screen grid.
    period_start = date(s.period.year, s.period.month, 1)
    if s.period.month == 12:
        period_end_exclusive = date(s.period.year + 1, 1, 1)
    else:
        period_end_exclusive = date(s.period.year, s.period.month + 1, 1)
    absence_rows = (
        ctx.db.query(AvailabilityBlock, Person)
        .join(Person, Person.id == AvailabilityBlock.person_id)
        .filter(
            AvailabilityBlock.status == "approved",
            AvailabilityBlock.start_date < period_end_exclusive,
            AvailabilityBlock.end_date >= period_start,
        )
        .all()
    )

    class _AbsenceView:
        # Tiny shim so build_absences_by_date can use the same attr
        # names it already expects. Saves loading a Pydantic schema.
        def __init__(self, block: AvailabilityBlock, person: Person):
            self.person_id = block.person_id
            self.person_name = person.name
            self.start_date = block.start_date
            self.end_date = block.end_date
            self.block_type = block.block_type

    absences = [_AbsenceView(b, p) for b, p in absence_rows]

    import calendar as _cal
    last_day = _cal.monthrange(s.period.year, s.period.month)[1]
    month_dates = [
        date(s.period.year, s.period.month, d) for d in range(1, last_day + 1)
    ]
    absences_by_date = build_absences_by_date(absences, month_dates)

    # Holidays for the year — the planning grid uses these for the
    # red weekday tint; the PDF reuses them for the same effect.
    holiday_rows = (
        ctx.db.query(Holiday)
        .filter(
            Holiday.date >= period_start,
            Holiday.date < period_end_exclusive,
        )
        .all()
    )
    holiday_dates = {h.date for h in holiday_rows}

    pdf_bytes = render_schedule_pdf(
        schedule_period=s.period,
        schedule_status=s.status,
        rows=pdf_rows,
        absences_by_date=absences_by_date,
        holiday_dates=holiday_dates,
        tenant_name=ctx.tenant.name,
        generated_at=datetime.now(timezone.utc),
    )
    filename = schedule_pdf_filename(s.period)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


@router.get("/schedules/{schedule_id}/groups/{group_id}/pdf")
def get_group_schedule_pdf(
    schedule_id: int,
    group_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Response:
    """Render one sub-team's plan for a schedule as a landscape PDF.

    Mirrors the main /pdf endpoint but filters slots to a single
    group. Access:
      - Tenant admin: any group, any status (drafts too)
      - Group lead: their own group, any status
      - Plain member: any group, but only if the group is published
        for this schedule
    """
    from app.routes.scope import caller_scope

    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")
    g = ctx.db.get(Group, group_id)
    if not g or g.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Group not found")

    scope = caller_scope(ctx)
    if scope.is_tenant_admin:
        pass
    elif scope.is_group_lead and scope.group_id == group_id:
        pass
    else:
        # Plain member or lead viewing a foreign group: must be
        # published for this schedule.
        published = (
            ctx.db.query(ScheduleGroupPublication.id)
            .filter(
                ScheduleGroupPublication.schedule_id == s.id,
                ScheduleGroupPublication.group_id == group_id,
            )
            .first()
            is not None
        )
        if not published:
            raise HTTPException(
                status_code=403,
                detail="La planificación de ese sub-equipo todavía no está publicada.",
            )

    rows = (
        ctx.db.query(Assignment, Slot, Person, SlotTeamRole)
        .join(Slot, Slot.id == Assignment.slot_id)
        .outerjoin(Person, Person.id == Assignment.person_id)
        .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
        .filter(
            Assignment.schedule_id == s.id,
            Slot.group_id == group_id,
        )
        .order_by(Assignment.date, Assignment.slot_id, Assignment.id)
        .all()
    )
    pdf_rows = build_rows_from_assignments(rows)

    period_start = date(s.period.year, s.period.month, 1)
    if s.period.month == 12:
        period_end_exclusive = date(s.period.year + 1, 1, 1)
    else:
        period_end_exclusive = date(s.period.year, s.period.month + 1, 1)

    # Absences row: scoped to people in this group so the "Libre"
    # column reflects the sub-team's coverage, not the whole tenant.
    absence_rows = (
        ctx.db.query(AvailabilityBlock, Person)
        .join(Person, Person.id == AvailabilityBlock.person_id)
        .join(Membership, Membership.person_id == Person.id)
        .filter(
            AvailabilityBlock.status == "approved",
            AvailabilityBlock.start_date < period_end_exclusive,
            AvailabilityBlock.end_date >= period_start,
            Membership.tenant_id == ctx.tenant.id,
            Membership.group_id == group_id,
        )
        .all()
    )

    class _AbsenceView:
        def __init__(self, block: AvailabilityBlock, person: Person):
            self.person_id = block.person_id
            self.person_name = person.name
            self.start_date = block.start_date
            self.end_date = block.end_date
            self.block_type = block.block_type

    absences = [_AbsenceView(b, p) for b, p in absence_rows]

    import calendar as _cal
    last_day = _cal.monthrange(s.period.year, s.period.month)[1]
    month_dates = [
        date(s.period.year, s.period.month, d) for d in range(1, last_day + 1)
    ]
    absences_by_date = build_absences_by_date(absences, month_dates)

    holiday_rows = (
        ctx.db.query(Holiday)
        .filter(
            Holiday.date >= period_start,
            Holiday.date < period_end_exclusive,
        )
        .all()
    )
    holiday_dates = {h.date for h in holiday_rows}

    pdf_bytes = render_schedule_pdf(
        schedule_period=s.period,
        # Surface the sub-team name in the document header so a
        # printed PDF of "Residentes" doesn't look identical to the
        # main team's. We piggyback on tenant_name here — render
        # takes a single header string and doesn't need code changes.
        schedule_status=s.status,
        rows=pdf_rows,
        absences_by_date=absences_by_date,
        holiday_dates=holiday_dates,
        tenant_name=f"{ctx.tenant.name} — {g.name}",
        generated_at=datetime.now(timezone.utc),
    )
    filename = _group_schedule_pdf_filename(s.period, g.name)
    return Response(
        content=pdf_bytes,
        media_type="application/pdf",
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
        },
    )


def _group_schedule_pdf_filename(period: date, group_name: str) -> str:
    """Slug the group name for the download filename. ASCII-only
    so quoted Content-Disposition is safe across all clients."""
    slug = "".join(
        c if c.isascii() and (c.isalnum() or c in "-_") else "-"
        for c in group_name.lower()
    ).strip("-_") or "sub-equipo"
    return f"planificacion-{slug}-{period.strftime('%Y-%m')}.pdf"


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


@router.post(
    "/schedules/{schedule_id}/groups/{group_id}/publish",
    response_model=ScheduleOut,
)
def publish_group_schedule(
    schedule_id: int,
    group_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> ScheduleOut:
    """Publish a group's plan for this schedule. Idempotent — if
    the row already exists, just refresh the timestamp + actor.

    Authorized callers: tenant admin (full power) or the group's
    designated lead. Members get 403.
    """
    from app.routes.scope import caller_scope

    scope = caller_scope(ctx)
    if not scope.is_tenant_admin and not (
        scope.is_group_lead and scope.group_id == group_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo el responsable del sub-equipo (o el administrador) puede publicar esta planificación.",
        )

    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")

    g = ctx.db.get(Group, group_id)
    if not g or g.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Group not found")

    existing = (
        ctx.db.query(ScheduleGroupPublication)
        .filter(
            ScheduleGroupPublication.schedule_id == s.id,
            ScheduleGroupPublication.group_id == g.id,
        )
        .first()
    )
    if existing:
        existing.published_at = datetime.now(timezone.utc)
        existing.published_by_membership_id = ctx.membership.id
    else:
        ctx.db.add(
            ScheduleGroupPublication(
                tenant_id=ctx.tenant.id,
                schedule_id=s.id,
                group_id=g.id,
                published_at=datetime.now(timezone.utc),
                published_by_membership_id=ctx.membership.id,
            )
        )
    ctx.db.flush()

    return ScheduleOut(
        id=s.id,
        tenant_id=s.tenant_id,
        period=s.period,
        status=s.status,  # type: ignore[arg-type]
        generated_at=s.generated_at,
        published_at=s.published_at,
        reopened_at=s.reopened_at,
        solver_used=s.solver_used,  # type: ignore[arg-type]
        published_group_ids=_published_group_ids_for(ctx, s.id),
        created_at=s.created_at,
    )


@router.delete(
    "/schedules/{schedule_id}/groups/{group_id}/publish",
    response_model=ScheduleOut,
)
def unpublish_group_schedule(
    schedule_id: int,
    group_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> ScheduleOut:
    """Revert a group's published plan back to "internal". Same
    authorization as publish. Idempotent — if the row doesn't
    exist, return 200 anyway with the current state."""
    from app.routes.scope import caller_scope

    scope = caller_scope(ctx)
    if not scope.is_tenant_admin and not (
        scope.is_group_lead and scope.group_id == group_id
    ):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Solo el responsable del sub-equipo (o el administrador) puede despublicar esta planificación.",
        )

    s = ctx.db.get(Schedule, schedule_id)
    if not s or s.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Schedule not found")

    existing = (
        ctx.db.query(ScheduleGroupPublication)
        .filter(
            ScheduleGroupPublication.schedule_id == s.id,
            ScheduleGroupPublication.group_id == group_id,
        )
        .first()
    )
    if existing:
        ctx.db.delete(existing)
        ctx.db.flush()

    return ScheduleOut(
        id=s.id,
        tenant_id=s.tenant_id,
        period=s.period,
        status=s.status,  # type: ignore[arg-type]
        generated_at=s.generated_at,
        published_at=s.published_at,
        reopened_at=s.reopened_at,
        solver_used=s.solver_used,  # type: ignore[arg-type]
        published_group_ids=_published_group_ids_for(ctx, s.id),
        created_at=s.created_at,
    )


@router.post("/schedules/{schedule_id}/publish", response_model=ScheduleOut)
def publish_schedule(
    schedule_id: int,
    notify_members: bool = Query(
        True,
        description=(
            "Send a heads-up email to every assigned team member when "
            "the schedule is published. Pass false to publish silently "
            "(e.g. the admin will tell the team by other means)."
        ),
    ),
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
    # Snapshot whether this is a republish BEFORE flipping status —
    # the helper clears reopened_at on successful publish so we'd
    # otherwise lose the signal.
    is_republish = s.reopened_at is not None

    # Snapshot the assigned members BEFORE the flip so the email
    # query doesn't depend on the post-publish RLS state. Assignments
    # are tenant-scoped; the query already runs through the admin's
    # tenant context.
    assigned_persons: list[Person] = []
    if notify_members:
        assigned_persons = (
            ctx.db.query(Person)
            .join(Assignment, Assignment.person_id == Person.id)
            .filter(Assignment.schedule_id == s.id)
            .distinct()
            .all()
        )

    scheduler.publish(ctx.db, s)

    if notify_members:
        # Lazy imports — keep send_email + templates out of the
        # module load path. Same pattern as reopen_schedule.
        from app.core.config import settings
        from app.services.email import send_email, should_email_person
        from app.services.email_templates import (
            schedule_published_member_email,
        )

        period_label = s.period.strftime("%B %Y")
        app_url = settings.public_base_url
        for person in assigned_persons:
            if not person.email:
                continue
            # Pendientes (not yet activated) don't receive routine
            # notifications; they'd land in an unconfirmed inbox.
            if not should_email_person(person.hashed_password):
                continue
            subject, body = schedule_published_member_email(
                recipient_name=person.name,
                period_label=period_label,
                app_url=app_url,
                is_republish=is_republish,
            )
            send_email(to=person.email, subject=subject, body_text=body)

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
    notify_members: bool = Query(
        True,
        description=(
            "Send notifications to affected members. When false, both "
            "the heads-up emails AND the swap-cancelled emails are "
            "suppressed; the swap offers themselves are still "
            "cancelled (data integrity) but no email is generated."
        ),
    ),
    ctx: RequestContext = Depends(get_current_context),
) -> Schedule:
    """Flip published → draft so the admin can edit cells again. The
    schedule disappears from /me/turnos until re-published.

    Side effects (subject to the notify_members flag for emails):
    - All open swap offers for the schedule's assignments get
      cancelled (always); the requester gets an email saying so
      (only when notify_members=True).
    - Every team member with at least one assignment in this
      schedule gets a heads-up email so they understand why the
      planning disappeared from their view (only when notify_members
      is True).
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
    from app.services.email import send_email, should_email_person
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

    # Cancel each offer + any pending responses. Always do the data
    # mutation (cancellation is a data-integrity step, not a
    # notification). Email the requester only when notify_members
    # is true — when the admin opts out they're taking responsibility
    # for telling the team themselves.
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
        if (
            notify_members
            and requester.email
            and should_email_person(requester.hashed_password)
        ):
            subject, body = swap_cancelled_due_to_reopen_email(
                recipient_name=requester.name,
                slot_name=slot_row.name,
                shift_date=assignment.date.isoformat(),
                period_label=period_label,
                app_url=app_url,
            )
            send_email(to=requester.email, subject=subject, body_text=body)

    # Heads-up email to every distinct member with an assignment in
    # this schedule — gated by the same flag.
    if notify_members:
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
            if not should_email_person(person.hashed_password):
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
    g = ctx.db.get(Group, s.group_id) if s.group_id else None
    return AssignmentOut(
        id=a.id,
        schedule_id=a.schedule_id,
        slot_id=a.slot_id,
        slot_name=s.name,
        slot_color=s.color,
        slot_position=s.position,
        slot_group_id=g.id if g else None,
        slot_group_name=g.name if g else None,
        slot_start_time=s.start_time.isoformat() if s.start_time else None,
        slot_end_time=s.end_time.isoformat() if s.end_time else None,
        date=a.date,
        person_id=a.person_id,
        person_name=p.name if p else None,
        person_first_name=p.first_name if p else None,
        person_last_name=p.last_name if p else None,
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
    response_model=AssignmentSaveResponse,
)
def patch_assignment(
    schedule_id: int,
    assignment_id: int,
    payload: AssignmentPatch,
    ctx: RequestContext = Depends(get_current_context),
) -> AssignmentSaveResponse:
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Permisos insuficientes."
        )
    # Tenant admins still hit the draft-only gate (their bulk
    # edits are scoped to "I'm editing a draft before publishing").
    # Group leads bypass it for cells on THEIR group's slots:
    # group slots are manual-only and aren't part of the main team's
    # publish lifecycle, so the lead can adjust assignments at any
    # status without affecting the tenant admin's plan.
    if scope.is_tenant_admin:
        schedule = _get_draft_schedule_or_400(ctx, schedule_id)
    else:
        schedule = ctx.db.get(Schedule, schedule_id)
        if not schedule or schedule.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=404, detail="Schedule not found")
    a = _get_assignment(ctx, schedule, assignment_id)
    if scope.is_group_lead:
        slot = ctx.db.get(Slot, a.slot_id)
        if not slot or slot.group_id != scope.group_id:
            raise HTTPException(
                status_code=403,
                detail="Esta asignación no pertenece a tu sub-equipo.",
            )
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
    # Run the violations engine on the post-edit state and surface
    # warnings to the admin. Pure read-only; never blocks the save.
    warnings = _serialize_violations(schedule, ctx.db)
    return AssignmentSaveResponse(
        assignment=_serialize_assignment(ctx, a),
        warnings=warnings,
    )


@router.post(
    "/schedules/{schedule_id}/assignments",
    response_model=AssignmentSaveResponse,
    status_code=status.HTTP_201_CREATED,
)
def create_assignment(
    schedule_id: int,
    payload: AssignmentCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> AssignmentSaveResponse:
    """Create a new Assignment row. Used by group leads to add
    cells for their group's slots — the solver never creates rows
    for group slots, so a lead opening a "new" cell needs to insert
    one before they can pick a person.

    Tenant admin can also call this for edge cases (manual cells
    on main-team slots that the solver missed). For tenant admin,
    the draft-only gate applies. Group leads bypass that gate, same
    rationale as patch_assignment.
    """
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Permisos insuficientes."
        )
    if scope.is_tenant_admin:
        schedule = _get_draft_schedule_or_400(ctx, schedule_id)
    else:
        schedule = ctx.db.get(Schedule, schedule_id)
        if not schedule or schedule.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=404, detail="Schedule not found")

    slot = ctx.db.get(Slot, payload.slot_id)
    if not slot or slot.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=422, detail="Unknown slot_id")
    if scope.is_group_lead and slot.group_id != scope.group_id:
        raise HTTPException(
            status_code=403,
            detail="Esta actividad no pertenece a tu sub-equipo.",
        )

    # Date must fall within the schedule's month.
    period_start = date(schedule.period.year, schedule.period.month, 1)
    next_month_year = (
        schedule.period.year + (1 if schedule.period.month == 12 else 0)
    )
    next_month = 1 if schedule.period.month == 12 else schedule.period.month + 1
    period_end = date(next_month_year, next_month, 1)
    if not (period_start <= payload.date < period_end):
        raise HTTPException(
            status_code=422,
            detail=f"La fecha {payload.date} cae fuera del mes {schedule.period}.",
        )

    if payload.team_role_id is not None:
        tr = ctx.db.get(SlotTeamRole, payload.team_role_id)
        if not tr or tr.tenant_id != ctx.tenant.id or tr.slot_id != slot.id:
            raise HTTPException(
                status_code=422, detail="team_role_id no pertenece a este slot"
            )

    if payload.person_id is not None:
        sctx = _Context(ctx.db, ctx.tenant.id, schedule.period)
        ok, reason = is_eligible(
            sctx, payload.person_id, slot, payload.date, team_role_id=payload.team_role_id
        )
        if not ok:
            raise HTTPException(status_code=422, detail=reason or "No elegible")

    a = Assignment(
        tenant_id=ctx.tenant.id,
        schedule_id=schedule.id,
        slot_id=slot.id,
        date=payload.date,
        person_id=payload.person_id,
        team_role_id=payload.team_role_id,
    )
    ctx.db.add(a)
    ctx.db.flush()
    warnings = _serialize_violations(schedule, ctx.db)
    return AssignmentSaveResponse(
        assignment=_serialize_assignment(ctx, a),
        warnings=warnings,
    )


@router.delete("/schedules/{schedule_id}/assignments/{assignment_id}")
def delete_assignment(
    schedule_id: int,
    assignment_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> Response:
    """Delete an Assignment row entirely. Used by group leads to
    remove a cell they added by mistake. Tenant admin can also
    delete — but for main-team cells they typically just clear
    the person via PATCH so the row structure stays intact for
    the solver's next regenerate.

    Returns 204 No Content via an explicit Response — declaring
    `status_code=204` on the decorator was triggering a FastAPI
    0.111 assertion on this route (route registration order +
    something about the multi-decorator file made it complain
    that the route had an implied body)."""
    scope = caller_scope(ctx)
    if not scope.has_admin_powers:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Permisos insuficientes."
        )
    if scope.is_tenant_admin:
        schedule = _get_draft_schedule_or_400(ctx, schedule_id)
    else:
        schedule = ctx.db.get(Schedule, schedule_id)
        if not schedule or schedule.tenant_id != ctx.tenant.id:
            raise HTTPException(status_code=404, detail="Schedule not found")
    a = _get_assignment(ctx, schedule, assignment_id)
    if scope.is_group_lead:
        slot = ctx.db.get(Slot, a.slot_id)
        if not slot or slot.group_id != scope.group_id:
            raise HTTPException(
                status_code=403,
                detail="Esta asignación no pertenece a tu sub-equipo.",
            )
    ctx.db.delete(a)
    ctx.db.flush()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


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
