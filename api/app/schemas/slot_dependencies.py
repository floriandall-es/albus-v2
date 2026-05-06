from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


SuccessionAppliesTo = Literal["same_person", "whole_team"]
Severity = Literal["hard", "soft"]
FrequencyPeriod = Literal[
    "rolling_7", "rolling_14", "rolling_28", "iso_week", "calendar_month"
]


class SlotSuccessionRuleIn(BaseModel):
    after_slot_id: int
    forbid_slot_id: int
    # 0 = same calendar day (incompatibility), 1+ = next-day-onwards
    # succession. Same data shape, two semantic flavors surfaced as
    # distinct rule types in the UI.
    days_after: int = Field(ge=0, le=14)
    applies_to: SuccessionAppliesTo = "same_person"
    severity: Severity = "hard"
    weight: int = Field(default=5, ge=0, le=1000)


class SlotSuccessionRuleUpdate(BaseModel):
    days_after: int | None = Field(default=None, ge=0, le=14)
    severity: Severity | None = None
    weight: int | None = Field(default=None, ge=0, le=1000)


class SlotSuccessionRuleOut(BaseModel):
    id: int
    tenant_id: int
    after_slot_id: int
    forbid_slot_id: int
    days_after: int
    applies_to: SuccessionAppliesTo
    severity: Severity
    weight: int
    created_at: datetime

    model_config = {"from_attributes": True}


class SlotFrequencyCapIn(BaseModel):
    slot_id: int
    period: FrequencyPeriod
    max_count: int = Field(ge=0, le=1000)
    severity: Severity = "hard"
    weight: int = Field(default=5, ge=0, le=1000)


class SlotFrequencyCapUpdate(BaseModel):
    max_count: int | None = Field(default=None, ge=0, le=1000)
    severity: Severity | None = None
    weight: int | None = Field(default=None, ge=0, le=1000)


class SlotFrequencyCapOut(BaseModel):
    id: int
    tenant_id: int
    slot_id: int
    period: FrequencyPeriod
    max_count: int
    severity: Severity
    weight: int
    created_at: datetime

    model_config = {"from_attributes": True}
