from datetime import datetime
from typing import Any

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    tenant_name: str = Field(min_length=1, max_length=255)
    tenant_slug: str = Field(min_length=2, max_length=64, pattern=r"^[a-z0-9][a-z0-9-]*$")
    person_name: str = Field(min_length=1, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=255)


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
    created_at: datetime

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


class MeResponse(BaseModel):
    person: PersonOut
    current_tenant: TenantOut
    memberships: list[MembershipOut]
    role_types: list[RoleTypeOut]
    departments: list[DepartmentOut]
