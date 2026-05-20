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
from sqlalchemy import or_

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


def _validate_audience(
    ctx: RequestContext,
    include_main_team: bool,
    group_ids: list[int],
    person_ids: list[int],
) -> None:
    """422 if the audience is empty or references unknown ids in the
    current tenant. Cross-tenant ids are caught by the RLS-scoped
    lookups returning fewer rows than asked for."""
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
        created_at=m.created_at,
    )


def _visible_meetings_query(ctx: RequestContext):
    """Base query returning meetings the caller can see.

    Admins see everything. Plain members see meetings where any of
    these is true:
      - include_main_team AND caller has no group, OR
      - the caller's group is in the meeting's group audience, OR
      - the caller's person is in the meeting's person audience.
    Organizers always see their own meetings (covered by the person
    audience clause whenever they ARE in the audience; we also OR
    in organizer_membership_id so the organizer of an empty-people
    audience meeting still sees their own row).
    """
    q = ctx.db.query(Meeting).filter(Meeting.tenant_id == ctx.tenant.id)
    if _is_admin(ctx):
        return q

    person_id = ctx.person.id
    membership_id = ctx.membership.id
    group_id = ctx.membership.group_id

    person_subq = ctx.db.query(MeetingAudiencePerson.meeting_id).filter(
        MeetingAudiencePerson.person_id == person_id
    )
    group_subq = (
        ctx.db.query(MeetingAudienceGroup.meeting_id).filter(
            MeetingAudienceGroup.group_id == group_id
        )
        if group_id is not None
        else None
    )

    conditions = [
        Meeting.organizer_membership_id == membership_id,
        Meeting.id.in_(person_subq),
    ]
    if group_id is None:
        conditions.append(Meeting.include_main_team.is_(True))
    else:
        conditions.append(Meeting.id.in_(group_subq))  # type: ignore[arg-type]

    return q.filter(or_(*conditions))


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

    is_admin = _is_admin(ctx)

    out: list[MeetingInstanceOut] = []
    for m in meetings:
        # Editable by tenant admin always, or by the organizer on
        # their own row. We let admins edit regular templates and
        # all ad-hoc meetings; members edit only their own ad-hoc
        # ones (the route layer enforces this on writes).
        can_edit = is_admin or (
            m.organizer_membership_id == ctx.membership.id
        )
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
    _require_admin(ctx)
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
    _require_admin(ctx)
    m = _get_or_404(ctx, meeting_id)
    if m.kind != "regular":
        raise HTTPException(
            status_code=422,
            detail="Esta reunión no es semanal; usa el endpoint de ad-hoc.",
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
    # Editable by tenant admin or by the organizer.
    if not _is_admin(ctx) and m.organizer_membership_id != ctx.membership.id:
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
    # Admin deletes anything. Organizer deletes their own ad-hoc
    # meeting. Regular templates are admin-only (a member shouldn't
    # be able to wipe the weekly sesión clínica just because they
    # happen to be in its audience).
    if _is_admin(ctx):
        pass
    elif m.kind == "ad_hoc" and m.organizer_membership_id == ctx.membership.id:
        pass
    else:
        raise HTTPException(
            status_code=403,
            detail="Solo el organizador o el administrador pueden eliminar esta reunión.",
        )
    ctx.db.delete(m)
    ctx.db.flush()
