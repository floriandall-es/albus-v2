from datetime import date, datetime

from pydantic import BaseModel, EmailStr, Field

from app.schemas.auth import MembershipOut


class TeamMemberOut(BaseModel):
    """Membership joined with person info for the admin /team list."""

    id: int
    tenant_id: int
    person_id: int
    person_name: str
    person_email: str
    person_locale: str | None
    person_avatar_url: str | None = None
    roles: list[str]
    category_id: int | None
    category_name: str | None
    fte_pct: int
    does_guardias: bool
    guardia_types: list[str]
    exemption_type: str | None
    exemption_until: date | None
    created_at: datetime


class TeamMemberUpdate(BaseModel):
    category_id: int | None = None
    fte_pct: int | None = Field(default=None, ge=0, le=200)
    does_guardias: bool | None = None
    guardia_types: list[str] | None = None
    exemption_type: str | None = Field(default=None, pattern=r"^(permanent|temporary)$")
    exemption_until: date | None = None
    roles: list[str] | None = None
    # Sentinel-ish: clients pass `clear_exemption=True` to wipe both fields.
    clear_exemption: bool = False


class TeamInviteRequest(BaseModel):
    email: EmailStr
    person_name: str = Field(min_length=1, max_length=255)
    category_id: int | None = None
    roles: list[str] = Field(default_factory=list)
    fte_pct: int = Field(default=100, ge=0, le=200)
    does_guardias: bool = True
    guardia_types: list[str] = Field(default_factory=list)


class TeamInviteResponse(BaseModel):
    membership: MembershipOut
    person_id: int
    email: str
    created_person: bool
