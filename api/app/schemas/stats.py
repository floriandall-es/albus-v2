from datetime import date

from pydantic import BaseModel


class StatsRow(BaseModel):
    """One row of the per-(person, slot, role, month) aggregation."""
    person_id: int
    person_name: str
    person_avatar_url: str | None = None
    slot_id: int
    slot_name: str
    slot_color: str | None = None
    # Sprint 17: rows now split by team_role for team_composition
    # slots. Single / multiple_same slots have no team_role; both
    # fields stay null and the frontend renders them as one chart.
    team_role_id: int | None = None
    team_role_label: str | None = None
    year_month: str  # "YYYY-MM"
    count: int
    weekend_or_holiday_count: int = 0


class StatsResponse(BaseModel):
    from_date: date
    to_date: date
    rows: list[StatsRow]


# ---------------------------------------------------------------------------
# /api/stats/overview — Commit 1 of the stats overhaul
# ---------------------------------------------------------------------------
#
# Single endpoint returning every aggregate the redesigned /admin/stats
# page renders, so the frontend can paint the whole dashboard from one
# query instead of fanning out 6+ round-trips.
#
# Designed to stay scannable on a 6-person alpha team AND on a 100+-person
# hospital department:
#  - Most fields are tenant-level totals (KPIs, monthly trends) → identical
#    UX at any size.
#  - `workload` is per-person; the frontend renders it as a histogram +
#    outlier callouts, which actually get RICHER as N grows.
#  - `category_id` on each WorkloadRow lets the frontend apply the
#    categoría filter chips without a round-trip.


class KpiBlock(BaseModel):
    """The top-of-page KPI strip. Eight headline numbers."""

    # Schedule assignments in PUBLISHED + ARCHIVED schedules within the
    # range. Matches the existing /stats/assignments aggregator so the
    # two surfaces don't disagree.
    total_assignments: int
    # Sin cubrir = Assignment rows with NULL person_id. Surfaces gaps
    # the solver couldn't fill OR slots the admin deliberately left open.
    uncovered_count: int
    # Percentage; 0–100. Hard-zero when total_assignments is 0 so the
    # frontend doesn't have to guard the division.
    uncovered_pct: float

    # Swap activity (shift_swap_offers within the range, keyed on
    # offer.created_at). Three buckets so the frontend can show
    # "7 ofertas, 5 cubiertos" without summing.
    swap_offers_open: int
    swap_offers_fulfilled: int
    swap_offers_cancelled: int

    # Bloqueos = availability_blocks (status='approved' only — pendings
    # don't actually impact the schedule). Sum of overlap-days against
    # the range, with a per-block_type breakdown so the strip can
    # surface "vacaciones 18 · enfermedad 4 · formación 2."
    bloqueos_days_total: int
    bloqueos_days_by_type: dict[str, int]

    # Schedules with reopened_at falling in the range. Signals
    # operational churn — every reopen is the admin saying "the planning
    # I published doesn't match reality." Useful trend metric.
    reopened_schedules_count: int

    # Incidents logged in the range (incidents.occurred_at).
    incidents_count: int

    # Snapshot of the team RIGHT NOW (not range-scoped, since "active
    # members in February" is rarely the question). Drives the
    # "Equipo: 12 activos · 9.6 FTE" tile.
    active_members: int
    # Sum of fte_pct/100 across non-disabled memberships, rounded to
    # one decimal. Float (not int) because a part-time member at 80%
    # contributes 0.8.
    total_fte: float


class WorkloadRow(BaseModel):
    """One person's total workload in the range — drives the equity
    histogram + outlier panel. FTE-normalized so part-timers can be
    compared apples-to-apples with full-timers.
    """

    person_id: int
    person_name: str
    person_avatar_url: str | None = None
    category_id: int | None = None
    category_name: str | None = None
    fte_pct: int
    total_shifts: int
    weekend_or_holiday_shifts: int
    # total_shifts × 100 / fte_pct — what they WOULD have done if they
    # were full-time. Zero-protected: fte_pct==0 returns 0 (rare; a
    # 0% member is effectively disabled). Float because it's a rate.
    normalized_total: float


class MonthlyRow(BaseModel):
    """One row per month in the range. Powers the four trend mini-charts
    along the bottom: total / swaps / bloqueos / incidents."""

    year_month: str  # "YYYY-MM"
    total_assignments: int
    uncovered_count: int
    swap_offers_created: int
    swap_offers_fulfilled: int
    bloqueos_days: int
    incidents_count: int


class StatsOverviewResponse(BaseModel):
    from_date: date
    to_date: date
    kpis: KpiBlock
    workload: list[WorkloadRow]
    monthly: list[MonthlyRow]


# ---------------------------------------------------------------------------
# /api/stats/calendar — Commit 3 of the stats overhaul
# ---------------------------------------------------------------------------
#
# Per-(person, day) shift counts + bloqueo overlay for the calendar
# heat map. Designed to be SPARSE so a 100-person year-view doesn't
# blow up: only days where the person worked OR had a bloqueo appear.
#
# Entries can carry either or both signals on the same day. A clinician
# pulling a Sunday on-call shift in the middle of a sick-leave week
# would show up with shifts=1 + bloqueo_type='sick' (the planning
# committed them despite the block — visible anomaly).


class CalendarPersonOut(BaseModel):
    """Identity row for the calendar Y-axis. All non-disabled
    memberships in the tenant, regardless of whether they have any
    activity in the range — empty rows still tell the jefe
    something ("Pérez took the whole month off")."""

    id: int
    name: str
    avatar_url: str | None = None
    category_name: str | None = None


class CalendarEntry(BaseModel):
    """One non-zero day for a single person. Sparse — days with no
    shifts AND no bloqueo are omitted entirely."""

    person_id: int
    date: date
    # 0 when the day is purely a bloqueo; otherwise the count of
    # Assignment rows for this person on this date.
    shifts: int
    # One of 'vacation' / 'sick' / 'training' / 'personal' / 'other',
    # or null when the day has no approved bloqueo overlap. Mirrors
    # availability_blocks.block_type values.
    bloqueo_type: str | None = None


class StatsCalendarResponse(BaseModel):
    from_date: date
    to_date: date
    # Holidays in the range — the frontend uses these to overlay a
    # subtle background on holiday cells regardless of activity.
    holidays: list[date]
    persons: list[CalendarPersonOut]
    entries: list[CalendarEntry]
