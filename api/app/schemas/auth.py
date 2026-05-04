from datetime import date, datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    tenant_name: str = Field(min_length=1, max_length=255)
    tenant_slug: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    person_name: str = Field(min_length=1, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=255)
    # ISO 3166-1 alpha-2. Defaults to ES — Trivu's v1 launch market. Used as
    # the default for the holiday import flow; admins can change it later.
    country_code: str | None = Field(default="ES", max_length=8)


class LoginRequest(BaseModel):
    email: EmailStr
    password: str
    tenant_slug: str


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

    model_config = {"from_attributes": True}


class PersonOut(BaseModel):
    id: int
    email: str
    name: str
    locale: str | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class MembershipOut(BaseModel):
    id: int
    tenant_id: int
    person_id: int
    roles: list[str]
    category_id: int | None = None
    fte_pct: int = 100
    does_guardias: bool = True
    guardia_types: list[str] = Field(default_factory=list)
    exemption_type: str | None = None
    exemption_until: date | None = None
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
    pools: int
    skills: int
    slots: int


class MeResponse(BaseModel):
    person: PersonOut
    current_tenant: TenantOut
    memberships: list[MembershipOut]
    role_types: list[RoleTypeOut]
    departments: list[DepartmentOut]
    counts: TenantSummaryCounts
