"""Pydantic schemas for periodos especiales + snapshots + delta overrides.

Three families:

  - PeriodoEspecial CRUD (V.1, unchanged)
  - Slot snapshots (V.2.5): full slot+rules duplicate for a period.
    Upsert payload mirrors the /api/slots PUT shape (SlotCreate +
    rules-replace), with a `dismissed` bool at the top level.
  - Succession + frequency cap delta overrides (V.2, unchanged):
    tenant-scoped cross-slot rules don't fit the snapshot framing.
"""

from __future__ import annotations

from datetime import date, datetime, time
from typing import Literal

from pydantic import BaseModel, Field, model_validator

from app.schemas.slot import (
    DaysApplied,
    SlotTeamRoleIn,
    SlotTeamRoleOut,
    StaffingMode,
    _HEX_COLOR,
)
from app.schemas.slot_rule import SlotRuleIn, SlotRuleOut


# ---------------------------------------------------------------------------
# Periodo CRUD
# ---------------------------------------------------------------------------


class PeriodoEspecialCreate(BaseModel):
    """Create a new periodo. Non-overlap with existing periodos in
    the same tenant is enforced at the DB layer (GiST exclusion);
    the route surfaces an IntegrityError as a 422 with a helpful
    message."""

    name: str = Field(min_length=1, max_length=255)
    start_date: date
    end_date: date

    @model_validator(mode="after")
    def _check_date_order(self) -> PeriodoEspecialCreate:
        if self.end_date < self.start_date:
            raise ValueError(
                "end_date debe ser igual o posterior a start_date"
            )
        return self


class PeriodoEspecialUpdate(BaseModel):
    """Partial update. Any non-null field replaces the existing
    value; null means "leave unchanged"."""

    name: str | None = Field(default=None, min_length=1, max_length=255)
    start_date: date | None = None
    end_date: date | None = None


class PeriodoEspecialOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    start_date: date
    end_date: date
    created_at: datetime


class GeneratePeriodResult(BaseModel):
    """Returned by POST /api/periodos/{id}/generate. One row per
    Schedule that was created or updated. Status carries the same
    'cpsat' | 'greedy' tag as a normal schedule generation."""

    schedule_id: int
    period: str  # 'YYYY-MM-01'
    solver_used: str  # 'cpsat' | 'greedy'
    assignments_created: int


# ---------------------------------------------------------------------------
# Slot snapshots (V.2.5)
# ---------------------------------------------------------------------------


class SlotPeriodSnapshotUpsert(BaseModel):
    """Full slot+rules snapshot for a (period, slot) pair.

    The shape mirrors SlotCreate (from /api/slots) so the same
    SlotDialog component on the frontend can produce both payloads.
    Extra `dismissed` bool at the top: when true, the slot doesn't
    run during the period at all (no demand). Other fields are
    still required because the snapshot remains valid if Mara
    toggles dismissed off later.

    Notes:
      - No `name` field. The slot keeps its name across periods.
      - No `department_id` either — same reasoning.
      - The rules list fully replaces what's in the snapshot
        (rules + their child rows) on each upsert.
    """

    dismissed: bool = False
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
    allowed_person_ids: list[int] = Field(default_factory=list)
    allowed_category_ids: list[int] = Field(default_factory=list)
    rules: list[SlotRuleIn] = Field(default_factory=list)


class SlotPeriodSnapshotOut(BaseModel):
    """Response shape mirroring SlotOut. Carries the snapshot's full
    state so the frontend can pre-fill the SlotDialog without a
    second roundtrip to the base slot's config."""

    id: int
    period_id: int
    slot_id: int
    dismissed: bool
    start_time: time | None
    end_time: time | None
    days_applied: DaysApplied
    custom_days_bitmap: int | None
    staffing_mode: StaffingMode
    headcount: int
    post_slot_rest: bool
    counts_for_equity: bool
    guardia_type: str | None
    color: str | None
    team_roles: list[SlotTeamRoleOut]
    allowed_person_ids: list[int]
    allowed_category_ids: list[int]
    rules: list[SlotRuleOut]
    created_at: datetime

    model_config = {"from_attributes": True}


# ---------------------------------------------------------------------------
# Succession + frequency cap delta overrides (V.2, unchanged)
# ---------------------------------------------------------------------------

Severity = Literal["hard", "soft"]


class SlotSuccessionRulePeriodOverrideUpsert(BaseModel):
    """Set or replace the override for one (period, succession rule) pair."""

    days_after_override: int | None = Field(default=None, ge=0, le=14)
    severity_override: Severity | None = None
    disabled: bool = False


class SlotSuccessionRulePeriodOverrideOut(BaseModel):
    id: int
    period_id: int
    succession_rule_id: int
    days_after_override: int | None
    severity_override: Severity | None
    disabled: bool


class SlotFrequencyCapPeriodOverrideUpsert(BaseModel):
    """Set or replace the override for one (period, frequency cap) pair."""

    max_count_override: int | None = Field(default=None, ge=0)
    severity_override: Severity | None = None
    disabled: bool = False


class SlotFrequencyCapPeriodOverrideOut(BaseModel):
    id: int
    period_id: int
    cap_id: int
    max_count_override: int | None
    severity_override: Severity | None
    disabled: bool
