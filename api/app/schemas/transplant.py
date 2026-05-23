"""Pydantic schemas for the transplant case log.

Cases are written with their full set of procedures in one
request — the customer thinks of "a transplant" as the unit, not
individual EXPLANTE / IMPLANTE events. PATCH replaces the case
fields + the entire procedures collection atomically, which
keeps the contract simple at the cost of requiring the client
to re-send untouched procedures on edits.
"""

from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


ProcedureType = Literal["explante", "implante"]


class TransplantProcedureIn(BaseModel):
    type: ProcedureType
    occurred_at: datetime
    primary_person_id: int | None = None
    secondary_person_id: int | None = None
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _distinct_surgeons(self) -> "TransplantProcedureIn":
        if (
            self.primary_person_id is not None
            and self.secondary_person_id is not None
            and self.primary_person_id == self.secondary_person_id
        ):
            raise ValueError(
                "primary_person_id and secondary_person_id must differ"
            )
        return self


class TransplantCaseCreate(BaseModel):
    external_case_id: str | None = Field(default=None, max_length=64)
    # The case date is derived server-side from the earliest
    # procedure's occurred_at — the client doesn't send it. We
    # demand at least one procedure so we always have something
    # to derive from.
    notes: str | None = Field(default=None, max_length=4000)
    procedures: list[TransplantProcedureIn] = Field(min_length=1, max_length=6)


class TransplantCaseUpdate(BaseModel):
    external_case_id: str | None = Field(default=None, max_length=64)
    notes: str | None = Field(default=None, max_length=4000)
    # On update we replace the entire procedure list atomically.
    # Simpler than diffing — the UI re-sends what should remain.
    procedures: list[TransplantProcedureIn] = Field(min_length=1, max_length=6)


class TransplantProcedureOut(BaseModel):
    id: int
    type: ProcedureType
    occurred_at: datetime
    primary_person_id: int | None
    primary_person_name: str | None
    secondary_person_id: int | None
    secondary_person_name: str | None
    notes: str | None


class TransplantCaseOut(BaseModel):
    id: int
    tenant_id: int
    external_case_id: str | None
    occurred_on: date
    notes: str | None
    procedures: list[TransplantProcedureOut]
    # Convenience flags computed server-side so the list view
    # doesn't have to re-derive them.
    has_explante: bool
    has_implante: bool
    # True when ANY procedure on this case has no local primary
    # surgeon (organ received from / sent to another hospital).
    is_cross_hospital: bool
    created_at: datetime
    updated_at: datetime


class TransplantStatsMonthSurgeonOut(BaseModel):
    """Sprint 28: one stack-segment of the "Procedimientos por
    mes y cirujano" chart. `count` is the surgeon's total
    attributions in that month — each procedure contributes +1
    for primary and +1 for secondary independently, mirroring
    how the per-surgeon totals chart counts them."""

    person_id: int
    count: int


class TransplantStatsMonthOut(BaseModel):
    """One bar in the per-month chart. `period` is the first day
    of the month (e.g. 2026-03-01) so the frontend can format it
    consistently."""

    period: date
    explante_count: int
    implante_count: int
    cross_hospital_count: int
    # Sprint 28: per-surgeon breakdown for this month. Lets the
    # frontend render a second per-month chart where each bar is
    # stacked by surgeon (palette assigned client-side from the
    # surgeons array's order so colors stay stable across months).
    per_surgeon: list[TransplantStatsMonthSurgeonOut] = []


class TransplantStatsSurgeonOut(BaseModel):
    """One row in the surgeon-participation table. Counts are
    over the full requested range (default = all time).

    Each procedure attribution is split by both role (primary vs
    secondary) AND type (explante vs implante), giving four
    independent buckets. The frontend renders two charts — one
    per type — using {explante_primary, explante_secondary} and
    {implante_primary, implante_secondary}. `primary_count` and
    `secondary_count` are kept as convenience sums (each is the
    sum of its two type-specific siblings).
    """

    person_id: int
    person_name: str
    primary_count: int
    secondary_count: int
    explante_primary: int
    explante_secondary: int
    implante_primary: int
    implante_secondary: int


class TransplantStatsOut(BaseModel):
    total_cases: int
    total_procedures: int
    explante_total: int
    implante_total: int
    # Cases where at least one procedure has primary_person_id
    # NULL — i.e. the half-done-elsewhere half.
    cross_hospital_cases: int
    months: list[TransplantStatsMonthOut]
    surgeons: list[TransplantStatsSurgeonOut]
