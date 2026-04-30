from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


ScheduleStatus = Literal["draft", "published", "archived"]


class ScheduleOut(BaseModel):
    id: int
    tenant_id: int
    period: date
    status: ScheduleStatus
    generated_at: datetime | None
    published_at: datetime | None
    created_at: datetime

    model_config = {"from_attributes": True}


class AssignmentOut(BaseModel):
    id: int
    schedule_id: int
    slot_id: int
    slot_name: str
    date: date
    person_id: int | None
    person_name: str | None
    team_role_id: int | None
    team_role_label: str | None
    notes: str | None


class ScheduleDetail(ScheduleOut):
    assignments: list[AssignmentOut] = Field(default_factory=list)


class ScheduleGenerateRequest(BaseModel):
    period: date
