"""Aggregated assignment counts for the admin stats + /me stats pages.

Aggregates over PUBLISHED + ARCHIVED schedules — draft assignments
shouldn't influence "how much has X actually worked" since they may
still change. Two endpoints share a single aggregator: the admin one
returns team-wide rows; the /me one pre-filters by the caller's
person_id so each clinician sees only their own breakdown.

Two surfaces:

  - GET /stats/assignments  → per (person, slot, role, month) detail
                              (the existing per-slot stacked-bar
                              charts on /admin/stats)
  - GET /stats/overview     → KPIs, FTE-normalized workload, monthly
                              trends. Designed to power the redesigned
                              /admin/stats dashboard top-half in a
                              single round-trip. See
                              docs/billing-plan.md → stats overhaul
                              for the design rationale.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import date, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query, status
from sqlalchemy import func

from app.models import (
    Assignment,
    AvailabilityBlock,
    Category,
    Holiday,
    Incident,
    Membership,
    Person,
    Schedule,
    ShiftSwapOffer,
    Slot,
    SlotTeamRole,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.stats import (
    KpiBlock,
    MonthlyRow,
    StatsOverviewResponse,
    StatsResponse,
    StatsRow,
    WorkloadRow,
)

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


# ---------------------------------------------------------------------------
# /stats/overview — KPIs + workload distribution + monthly trends.
# ---------------------------------------------------------------------------


def _months_between(from_: date, to: date) -> list[str]:
    """Inclusive list of YYYY-MM strings spanning the range.

    Used to seed the monthly trend table so months with zero activity
    still appear as zeros (the line chart needs continuous x-axis,
    not a gap-filled-by-Recharts mess)."""
    out: list[str] = []
    y, m = from_.year, from_.month
    while (y, m) <= (to.year, to.month):
        out.append(f"{y:04d}-{m:02d}")
        m += 1
        if m > 12:
            m = 1
            y += 1
    return out


def _block_days_in_range(start: date, end: date, frm: date, to: date) -> int:
    """Days where [start, end] overlaps [frm, to]. Inclusive on both
    ends. Zero when no overlap.

    Used to convert availability_blocks (which carry a start/end pair)
    into a "days within reporting window" integer the KPI strip can
    show. A 14-day vacation that straddles the window boundary
    contributes only the days that actually fall in-range, which is
    what the admin's mental model expects."""
    lo = max(start, frm)
    hi = min(end, to)
    if hi < lo:
        return 0
    return (hi - lo).days + 1


@router.get("/stats/overview", response_model=StatsOverviewResponse)
def stats_overview(
    from_: date = Query(..., alias="from"),
    to: date = Query(...),
    ctx: RequestContext = Depends(get_current_context),
) -> StatsOverviewResponse:
    """One-shot dashboard payload for the redesigned /admin/stats page.

    Returns:
      - kpis: 8 headline numbers (total / sin cubrir / swaps /
        bloqueos / reopens / incidencias / team size + FTE).
      - workload: per-person totals with category + FTE so the
        frontend can build the equity histogram + outlier callout
        and filter by categoría client-side.
      - monthly: one row per month for the trend mini-charts.

    Designed for scale-invariance: KPIs + monthly are tenant-level,
    workload is the only per-person payload and lands as a JSON
    array the frontend bins into a histogram. A 100-adjunto team
    sends ~10kB more than a 6-adjunto team — trivially small.
    """
    _require_admin(ctx)
    if to < from_:
        raise HTTPException(status_code=400, detail="'to' debe ser >= 'from'")

    months = _months_between(from_, to)

    # -----------------------------------------------------------------
    # Assignments — total / uncovered / weekend / per-person counts
    # -----------------------------------------------------------------
    # One DB pass through the published+archived assignments in-range,
    # buckets in Python. The tenants we care about have at most a few
    # thousand rows per month; not worth fancy SQL for this.
    holiday_dates: set[date] = {
        h.date
        for h in ctx.db.query(Holiday)
        .filter(Holiday.date.between(from_, to))
        .all()
    }

    assignment_rows = (
        ctx.db.query(Assignment)
        .join(Schedule, Schedule.id == Assignment.schedule_id)
        .filter(
            Schedule.status.in_(["published", "archived"]),
            Assignment.date.between(from_, to),
        )
        .all()
    )

    total_assignments = len(assignment_rows)
    uncovered_total = sum(1 for a in assignment_rows if a.person_id is None)
    monthly_total_by_ym: dict[str, int] = defaultdict(int)
    monthly_uncovered_by_ym: dict[str, int] = defaultdict(int)
    per_person_total: dict[int, int] = defaultdict(int)
    per_person_weekend: dict[int, int] = defaultdict(int)
    for a in assignment_rows:
        ym = a.date.strftime("%Y-%m")
        monthly_total_by_ym[ym] += 1
        if a.person_id is None:
            monthly_uncovered_by_ym[ym] += 1
            continue
        per_person_total[a.person_id] += 1
        if a.date.weekday() >= 5 or a.date in holiday_dates:
            per_person_weekend[a.person_id] += 1

    uncovered_pct = (
        round((uncovered_total / total_assignments) * 100, 1)
        if total_assignments > 0
        else 0.0
    )

    # -----------------------------------------------------------------
    # Swap offers — keyed on created_at (the moment the offer existed)
    # -----------------------------------------------------------------
    swap_offers = (
        ctx.db.query(ShiftSwapOffer)
        .filter(ShiftSwapOffer.created_at.between(from_, to + timedelta(days=1)))
        .all()
    )
    swap_open = sum(1 for o in swap_offers if o.status == "open")
    swap_fulfilled = sum(1 for o in swap_offers if o.status == "fulfilled")
    swap_cancelled = sum(1 for o in swap_offers if o.status == "cancelled")
    monthly_swap_created: dict[str, int] = defaultdict(int)
    monthly_swap_fulfilled: dict[str, int] = defaultdict(int)
    for o in swap_offers:
        ym = o.created_at.strftime("%Y-%m")
        monthly_swap_created[ym] += 1
        if o.status == "fulfilled" and o.closed_at is not None:
            ym_close = o.closed_at.strftime("%Y-%m")
            monthly_swap_fulfilled[ym_close] += 1

    # -----------------------------------------------------------------
    # Bloqueos — approved availability_blocks; sum overlap-days
    # -----------------------------------------------------------------
    blocks = (
        ctx.db.query(AvailabilityBlock)
        .filter(
            AvailabilityBlock.status == "approved",
            AvailabilityBlock.start_date <= to,
            AvailabilityBlock.end_date >= from_,
        )
        .all()
    )
    bloqueos_days_total = 0
    bloqueos_days_by_type: dict[str, int] = defaultdict(int)
    monthly_bloqueos_days: dict[str, int] = defaultdict(int)
    for b in blocks:
        days = _block_days_in_range(b.start_date, b.end_date, from_, to)
        bloqueos_days_total += days
        bloqueos_days_by_type[b.block_type] += days
        # Spread the block's days across the months it touches so the
        # monthly trend reflects vacation periods correctly. A
        # 14-day vacation crossing July 28 → Aug 10 contributes 4
        # days to July and 10 to August.
        cur = max(b.start_date, from_)
        end = min(b.end_date, to)
        while cur <= end:
            monthly_bloqueos_days[cur.strftime("%Y-%m")] += 1
            cur += timedelta(days=1)

    # -----------------------------------------------------------------
    # Reopened schedules — schedule.reopened_at within range
    # -----------------------------------------------------------------
    reopened_count = (
        ctx.db.query(func.count(Schedule.id))
        .filter(
            Schedule.reopened_at.isnot(None),
            Schedule.reopened_at.between(from_, to + timedelta(days=1)),
        )
        .scalar()
        or 0
    )

    # -----------------------------------------------------------------
    # Incidents — incident.occurred_at within range
    # -----------------------------------------------------------------
    incidents = (
        ctx.db.query(Incident)
        .filter(Incident.occurred_at.between(from_, to))
        .all()
    )
    monthly_incidents: dict[str, int] = defaultdict(int)
    for i in incidents:
        monthly_incidents[i.occurred_at.strftime("%Y-%m")] += 1

    # -----------------------------------------------------------------
    # Team snapshot — non-disabled memberships, RIGHT NOW (not range-
    # scoped — "active members in March" is rarely the question)
    # -----------------------------------------------------------------
    memberships = (
        ctx.db.query(Membership, Person, Category)
        .join(Person, Person.id == Membership.person_id)
        .outerjoin(Category, Category.id == Membership.category_id)
        .filter(Membership.disabled_at.is_(None))
        .all()
    )
    active_members = len(memberships)
    total_fte = round(
        sum(m.fte_pct for m, _, _ in memberships) / 100.0, 1
    )

    # -----------------------------------------------------------------
    # Workload per member — for the equity histogram + outliers
    # -----------------------------------------------------------------
    workload: list[WorkloadRow] = []
    for m, person, category in memberships:
        total = per_person_total.get(person.id, 0)
        weekend = per_person_weekend.get(person.id, 0)
        normalized = (
            round(total * 100.0 / m.fte_pct, 1) if m.fte_pct > 0 else 0.0
        )
        workload.append(
            WorkloadRow(
                person_id=person.id,
                person_name=person.name,
                person_avatar_url=person.avatar_url,
                category_id=m.category_id,
                category_name=category.name if category else None,
                fte_pct=m.fte_pct,
                total_shifts=total,
                weekend_or_holiday_shifts=weekend,
                normalized_total=normalized,
            )
        )

    # -----------------------------------------------------------------
    # Monthly rollup — one row per month, zeroed when no activity
    # -----------------------------------------------------------------
    monthly: list[MonthlyRow] = [
        MonthlyRow(
            year_month=ym,
            total_assignments=monthly_total_by_ym.get(ym, 0),
            uncovered_count=monthly_uncovered_by_ym.get(ym, 0),
            swap_offers_created=monthly_swap_created.get(ym, 0),
            swap_offers_fulfilled=monthly_swap_fulfilled.get(ym, 0),
            bloqueos_days=monthly_bloqueos_days.get(ym, 0),
            incidents_count=monthly_incidents.get(ym, 0),
        )
        for ym in months
    ]

    return StatsOverviewResponse(
        from_date=from_,
        to_date=to,
        kpis=KpiBlock(
            total_assignments=total_assignments,
            uncovered_count=uncovered_total,
            uncovered_pct=uncovered_pct,
            swap_offers_open=swap_open,
            swap_offers_fulfilled=swap_fulfilled,
            swap_offers_cancelled=swap_cancelled,
            bloqueos_days_total=bloqueos_days_total,
            bloqueos_days_by_type=dict(bloqueos_days_by_type),
            reopened_schedules_count=int(reopened_count),
            incidents_count=len(incidents),
            active_members=active_members,
            total_fte=total_fte,
        ),
        workload=workload,
        monthly=monthly,
    )


