from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


MembershipMode = Literal["dedicated", "rotational", "mixed"]


class PoolCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    department_id: int | None = None
    membership_mode: MembershipMode = "dedicated"
    equity_independent: bool = True


class PoolUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    department_id: int | None = None
    membership_mode: MembershipMode | None = None
    equity_independent: bool | None = None


class PoolMemberOut(BaseModel):
    id: int
    person_id: int
    person_name: str
    person_email: str
    created_at: datetime

    model_config = {"from_attributes": True}


class PoolOut(BaseModel):
    id: int
    tenant_id: int
    department_id: int | None
    name: str
    membership_mode: MembershipMode
    equity_independent: bool
    member_count: int
    created_at: datetime

    model_config = {"from_attributes": True}


class PoolDetailOut(PoolOut):
    members: list[PoolMemberOut]


class PoolMemberAddRequest(BaseModel):
    person_id: int
