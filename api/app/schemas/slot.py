from datetime import datetime, time
from typing import Literal

from pydantic import BaseModel, Field

from app.schemas.slot_rule import SlotRuleOut


DaysApplied = Literal["all", "weekdays", "weekends_holidays", "custom"]
StaffingMode = Literal["single", "multiple_same", "team_composition"]


class SlotTeamRoleIn(BaseModel):
    role_label: str = Field(min_length=1, max_length=255)
    headcount: int = Field(default=1, ge=1)
    category_ids: list[int] = Field(default_factory=list)


_HEX_COLOR = r"^#[0-9a-fA-F]{6}$"


class SlotCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    department_id: int | None = None
    # Sub-team that owns this activity. Null = main team (managed
    # by the tenant admin). When set, only the group's lead and
    # the tenant admin can edit it, and rules are forced to manual.
    group_id: int | None = None
    start_time: time | None = None
    end_time: time | None = None
    days_applied: DaysApplied = "all"
    custom_days_bitmap: int | None = Field(default=None, ge=0, le=127)
    staffing_mode: StaffingMode = "single"
    headcount: int = Field(default=1, ge=1)
    post_slot_rest: bool = False
    counts_for_equity: bool = True
    guardia_type: str | None = Field(default=None, max_length=64)
    color: str | None = Field(default=None, pattern=_HEX_COLOR)
    team_roles: list[SlotTeamRoleIn] = Field(default_factory=list)
    # Per-slot allow-list. Empty list = "Todo el equipo" (no
    # restriction). One or more ids = ONLY those persons are eligible.
    # Replaces the pre-0030 pool_id + skills_required mechanisms.
    allowed_person_ids: list[int] = Field(default_factory=list)
    # Per-slot categoría restriction. Empty = any categoría;
    # non-empty = only members whose categoría is in this list
    # may cover the slot. Used by single + multiple_same modes;
    # for team_composition the team_roles' own category lists are
    # the primary mechanism, though this slot-level filter is also
    # honoured (intersection semantics if both are set).
    allowed_category_ids: list[int] = Field(default_factory=list)


class SlotUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    department_id: int | None = None
    group_id: int | None = None
    start_time: time | None = None
    end_time: time | None = None
    days_applied: DaysApplied | None = None
    custom_days_bitmap: int | None = Field(default=None, ge=0, le=127)
    staffing_mode: StaffingMode | None = None
    headcount: int | None = Field(default=None, ge=1)
    post_slot_rest: bool | None = None
    counts_for_equity: bool | None = None
    guardia_type: str | None = Field(default=None, max_length=64)
    color: str | None = Field(default=None, pattern=_HEX_COLOR)
    # If provided, replaces the existing team_roles atomically.
    team_roles: list[SlotTeamRoleIn] | None = None
    # If provided, replaces the existing allow-list atomically. Send
    # an empty list to clear (= "Todo el equipo").
    allowed_person_ids: list[int] | None = None
    # If provided, replaces the slot-level categoría restriction.
    # Empty list = clear (any categoría); non-empty = only those
    # categorías are eligible.
    allowed_category_ids: list[int] | None = None


class SlotTeamRoleOut(BaseModel):
    id: int
    role_label: str
    headcount: int
    category_ids: list[int]


class SlotOut(BaseModel):
    id: int
    tenant_id: int
    department_id: int | None
    group_id: int | None
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
    color: str | None = None
    position: int = 0
    crosses_midnight: bool
    team_roles: list[SlotTeamRoleOut]
    # Empty list = no restriction (everyone in the team is eligible).
    # Non-empty = only these persons are eligible.
    allowed_person_ids: list[int]
    # Slot-level categoría restriction. Empty = any categoría;
    # non-empty = only those categorías eligible.
    allowed_category_ids: list[int] = []
    rules: list[SlotRuleOut]
    created_at: datetime

    model_config = {"from_attributes": True}
