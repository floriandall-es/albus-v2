"""Pydantic schemas for periodos especiales + slot overrides.

These serve the /api/periodos surfaces (admin CRUD + override
management + generate) introduced in V.1 of the vacation-periods
feature. See docs/vacation-periods.md for the design.
"""

from __future__ import annotations

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


StaffingMode = Literal["single", "multiple_same", "team_composition"]


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


class SlotPeriodOverrideUpsert(BaseModel):
    """Set or replace the override for one (period, slot) pair.

    Every field is optional. To revert a particular field to the
    slot's default, send null. To remove the override row entirely,
    use DELETE on the same URL.

    `dismissed = true` short-circuits: the slot doesn't run during
    the period at all, regardless of other fields. The other fields
    are still stored (in case the admin wants to switch dismissed
    off later without re-entering them), but the solver ignores
    them when dismissed is true.
    """

    headcount_override: int | None = Field(default=None, ge=1)
    staffing_mode_override: StaffingMode | None = None
    dismissed: bool = False
    # An empty list means "drop the restriction entirely during the
    # period" (any categoría / any person eligible). Distinct from
    # null which means "use the slot's default list."
    allowed_category_ids_override: list[int] | None = None
    allowed_person_ids_override: list[int] | None = None


class SlotPeriodOverrideOut(BaseModel):
    id: int
    period_id: int
    slot_id: int
    headcount_override: int | None
    staffing_mode_override: StaffingMode | None
    dismissed: bool
    allowed_category_ids_override: list[int] | None
    allowed_person_ids_override: list[int] | None


class GeneratePeriodResult(BaseModel):
    """Returned by POST /api/periodos/{id}/generate. One row per
    Schedule that was created or updated. Status carries the same
    'cpsat' | 'greedy' tag as a normal schedule generation."""

    schedule_id: int
    period: str  # 'YYYY-MM-01'
    solver_used: str  # 'cpsat' | 'greedy'
    assignments_created: int


# V.2 — per-rule / per-succession / per-cap overrides.

RuleStrategy = Literal["solver", "fixed_weekly", "rotation", "manual"]
Severity = Literal["hard", "soft"]


class SlotRulePeriodOverrideUpsert(BaseModel):
    """Set or replace the override for one (period, SlotRule) pair."""

    strategy_override: RuleStrategy | None = None
    disabled: bool = False


class SlotRulePeriodOverrideOut(BaseModel):
    id: int
    period_id: int
    rule_id: int
    strategy_override: RuleStrategy | None
    disabled: bool


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
