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
    # (Tipo de equipo) writes these via the same endpoint, so admins
    # answer "service shape" questions when they have authenticated
    # context, not on the public credentials page.
    has_subteams: bool | None = None
    transplants_enabled: bool | None = None


class SetupAreaUpdate(BaseModel):
    """Body for POST /api/tenants/me/setup. `completed=True` stamps
    the corresponding setup_*_completed_at with NOW; `completed=False`
    clears it back to NULL (admin un-marking).
    """
    area: SetupArea
    completed: bool
