from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


ScheduleStatus = Literal["draft", "published", "archived"]
SolverUsed = Literal["cpsat", "greedy"]


class ScheduleOut(BaseModel):
    id: int
    tenant_id: int
    period: date
    status: ScheduleStatus
    generated_at: datetime | None
    published_at: datetime | None
    reopened_at: datetime | None = None
    solver_used: SolverUsed | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class AssignmentOut(BaseModel):
    id: int
    schedule_id: int
    slot_id: int
    slot_name: str
    slot_color: str | None = None
    date: date
    person_id: int | None
    person_name: str | None
    person_avatar_url: str | None = None
    team_role_id: int | None
    team_role_label: str | None
    notes: str | None
    locked_at: datetime | None = None
    locked_by_membership_id: int | None = None
    swap_offer_id: int | None = None


class AssignmentPatch(BaseModel):
    person_id: int | None = None
    team_role_id: int | None = None
    # Sentinel: clients pass clear_person=True to set person_id=null.
    clear_person: bool = False


class EligiblePersonOut(BaseModel):
    person_id: int
    person_name: str


class ScheduleDetail(ScheduleOut):
    assignments: list[AssignmentOut] = Field(default_factory=list)


class ScheduleGenerateRequest(BaseModel):
    period: date
