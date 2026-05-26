from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field

# Areas the post-signup checklist tracks. Mirror of the four
# tenant.setup_*_completed_at columns added by migration 0042.
SetupArea = Literal["activities", "rules", "team", "subteams"]


HolidaySource = Literal["national", "regional", "custom"]


class HolidayOut(BaseModel):
    id: int
    tenant_id: int
    date: date
    name: str
    source: HolidaySource
    region_code: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class HolidayCreate(BaseModel):
    date: date
    name: str = Field(min_length=1, max_length=255)
    source: HolidaySource = "custom"
    region_code: str | None = Field(default=None, max_length=16)


class HolidayImport(BaseModel):
    country_code: str = Field(min_length=2, max_length=8)
    region_code: str | None = Field(default=None, max_length=16)
    year: int = Field(ge=1970, le=2100)


class HolidayImportResult(BaseModel):
    inserted: int
    skipped: int


class TenantUpdate(BaseModel):
    country_code: str | None = Field(default=None, max_length=8)
    region_code: str | None = Field(default=None, max_length=16)
    # Sprint 28: moved out of the signup form. The onboarding step 1
    # (Tipo de equipo) writes this via the same endpoint, so admins
    # answer the question when they have authenticated context, not
    # on the public credentials page.
    transplants_enabled: bool | None = None
    # Sprint 28 / migration 0050: cap on cambios de turno per member
    # per monthly schedule. PATCH with `null` to clear (= unlimited).
    # Stored as int >= 0 on the tenant; values <= 0 are treated as
    # "no swaps allowed" by the swap acceptance check.
    max_swaps_per_member_per_month: int | None = Field(default=None, ge=0)


class SetupAreaUpdate(BaseModel):
    """Body for POST /api/tenants/me/setup. `completed=True` stamps
    the corresponding setup_*_completed_at with NOW; `completed=False`
    clears it back to NULL (admin un-marking).
    """
    area: SetupArea
    completed: bool
