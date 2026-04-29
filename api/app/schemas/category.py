from datetime import datetime

from pydantic import BaseModel, Field


class CategoryCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    level: int | None = None
    description: str | None = None


class CategoryUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    level: int | None = None
    description: str | None = None


class CategoryOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    level: int | None
    description: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
