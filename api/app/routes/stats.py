"""Aggregated assignment counts for the admin stats + /me stats pages.

Aggregates over PUBLISHED + ARCHIVED schedules — draft assignments
shouldn't influence "how much has X actually worked" since they may
still change. Two endpoints share a single aggregator: the admin one
returns team-wide rows; the /me one pre-filters by the caller's
person_id so each clinician sees only their own breakdown.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status

from app.models import (
    Assignment,
    Holiday,
    Person,
    Schedule,
    Slot,
    SlotTeamRole,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.stats import StatsResponse, StatsRow

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


def _aggregate_assignments(
    ctx: RequestContext,
    from_: date,
    to: date,
    *,
    person_id_filter: int | None = None,
) -> StatsResponse:
    """Shared aggregator. PUBLISHED + ARCHIVED schedules only. When
    `person_id_filter` is set, the query is pre-filtered to that
    person — used by the /me/stats endpoint so each clinician can
    see their own breakdown without leaking team-wide rows."""
    if to < from_:
        raise HTTPException(
            status_code=400, detail="'to' debe ser >= 'from'"
        )

    # Holidays in the period — used to flag weekend-OR-holiday rows.
    holiday_dates: set[date] = {
        h.date
        for h in ctx.db.query(Holiday)
        .filter(Holiday.date.between(from_, to))
        .all()
    }

    q = (
        ctx.db.query(Assignment, Person, Slot, SlotTeamRole)
        .join(Schedule, Schedule.id == Assignment.schedule_id)
        .join(Person, Person.id == Assignment.person_id)
        .join(Slot, Slot.id == Assignment.slot_id)
        .outerjoin(SlotTeamRole, SlotTeamRole.id == Assignment.team_role_id)
        .filter(
            Schedule.status.in_(["published", "archived"]),
            Assignment.date.between(from_, to),
            Assignment.person_id.isnot(None),
        )
    )
    if person_id_filter is not None:
        q = q.filter(Assignment.person_id == person_id_filter)
    rows = q.all()

    # Sprint 17: aggregation bucket now includes team_role_id (nullable)
    # so team_composition slots break down per sub-role. Volume is small
    # enough that pivoting in Python is still fine.
    Bucket = tuple[int, int, int | None, str]
    counts: dict[Bucket, int] = defaultdict(int)
    weekend_counts: dict[Bucket, int] = defaultdict(int)
    person_info: dict[int, tuple[str, str | None]] = {}
    slot_info: dict[int, tuple[str, str | None]] = {}
    role_label_by_id: dict[int, str] = {}

    for a, p, s, tr in rows:
        ym = a.date.strftime("%Y-%m")
        key: Bucket = (p.id, s.id, a.team_role_id, ym)
        counts[key] += 1
        if a.date.weekday() >= 5 or a.date in holiday_dates:
            weekend_counts[key] += 1
        person_info[p.id] = (p.name, p.avatar_url)
        slot_info[s.id] = (s.name, s.color)
        if tr is not None:
            role_label_by_id[tr.id] = tr.role_label

    out: list[StatsRow] = []
    for (pid, sid, rid, ym), n in counts.items():
        pname, pavatar = person_info[pid]
        sname, scolor = slot_info[sid]
        out.append(
            StatsRow(
                person_id=pid,
                person_name=pname,
                person_avatar_url=pavatar,
                slot_id=sid,
                slot_name=sname,
                slot_color=scolor,
                team_role_id=rid,
                team_role_label=role_label_by_id.get(rid) if rid else None,
                year_month=ym,
                count=n,
                weekend_or_holiday_count=weekend_counts.get(
                    (pid, sid, rid, ym), 0
                ),
            )
        )
    out.sort(
        key=lambda r: (
            r.year_month,
            r.slot_name,
            r.team_role_label or "",
            r.person_name,
        )
    )
    return StatsResponse(from_date=from_, to_date=to, rows=out)


@router.get("/stats/assignments", response_model=StatsResponse)
def stats_assignments(
    from_: date = Query(..., alias="from"),
    to: date = Query(...),
    ctx: RequestContext = Depends(get_current_context),
) -> StatsResponse:
    """Per (person, slot, year-month) count of assignments in the date
    range. PUBLISHED + ARCHIVED schedules only. Also surfaces a
    weekend/holiday count per row for separate weekend-balance charts.
    """
    _require_admin(ctx)
    return _aggregate_assignments(ctx, from_, to)


@router.get("/me/stats/assignments", response_model=StatsResponse)
def my_stats_assignments(
    from_: date = Query(..., alias="from"),
    to: date = Query(...),
    ctx: RequestContext = Depends(get_current_context),
) -> StatsResponse:
    """Same shape as /stats/assignments but scoped to the caller —
    every row belongs to ctx.person.id. No admin gate: any member
    can see their own performed shifts. Drives /me/estadisticas."""
    return _aggregate_assignments(ctx, from_, to, person_id_filter=ctx.person.id)


