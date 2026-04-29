from datetime import datetime

from pydantic import BaseModel, Field


class SkillCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    description: str | None = None


class SkillUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    description: str | None = None


class SkillOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
