"""Meetings endpoints.

Three flavours of writes:
  - POST /api/meetings/regular        (tenant admin only)
  - POST /api/meetings/ad-hoc         (any authenticated member)
  - PUT  /api/meetings/{id}/regular   (tenant admin only)
  - PUT  /api/meetings/{id}/ad-hoc    (admin OR organizer)
  - DELETE /api/meetings/{id}         (admin OR organizer)

Two flavours of reads:
  - GET /api/meetings                 list of meeting rows. Admin
    sees every meeting; everyone else sees only meetings they're
    in the audience of.
  - GET /api/meetings/instances?from=&to=
    concrete occurrences expanded into a date range. Used by the
    planning-grid Reuniones row and /me/reuniones list.

Audience model: a caller is "in the audience" iff any of:
  - meeting.include_main_team is true AND caller is in main team
    (membership.group_id IS NULL), OR
  - meeting has a MeetingAudienceGroup pointing at caller's group, OR
  - meeting has a MeetingAudiencePerson pointing at caller.person_id.
Admins see all meetings regardless of audience.
"""

from __future__ import annotations

from datetime import date, datetime, timedelta
from typing import Iterable

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_, text

from app.models import (
    Group,
    Meeting,
    MeetingAudienceGroup,
    MeetingAudiencePerson,
    Membership,
    Person,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.meeting import (
    AdHocMeetingCreate,
    AdHocMeetingUpdate,
    MeetingAudienceOut,
    MeetingInstanceOut,
    MeetingOut,
    RegularMeetingCreate,
    RegularMeetingUpdate,
)

router = APIRouter()


def _is_admin(ctx: RequestContext) -> bool:
    return "admin" in ctx.membership.roles


def _require_admin(ctx: RequestContext) -> None:
    if not _is_admin(ctx):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _can_write_meeting(ctx: RequestContext, m) -> bool:
    """Write authority for edit/delete on a meeting row.

    Admin power applies only within the caller's OWN tenant. The
    equipos redesign made some meetings visible cross-tenant
    (residentes see their adjuntos-hosted comités in their audience),
    but a residente admin must not be able to rewrite the adjuntos'
    meeting just because she now sees it. The organizer check
    implicitly stays same-tenant — an organizer's membership is in
    the meeting's tenant by construction.
    """
    same_tenant = m.tenant_id == ctx.tenant.id
    if same_tenant and _is_admin(ctx):
        return True
    if m.organizer_membership_id == ctx.membership.id:
        return True
    return False


def _validate_audience(
    ctx: RequestContext,
    include_main_team: bool,
    group_ids: list[int],
    person_ids: list[int],
) -> None:
    """422 if the audience is empty or references unknown ids.

    Group ids stay strictly in-tenant — groups don't cross tenants
    by definition (and Phase E drops them entirely).

    Person ids may belong to any approved Equipo in the same
    Servicio as the caller's tenant. This is what makes the
    cross-equipo meeting invitee picker work: a residente admin
    can invite an adjunto by their person_id, and a Comité de
    Trasplante hosted by adjuntos can include residentes.

    For tenants without a servicio_id (legacy pre-Phase-A), we
    fall back to the strict in-tenant lookup so visibility doesn't
    accidentally widen on rows we haven't migrated yet.
    """
    if not include_main_team and not group_ids and not person_ids:
        raise HTTPException(
            status_code=422,
            detail="La reunión debe tener al menos un grupo o persona en la audiencia.",
        )
    if group_ids:
        found = (
            ctx.db.query(Group.id)
            .filter(Group.tenant_id == ctx.tenant.id, Group.id.in_(group_ids))
            .all()
        )
        found_ids = {row[0] for row in found}
        missing = set(group_ids) - found_ids
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"Sub-equipos desconocidos: {sorted(missing)}",
            )
    if person_ids:
        if ctx.tenant.servicio_id is not None:
            # Servicio-aware: validate against the SECURITY DEFINER
            # function so cross-tenant rows are visible to the check.
            # Caller's own membership is in there too (the function
            # returns all approved-equipo members of the servicio),
            # so this strictly widens the in-tenant case.
            rows = ctx.db.execute(
                text(
                    "SELECT DISTINCT person_id "
                    "FROM list_servicio_persons(:sid, :ct) "
                    "WHERE person_id = ANY(:pids)"
                ),
                {
                    "sid": ctx.tenant.servicio_id,
                    "ct": ctx.tenant.id,
                    "pids": list(person_ids),
                },
            ).all()
            found_ids = {row[0] for row in rows}
        else:
            # Legacy in-tenant fallback.
            found = (
                ctx.db.query(Person.id)
                .join(Membership, Membership.person_id == Person.id)
                .filter(
                    Membership.tenant_id == ctx.tenant.id,
                    Person.id.in_(person_ids),
                )
                .all()
            )
            found_ids = {row[0] for row in found}
        missing = set(person_ids) - found_ids
        if missing:
            raise HTTPException(
                status_code=422,
                detail=f"Personas desconocidas: {sorted(missing)}",
            )


def _audience_for(
    ctx: RequestContext, meeting_id: int
) -> tuple[list[int], list[int], dict[int, str], dict[int, str]]:
    """Returns (group_ids, person_ids, group_name_by_id, person_name_by_id)."""
    g_rows = (
        ctx.db.query(MeetingAudienceGroup.group_id, Group.name)
        .join(Group, Group.id == MeetingAudienceGroup.group_id)
        .filter(MeetingAudienceGroup.meeting_id == meeting_id)
        .all()
    )
    p_rows = (
        ctx.db.query(MeetingAudiencePerson.person_id, Person.name)
        .join(Person, Person.id == MeetingAudiencePerson.person_id)
        .filter(MeetingAudiencePerson.meeting_id == meeting_id)
        .all()
    )
    return (
        [gid for gid, _ in g_rows],
        [pid for pid, _ in p_rows],
        {gid: name for gid, name in g_rows},
        {pid: name for pid, name in p_rows},
    )


def _replace_audience(
    ctx: RequestContext,
    meeting: Meeting,
    group_ids: Iterable[int],
    person_ids: Iterable[int],
) -> None:
    ctx.db.query(MeetingAudienceGroup).filter(
        MeetingAudienceGroup.meeting_id == meeting.id
    ).delete(synchronize_session=False)
    ctx.db.query(MeetingAudiencePerson).filter(
        MeetingAudiencePerson.meeting_id == meeting.id
    ).delete(synchronize_session=False)
    for gid in set(group_ids):
        ctx.db.add(
            MeetingAudienceGroup(
                tenant_id=ctx.tenant.id, meeting_id=meeting.id, group_id=gid
            )
        )
    for pid in set(person_ids):
        ctx.db.add(
            MeetingAudiencePerson(
                tenant_id=ctx.tenant.id, meeting_id=meeting.id, person_id=pid
            )
        )


def _organizer_name(ctx: RequestContext, membership_id: int | None) -> str | None:
    if membership_id is None:
        return None
    row = (
        ctx.db.query(Person.name)
        .join(Membership, Membership.person_id == Person.id)
        .filter(Membership.id == membership_id)
        .first()
    )
    return row[0] if row else None


def _serialize(ctx: RequestContext, m: Meeting) -> MeetingOut:
    group_ids, person_ids, g_names, p_names = _audience_for(ctx, m.id)
    return MeetingOut(
        id=m.id,
        tenant_id=m.tenant_id,
        kind=m.kind,  # type: ignore[arg-type]
        title=m.title,
        description=m.description,
        location=m.location,
        date=m.date,
        weekday=m.weekday,
        start_time=m.start_time,
        end_time=m.end_time,
        organizer_membership_id=m.organizer_membership_id,
        organizer_name=_organizer_name(ctx, m.organizer_membership_id),
        audience=MeetingAudienceOut(
            include_main_team=m.include_main_team,
            group_ids=group_ids,
            person_ids=person_ids,
            group_names=[g_names[g] for g in group_ids],
            person_names=[p_names[p] for p in person_ids],
        ),
        reminder_minutes_before=m.reminder_minutes_before,  # type: ignore[arg-type]
        created_at=m.created_at,
    )


def _visible_meetings_query(ctx: RequestContext):
    """Base query returning meetings the caller can see.

    Two surfaces:
      A. In-tenant — everything the caller would see in today's
         model (admin: all; member: organizer / person audience /
         group audience / include_main_team).
      B. Cross-tenant via person audience — meetings hosted by a
         sibling tenant (same servicio) where the caller's
         person_id is in MeetingAudiencePerson.

    Surface (B) was added in the equipos redesign so residentes
    still see their adjuntos-hosted comités after Phase B moves
    them into their own tenant. The migration 0070 RLS policy on
    `meetings` + `meeting_audience_persons` is what actually makes
    those rows visible to the caller's session — this Python query
    enumerates the AND/OR shape the application cares about, and
    RLS is defence-in-depth.

    Group audience is in-tenant only (groups don't cross tenants
    by definition), and after Phase B residentes are no longer in
    any group anyway. include_main_team is also in-tenant only
    (the concept doesn't extend across tenants).
    """
    person_id = ctx.person.id
    membership_id = ctx.membership.id
    group_id = ctx.membership.group_id

    person_subq = ctx.db.query(MeetingAudiencePerson.meeting_id).filter(
        MeetingAudiencePerson.person_id == person_id
    )

    # Cross-tenant slice: meetings outside the caller's tenant where
    # they're personally invited. Applies to admins and members
    # alike — an admin in tenant A is just a "regular invitee" of a
    # meeting in tenant B. _can_write_meeting() refuses any write
    # attempt against those rows for non-organizers.
    cross_tenant_clause = and_(
        Meeting.tenant_id != ctx.tenant.id,
        Meeting.id.in_(person_subq),
    )

    if _is_admin(ctx):
        # Admin: every meeting in own tenant, plus any cross-tenant
        # meeting where they're personally invited.
        return ctx.db.query(Meeting).filter(
            or_(
                Meeting.tenant_id == ctx.tenant.id,
                cross_tenant_clause,
            )
        )

    # Non-admin: own-tenant rows must match an audience rule; cross-
    # tenant rows must match the person-audience slice (the same
    # clause as for admins — RLS gates the rest).
    own_tenant_conditions = [
        Meeting.organizer_membership_id == membership_id,
        Meeting.id.in_(person_subq),
    ]
    if group_id is None:
        own_tenant_conditions.append(Meeting.include_main_team.is_(True))
    else:
        group_subq = ctx.db.query(MeetingAudienceGroup.meeting_id).filter(
            MeetingAudienceGroup.group_id == group_id
        )
        own_tenant_conditions.append(Meeting.id.in_(group_subq))

    own_tenant_clause = and_(
        Meeting.tenant_id == ctx.tenant.id,
        or_(*own_tenant_conditions),
    )

    return ctx.db.query(Meeting).filter(
        or_(own_tenant_clause, cross_tenant_clause)
    )


# ---------------------------------------------------------------------------
# Reads
# ---------------------------------------------------------------------------


@router.get("/meetings", response_model=list[MeetingOut])
def list_meetings(
    ctx: RequestContext = Depends(get_current_context),
) -> list[MeetingOut]:
    rows = (
        _visible_meetings_query(ctx)
        .order_by(Meeting.kind, Meeting.weekday, Meeting.date, Meeting.start_time)
        .all()
    )
    return [_serialize(ctx, m) for m in rows]


@router.get("/meetings/instances", response_model=list[MeetingInstanceOut])
def list_meeting_instances(
    from_: date = Query(alias="from"),
    to: date = Query(...),
    ctx: RequestContext = Depends(get_current_context),
) -> list[MeetingInstanceOut]:
    """Materialise meetings into concrete date-bound occurrences for
    [from, to] inclusive. Used by the planning-grid Reuniones row
    and the /me/reuniones list.

    Hard caps the range at 366 days to avoid pathological calls."""
    if to < from_:
        raise HTTPException(status_code=422, detail="`to` must be >= `from`")
    if (to - from_).days > 366:
        raise HTTPException(
            status_code=422, detail="El rango máximo es de 366 días."
        )

    meetings = _visible_meetings_query(ctx).all()
    organizer_ids = {
        m.organizer_membership_id for m in meetings if m.organizer_membership_id
    }
    organizer_names: dict[int, str] = {}
    if organizer_ids:
        for mid, name in (
            ctx.db.query(Membership.id, Person.name)
            .join(Person, Person.id == Membership.person_id)
            .filter(Membership.id.in_(organizer_ids))
            .all()
        ):
            organizer_names[mid] = name

    out: list[MeetingInstanceOut] = []
    for m in meetings:
        # UI flag mirroring _can_write_meeting: admin-of-same-tenant
        # or organizer. Cross-tenant invitees see read-only.
        can_edit = _can_write_meeting(ctx, m)
        org_name = (
            organizer_names.get(m.organizer_membership_id)
            if m.organizer_membership_id
            else None
        )
        if m.kind == "ad_hoc":
            assert m.date is not None
            if from_ <= m.date <= to:
                out.append(
                    MeetingInstanceOut(
                        meeting_id=m.id,
                        kind="ad_hoc",
                        title=m.title,
                        description=m.description,
                        location=m.location,
                        date=m.date,
                        start_time=m.start_time,
                        end_time=m.end_time,
                        organizer_name=org_name,
                        can_edit=can_edit,
                    )
                )
        else:  # regular
            assert m.weekday is not None
            # Walk the range, emit one instance per matching weekday.
            # Python's weekday(): Mon=0..Sun=6 — same convention as
            # the stored column, no conversion needed.
            d = from_
            while d <= to:
                if d.weekday() == m.weekday:
                    out.append(
                        MeetingInstanceOut(
                            meeting_id=m.id,
                            kind="regular",
                            title=m.title,
                            description=m.description,
                            location=m.location,
                            date=d,
                            start_time=m.start_time,
                            end_time=m.end_time,
                            organizer_name=org_name,
                            can_edit=can_edit,
                        )
                    )
                d += timedelta(days=1)

    out.sort(key=lambda x: (x.date, x.start_time, x.meeting_id))
    return out


# ---------------------------------------------------------------------------
# Writes
# ---------------------------------------------------------------------------


@router.post(
    "/meetings/regular",
    response_model=MeetingOut,
    status_code=status.HTTP_201_CREATED,
)
def create_regular_meeting(
    payload: RegularMeetingCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> MeetingOut:
    # Any authenticated member can create a recurring meeting,
    # same as ad-hoc. We used to gate this to admins, but in
    # practice the people who run weekly clinical sessions are
    # often residents or fellows, not the tenant admin. The
    # organizer-only edit/delete rules below keep accidental
    # cross-team meddling out.
    _validate_audience(
        ctx, payload.include_main_team, payload.group_ids, payload.person_ids
    )
    m = Meeting(
        tenant_id=ctx.tenant.id,
        kind="regular",
        title=payload.title.strip(),
        description=payload.description,
        location=payload.location,
        date=None,
        weekday=payload.weekday,
        start_time=payload.start_time,
        end_time=payload.end_time,
        include_main_team=payload.include_main_team,
        organizer_membership_id=ctx.membership.id,
        reminder_minutes_before=payload.reminder_minutes_before,
    )
    ctx.db.add(m)
    ctx.db.flush()
    _replace_audience(ctx, m, payload.group_ids, payload.person_ids)
    ctx.db.flush()
    return _serialize(ctx, m)


@router.post(
    "/meetings/ad-hoc",
    response_model=MeetingOut,
    status_code=status.HTTP_201_CREATED,
)
def create_ad_hoc_meeting(
    payload: AdHocMeetingCreate,
    ctx: RequestContext = Depends(get_current_context),
) -> MeetingOut:
    # Any authenticated member can create ad-hoc meetings, including
    # sub-equipo members (per the spec for this feature: "everybody
    # should be able to put in an ad-hoc meeting").
    _validate_audience(
        ctx, payload.include_main_team, payload.group_ids, payload.person_ids
    )
    m = Meeting(
        tenant_id=ctx.tenant.id,
        kind="ad_hoc",
        title=payload.title.strip(),
        description=payload.description,
        location=payload.location,
        date=payload.date,
        weekday=None,
        start_time=payload.start_time,
        end_time=payload.end_time,
        include_main_team=payload.include_main_team,
        organizer_membership_id=ctx.membership.id,
        reminder_minutes_before=payload.reminder_minutes_before,
    )
    ctx.db.add(m)
    ctx.db.flush()
    _replace_audience(ctx, m, payload.group_ids, payload.person_ids)
    ctx.db.flush()
    return _serialize(ctx, m)


def _get_or_404(ctx: RequestContext, meeting_id: int) -> Meeting:
    m = ctx.db.get(Meeting, meeting_id)
    if not m or m.tenant_id != ctx.tenant.id:
        raise HTTPException(status_code=404, detail="Meeting not found")
    return m


@router.put("/meetings/{meeting_id}/regular", response_model=MeetingOut)
def update_regular_meeting(
    meeting_id: int,
    payload: RegularMeetingUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> MeetingOut:
    m = _get_or_404(ctx, meeting_id)
    if m.kind != "regular":
        raise HTTPException(
            status_code=422,
            detail="Esta reunión no es semanal; usa el endpoint de ad-hoc.",
        )
    # Admin-of-same-tenant or organizer can edit. Cross-tenant admin
    # (a residente admin who can SEE this meeting via audience but
    # isn't the organizer) is not allowed to rewrite an adjuntos-
    # hosted meeting.
    if not _can_write_meeting(ctx, m):
        raise HTTPException(
            status_code=403,
            detail="Solo el organizador o el administrador pueden editar esta reunión.",
        )
    _validate_audience(
        ctx, payload.include_main_team, payload.group_ids, payload.person_ids
    )
    m.title = payload.title.strip()
    m.description = payload.description
    m.location = payload.location
    m.weekday = payload.weekday
    m.start_time = payload.start_time
    m.end_time = payload.end_time
    m.include_main_team = payload.include_main_team
    m.reminder_minutes_before = payload.reminder_minutes_before
    _replace_audience(ctx, m, payload.group_ids, payload.person_ids)
    ctx.db.flush()
    return _serialize(ctx, m)


@router.put("/meetings/{meeting_id}/ad-hoc", response_model=MeetingOut)
def update_ad_hoc_meeting(
    meeting_id: int,
    payload: AdHocMeetingUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> MeetingOut:
    m = _get_or_404(ctx, meeting_id)
    if m.kind != "ad_hoc":
        raise HTTPException(
            status_code=422,
            detail="Esta reunión es semanal; usa el endpoint regular.",
        )
    # Same rule as the regular endpoint — see _can_write_meeting.
    if not _can_write_meeting(ctx, m):
        raise HTTPException(
            status_code=403,
            detail="Solo el organizador o el administrador pueden editar esta reunión.",
        )
    _validate_audience(
        ctx, payload.include_main_team, payload.group_ids, payload.person_ids
    )
    m.title = payload.title.strip()
    m.description = payload.description
    m.location = payload.location
    m.date = payload.date
    m.start_time = payload.start_time
    m.end_time = payload.end_time
    m.include_main_team = payload.include_main_team
    m.reminder_minutes_before = payload.reminder_minutes_before
    _replace_audience(ctx, m, payload.group_ids, payload.person_ids)
    ctx.db.flush()
    return _serialize(ctx, m)


@router.delete(
    "/meetings/{meeting_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    response_model=None,
)
def delete_meeting(
    meeting_id: int,
    ctx: RequestContext = Depends(get_current_context),
) -> None:
    m = _get_or_404(ctx, meeting_id)
    # Admin-of-same-tenant or organizer can delete (same rule as
    # editing; see _can_write_meeting). Random invitees, including
    # admins of *other* tenants who only see this meeting because
    # they're in the audience, get a 403 so they can't wipe the
    # weekly sesión clínica out from under everyone.
    if not _can_write_meeting(ctx, m):
        raise HTTPException(
            status_code=403,
            detail="Solo el organizador o el administrador pueden eliminar esta reunión.",
        )
    ctx.db.delete(m)
    ctx.db.flush()
