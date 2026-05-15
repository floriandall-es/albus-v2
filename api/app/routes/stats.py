"""Aggregated assignment counts for the admin stats page.

Aggregates over PUBLISHED + ARCHIVED schedules — draft assignments
shouldn't influence "how much has X actually worked" since they may
still change. Single GET endpoint; the frontend pivots into whatever
chart shape it wants.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import and_, or_

from app.models import (
    Assignment,
    Holiday,
    Person,
    Schedule,
    Slot,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.stats import StatsResponse, StatsRow

router = APIRouter()


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN, detail="Admin role required"
        )


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

    rows = (
        ctx.db.query(Assignment, Person, Slot)
        .join(Schedule, Schedule.id == Assignment.schedule_id)
        .join(Person, Person.id == Assignment.person_id)
        .join(Slot, Slot.id == Assignment.slot_id)
        .filter(
            Schedule.status.in_(["published", "archived"]),
            Assignment.date.between(from_, to),
            Assignment.person_id.isnot(None),
        )
        .all()
    )

    # Aggregate in Python — saves writing SQL that's fiddly across
    # dialects, and the volume is small (a tenant's annual stats max).
    Bucket = tuple[int, int, str]  # (person_id, slot_id, year_month)
    counts: dict[Bucket, int] = defaultdict(int)
    weekend_counts: dict[Bucket, int] = defaultdict(int)
    person_info: dict[int, tuple[str, str | None]] = {}
    slot_info: dict[int, tuple[str, str | None]] = {}

    for a, p, s in rows:
        ym = a.date.strftime("%Y-%m")
        key: Bucket = (p.id, s.id, ym)
        counts[key] += 1
        if a.date.weekday() >= 5 or a.date in holiday_dates:
            weekend_counts[key] += 1
        person_info[p.id] = (p.name, p.avatar_url)
        slot_info[s.id] = (s.name, s.color)

    out: list[StatsRow] = []
    for (pid, sid, ym), n in counts.items():
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
                year_month=ym,
                count=n,
                weekend_or_holiday_count=weekend_counts.get((pid, sid, ym), 0),
            )
        )
    out.sort(key=lambda r: (r.year_month, r.slot_name, r.person_name))

    return StatsResponse(from_date=from_, to_date=to, rows=out)
