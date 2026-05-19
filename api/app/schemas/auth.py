from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    tenant_name: str = Field(min_length=1, max_length=255)
    # `person_name` is the legacy single-field name. Kept for backward
    # compatibility with older clients; the server derives it from
    # first_name + last_name when both are provided.
    person_name: str | None = Field(default=None, max_length=255)
    first_name: str | None = Field(default=None, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=255)
    # ISO 3166-1 alpha-2. Defaults to ES — Trivu's v1 launch market. Used as
    # the default for the holiday import flow; admins can change it later.
    country_code: str | None = Field(default="ES", max_length=8)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class SelectTenantRequest(BaseModel):
    pre_auth_token: str
    tenant_id: int


class TenantPickerOption(BaseModel):
    id: int
    slug: str
    name: str


class PreAuthPersonOut(BaseModel):
    id: int
    email: str
    name: str

    model_config = {"from_attributes": True}


class TenantSelectionResponse(BaseModel):
    requires_tenant_selection: bool = True
    pre_auth_token: str
    person: PreAuthPersonOut
    available_tenants: list[TenantPickerOption]


class TenantOut(BaseModel):
    id: int
    slug: str
    name: str
    country: str | None = None
    locale: str | None = None
    country_code: str | None = None
    region_code: str | None = None
    created_at: datetime
    onboarding_completed_at: datetime | None = None
    # Set by the onboarding preset step. One of 'quirurgico' / 'medico'
    # / 'otro'. Null on tenants created before this feature shipped.
    preset_kind: str | None = None

    model_config = {"from_attributes": True}


class PersonOut(BaseModel):
    id: int
    email: str
    name: str
    first_name: str | None = None
    last_name: str | None = None
    locale: str | None = None
    avatar_url: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class MembershipOut(BaseModel):
    id: int
    tenant_id: int
    person_id: int
    roles: list[str]
    category_id: int | None = None
    fte_pct: int = 100
    disabled_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class DepartmentOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


class RoleTypeOut(BaseModel):
    id: int
    tenant_id: int
    department_id: int | None
    name: str
    color: str | None
    defaults_jsonb: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    tenant: TenantOut
    person: PersonOut
    memberships: list[MembershipOut]


class TenantSummaryCounts(BaseModel):
    categories: int
    slots: int


class MeResponse(BaseModel):
    person: PersonOut
    current_tenant: TenantOut
    memberships: list[MembershipOut]
    role_types: list[RoleTypeOut]
    departments: list[DepartmentOut]
    counts: TenantSummaryCounts


# Profile self-management. `name` retained for backward compat with the
# legacy single-field flow; new clients send first_name + last_name and
# the server composes `name` from them.
class ProfileUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    first_name: str | None = Field(default=None, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=255)


class EmailChangeRequest(BaseModel):
    current_password: str
    new_email: EmailStr


class EmailChangeRequested(BaseModel):
    """Response shape for POST /me/email — the email is NOT yet
    changed. Confirmation link sent to new_email; the actual swap
    happens via POST /me/email/confirm after the user clicks it."""
    new_email: EmailStr
    sent_to: EmailStr


class SetPresetRequest(BaseModel):
    """Body for POST /onboarding/preset. Literal-typed so FastAPI
    rejects unknown kinds with a 422 before our code runs."""
    kind: Literal["quirurgico", "medico", "otro"]
