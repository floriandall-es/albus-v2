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
