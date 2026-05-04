from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


SlotRuleStrategy = Literal["solver", "fixed_weekly", "rotation", "manual"]


class WeeklyPinIn(BaseModel):
    weekday: int = Field(ge=0, le=6)
    person_id: int


class RotationBlockIn(BaseModel):
    position: int = Field(ge=0)
    days_bitmap: int = Field(ge=1, le=127)


class RotationMemberIn(BaseModel):
    position: int = Field(ge=0)
    person_id: int


class SlotRuleIn(BaseModel):
    days_bitmap: int = Field(ge=1, le=127)
    strategy: SlotRuleStrategy
    anchor_date: date | None = None
    weekly_pins: list[WeeklyPinIn] = Field(default_factory=list)
    rotation_blocks: list[RotationBlockIn] = Field(default_factory=list)
    rotation_members: list[RotationMemberIn] = Field(default_factory=list)


class SlotRulesReplaceIn(BaseModel):
    rules: list[SlotRuleIn]


class WeeklyPinOut(BaseModel):
    id: int
    weekday: int
    person_id: int


class RotationBlockOut(BaseModel):
    id: int
    position: int
    days_bitmap: int


class RotationMemberOut(BaseModel):
    id: int
    position: int
    person_id: int


class SlotRuleOut(BaseModel):
    id: int
    tenant_id: int
    position: int
    days_bitmap: int
    strategy: SlotRuleStrategy
    anchor_date: date | None
    weekly_pins: list[WeeklyPinOut]
    rotation_blocks: list[RotationBlockOut]
    rotation_members: list[RotationMemberOut]
