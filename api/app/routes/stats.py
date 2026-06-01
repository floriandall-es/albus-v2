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
    ShiftSwapResponse,
    Slot,
    SlotTeamRole,
)
from app.routes.deps import RequestContext, get_current_context
from app.schemas.stats import (
    ActivityAverage,
    CalendarEntry,
    CalendarPersonOut,
    KpiBlock,
    MonthlyRow,
    StatsCalendarResponse,
    StatsOverviewResponse,
    StatsResponse,
    StatsRow,
    TeamComparison,
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


def _team_comparison(
    ctx: RequestContext, from_: date, to: date
) -> TeamComparison | None:
    """Privacy-safe peer aggregate for /me/estadisticas: the mean
    assignments over the range, plus weekend/holiday + swaps, computed
    WITHIN the caller's professional category (a resident is compared
    to residents, an adjunto to adjuntos — not the whole mixed team).
    Returns ONLY means + a head count — never per-person rows — so a
    member can see where they stand without seeing colleagues'
    individual numbers.

    Denominator: distinct non-disabled membership persons sharing the
    caller's category_id. RLS scopes every query to the tenant.
    """
    # Peer set — same category, currently active. If the caller is the
    # only one in their category (e.g. a sole Jefe de servicio), there
    # are no same-category peers to compare against, so fall back to
    # the whole team rather than hiding the comparison entirely.
    my_category_id = ctx.membership.category_id
    cat_filter = (
        Membership.category_id.is_(None)
        if my_category_id is None
        else Membership.category_id == my_category_id
    )
    cat_peers = (
        ctx.db.query(Membership.person_id, Membership.id)
        .filter(Membership.disabled_at.is_(None), cat_filter)
        .all()
    )
    if len({pid for pid, _ in cat_peers}) >= 2:
        peers = cat_peers
        comparison_scope = "category"
    else:
        peers = (
            ctx.db.query(Membership.person_id, Membership.id)
            .filter(Membership.disabled_at.is_(None))
            .all()
        )
        comparison_scope = "team"

    peer_person_ids = {pid for pid, _mid in peers}
    peer_membership_ids = {mid for _pid, mid in peers}
    member_count = len(peer_person_ids)
    # Genuinely alone (a one-person team) — nothing meaningful to
    # compare, so omit the block.
    if member_count < 2:
        return None

    category_name: str | None = None
    if my_category_id is not None:
        cat = ctx.db.get(Category, my_category_id)
        category_name = cat.name if cat else None

    holiday_dates: set[date] = {
        h.date
        for h in ctx.db.query(Holiday)
        .filter(Holiday.date.between(from_, to))
        .all()
    }
    # One row per assignment by a same-category peer — same
    # published+archived filters the per-person aggregator uses, so
    # "my total" and "peer average" are computed on identical grounds.
    # We pull slot_id/team_role_id too so the per-actividad averages
    # come from the same single scan.
    rows = (
        ctx.db.query(
            Assignment.date,
            Assignment.slot_id,
            Assignment.team_role_id,
        )
        .join(Schedule, Schedule.id == Assignment.schedule_id)
        .filter(
            Schedule.status.in_(["published", "archived"]),
            Assignment.date.between(from_, to),
            Assignment.person_id.in_(peer_person_ids),
        )
        .all()
    )
    total = len(rows)
    weekend = sum(
        1 for (d, _sid, _rid) in rows if d.weekday() >= 5 or d in holiday_dates
    )
    by_activity_counts: dict[tuple[int, int | None], int] = defaultdict(int)
    for (_d, sid, rid) in rows:
        by_activity_counts[(sid, rid)] += 1
    by_activity = [
        ActivityAverage(
            slot_id=sid,
            team_role_id=rid,
            avg_count=round(n / member_count, 1),
        )
        for (sid, rid), n in by_activity_counts.items()
    ]

    # Swaps — counted by the moment the action happened (offer
    # created / response accepted) falling in the range. +1 day on
    # the upper bound because these are timestamps, not dates.
    upper = to + timedelta(days=1)
    my_membership_id = ctx.membership.id
    # Peer totals are scoped to the same-category memberships too.
    total_requested = (
        ctx.db.query(func.count(ShiftSwapOffer.id))
        .filter(
            ShiftSwapOffer.requested_by_membership_id.in_(peer_membership_ids),
            ShiftSwapOffer.created_at.between(from_, upper),
        )
        .scalar()
        or 0
    )
    my_requested = (
        ctx.db.query(func.count(ShiftSwapOffer.id))
        .filter(
            ShiftSwapOffer.requested_by_membership_id == my_membership_id,
            ShiftSwapOffer.created_at.between(from_, upper),
        )
        .scalar()
        or 0
    )
    total_covered = (
        ctx.db.query(func.count(ShiftSwapResponse.id))
        .filter(
            ShiftSwapResponse.responder_membership_id.in_(peer_membership_ids),
            ShiftSwapResponse.status == "accepted",
            ShiftSwapResponse.created_at.between(from_, upper),
        )
        .scalar()
        or 0
    )
    my_covered = (
        ctx.db.query(func.count(ShiftSwapResponse.id))
        .filter(
            ShiftSwapResponse.responder_membership_id == my_membership_id,
            ShiftSwapResponse.status == "accepted",
            ShiftSwapResponse.created_at.between(from_, upper),
        )
        .scalar()
        or 0
    )

    return TeamComparison(
        team_member_count=member_count,
        category_name=category_name,
        comparison_scope=comparison_scope,
        avg_total_shifts=round(total / member_count, 1),
        avg_weekend_or_holiday_shifts=round(weekend / member_count, 1),
        my_swaps_requested=my_requested,
        avg_swaps_requested=round(total_requested / member_count, 1),
        my_swaps_covered=my_covered,
        avg_swaps_covered=round(total_covered / member_count, 1),
        by_activity=by_activity,
    )


@router.get("/me/stats/assignments", response_model=StatsResponse)
def my_stats_assignments(
    from_: date = Query(..., alias="from"),
    to: date = Query(...),
    ctx: RequestContext = Depends(get_current_context),
) -> StatsResponse:
    """Same shape as /stats/assignments but scoped to the caller —
    every row belongs to ctx.person.id. No admin gate: any member
    can see their own performed shifts. Drives /me/estadisticas.

    Also attaches a `team_comparison` aggregate so the page can show
    "you vs the team average" without a second round-trip."""
    resp = _aggregate_assignments(
        ctx, from_, to, person_id_filter=ctx.person.id
    )
    resp.team_comparison = _team_comparison(ctx, from_, to)
    return resp


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
    # Per-month cancelled count — needed so the Eficiencia tab can
    # plot coverage rate (fulfilled / (fulfilled + cancelled)) over
    # time, not just as a single period figure.
    monthly_swap_cancelled: dict[str, int] = defaultdict(int)
    for o in swap_offers:
        ym = o.created_at.strftime("%Y-%m")
        monthly_swap_created[ym] += 1
        if o.closed_at is not None:
            ym_close = o.closed_at.strftime("%Y-%m")
            if o.status == "fulfilled":
                monthly_swap_fulfilled[ym_close] += 1
            elif o.status == "cancelled":
                monthly_swap_cancelled[ym_close] += 1

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
    # month → block_type → days. Powers the "Libranzas por mes"
    # multi-line chart in the Carga tab so the admin can see at a
    # glance whether a spike is vacation (expected in August) or
    # baja (worth a conversation with the team).
    monthly_bloqueos_by_type: dict[str, dict[str, int]] = defaultdict(
        lambda: defaultdict(int)
    )
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
            ym = cur.strftime("%Y-%m")
            monthly_bloqueos_days[ym] += 1
            monthly_bloqueos_by_type[ym][b.block_type] += 1
            cur += timedelta(days=1)

    # -----------------------------------------------------------------
    # Reopened schedules — schedule.reopened_at within range
    # -----------------------------------------------------------------
    # Fetch the rows (not just a count) so we can bucket by month too.
    # Reopening volume is low (single digits per month for most teams),
    # so the per-row scan is cheap.
    reopened_rows = (
        ctx.db.query(Schedule.reopened_at)
        .filter(
            Schedule.reopened_at.isnot(None),
            Schedule.reopened_at.between(from_, to + timedelta(days=1)),
        )
        .all()
    )
    reopened_count = len(reopened_rows)
    monthly_reopened: dict[str, int] = defaultdict(int)
    for (reopened_at,) in reopened_rows:
        monthly_reopened[reopened_at.strftime("%Y-%m")] += 1

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
            swap_offers_cancelled=monthly_swap_cancelled.get(ym, 0),
            bloqueos_days=monthly_bloqueos_days.get(ym, 0),
            bloqueos_days_by_type=dict(monthly_bloqueos_by_type.get(ym, {})),
            incidents_count=monthly_incidents.get(ym, 0),
            reopened_count=monthly_reopened.get(ym, 0),
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


# ---------------------------------------------------------------------------
# /stats/calendar — per-(person, day) heat map source data.
# ---------------------------------------------------------------------------


@router.get("/stats/calendar", response_model=StatsCalendarResponse)
def stats_calendar(
    from_: date = Query(..., alias="from"),
    to: date = Query(...),
    ctx: RequestContext = Depends(get_current_context),
) -> StatsCalendarResponse:
    """Per-(person, day) shift + bloqueo overlay for the calendar
    heat map on /admin/stats.

    Payload is intentionally sparse: only days where a person worked
    OR had an approved bloqueo show up as entries. A 100-person
    year-view with average activity sends ~30k entries (~1.5 MB
    gzipped), which is fine for an admin-only surface. Reading the
    chart is O(entries) lookups into a Map; rendering uses
    overflow-x-auto so the 365-cell row stays browsable.

    Persons: every non-disabled membership, including those with
    zero activity in the range — an empty row in the heat map IS
    information ("Pérez took the whole quarter off, was that on
    purpose?").
    """
    _require_admin(ctx)
    if to < from_:
        raise HTTPException(status_code=400, detail="'to' debe ser >= 'from'")

    # Persons (whole team — sorted by category then name so the
    # heat map's Y-axis reads like the /admin/team list).
    member_rows = (
        ctx.db.query(Membership, Person, Category)
        .join(Person, Person.id == Membership.person_id)
        .outerjoin(Category, Category.id == Membership.category_id)
        .filter(Membership.disabled_at.is_(None))
        .order_by(Category.name.asc(), Person.name.asc())
        .all()
    )
    persons = [
        CalendarPersonOut(
            id=p.id,
            name=p.name,
            avatar_url=p.avatar_url,
            category_name=c.name if c else None,
        )
        for _m, p, c in member_rows
    ]

    holidays = [
        h.date
        for h in ctx.db.query(Holiday)
        .filter(Holiday.date.between(from_, to))
        .all()
    ]

    # Assignments — published + archived, with a person assigned.
    # Uncovered (person_id IS NULL) rows are deliberately excluded;
    # they're surfaced in the coverage trend on the same page.
    assignment_rows = (
        ctx.db.query(Assignment)
        .join(Schedule, Schedule.id == Assignment.schedule_id)
        .filter(
            Schedule.status.in_(["published", "archived"]),
            Assignment.date.between(from_, to),
            Assignment.person_id.isnot(None),
        )
        .all()
    )

    # (person_id, date) -> entry. Dict lookups keep the merge O(1).
    by_key: dict[tuple[int, date], CalendarEntry] = {}
    for a in assignment_rows:
        if a.person_id is None:  # narrowed by the SQL filter, but be defensive
            continue
        key = (a.person_id, a.date)
        existing = by_key.get(key)
        if existing is not None:
            existing.shifts += 1
        else:
            by_key[key] = CalendarEntry(
                person_id=a.person_id,
                date=a.date,
                shifts=1,
                bloqueo_type=None,
            )

    # Bloqueos — expand to per-day overlap with the range. Same
    # overlap math as the overview endpoint; reused so the two
    # surfaces never disagree about whether a Monday "counts."
    blocks = (
        ctx.db.query(AvailabilityBlock)
        .filter(
            AvailabilityBlock.status == "approved",
            AvailabilityBlock.start_date <= to,
            AvailabilityBlock.end_date >= from_,
        )
        .all()
    )
    for b in blocks:
        cur = max(b.start_date, from_)
        last = min(b.end_date, to)
        while cur <= last:
            key = (b.person_id, cur)
            existing = by_key.get(key)
            if existing is not None:
                # Person worked AND had a bloqueo overlap — visible
                # anomaly. Last-write-wins on the type if the person
                # somehow has two overlapping approved blocks (rare;
                # we don't currently dedupe at the data layer).
                existing.bloqueo_type = b.block_type
            else:
                by_key[key] = CalendarEntry(
                    person_id=b.person_id,
                    date=cur,
                    shifts=0,
                    bloqueo_type=b.block_type,
                )
            cur += timedelta(days=1)

    return StatsCalendarResponse(
        from_date=from_,
        to_date=to,
        holidays=holidays,
        persons=persons,
        entries=list(by_key.values()),
    )


