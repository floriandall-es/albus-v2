from datetime import datetime, time
from typing import Literal

from pydantic import BaseModel, Field


DaysApplied = Literal["all", "weekdays", "weekends_holidays", "custom"]
StaffingMode = Literal["single", "multiple_same", "team_composition"]
SkillStrength = Literal["hard", "soft"]


class SlotTeamRoleIn(BaseModel):
    role_label: str = Field(min_length=1, max_length=255)
    headcount: int = Field(default=1, ge=1)
    category_ids: list[int] = Field(default_factory=list)


class SlotSkillRequiredIn(BaseModel):
    skill_id: int
    strength: SkillStrength = "hard"


class SlotCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    department_id: int | None = None
    pool_id: int | None = None
    start_time: time | None = None
    end_time: time | None = None
    days_applied: DaysApplied = "all"
    custom_days_bitmap: int | None = Field(default=None, ge=0, le=127)
    staffing_mode: StaffingMode = "single"
    headcount: int = Field(default=1, ge=1)
    post_slot_rest: bool = False
    counts_for_equity: bool = True
    guardia_type: str | None = Field(default=None, max_length=64)
    team_roles: list[SlotTeamRoleIn] = Field(default_factory=list)
    skills_required: list[SlotSkillRequiredIn] = Field(default_factory=list)


class SlotUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    department_id: int | None = None
    pool_id: int | None = None
    start_time: time | None = None
    end_time: time | None = None
    days_applied: DaysApplied | None = None
    custom_days_bitmap: int | None = Field(default=None, ge=0, le=127)
    staffing_mode: StaffingMode | None = None
    headcount: int | None = Field(default=None, ge=1)
    post_slot_rest: bool | None = None
    counts_for_equity: bool | None = None
    guardia_type: str | None = Field(default=None, max_length=64)
    # If provided, replaces the existing team_roles / skills_required atomically.
    team_roles: list[SlotTeamRoleIn] | None = None
    skills_required: list[SlotSkillRequiredIn] | None = None


class SlotTeamRoleOut(BaseModel):
    id: int
    role_label: str
    headcount: int
    category_ids: list[int]


class SlotSkillRequiredOut(BaseModel):
    id: int
    skill_id: int
    strength: SkillStrength


class SlotOut(BaseModel):
    id: int
    tenant_id: int
    department_id: int | None
    pool_id: int | None
    name: str
    start_time: time | None
    end_time: time | None
    days_applied: DaysApplied
    custom_days_bitmap: int | None
    staffing_mode: StaffingMode
    headcount: int
    post_slot_rest: bool
    counts_for_equity: bool
    guardia_type: str | None
    crosses_midnight: bool
    team_roles: list[SlotTeamRoleOut]
    skills_required: list[SlotSkillRequiredOut]
    created_at: datetime

    model_config = {"from_attributes": True}
