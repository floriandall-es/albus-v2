from datetime import date, datetime

from pydantic import BaseModel, Field


class IncidentCreate(BaseModel):
    occurred_at: date
    title: str = Field(min_length=1, max_length=255)
    body: str | None = Field(default=None, max_length=10_000)


class IncidentUpdate(BaseModel):
    occurred_at: date | None = None
    title: str | None = Field(default=None, min_length=1, max_length=255)
    body: str | None = Field(default=None, max_length=10_000)


class IncidentOut(BaseModel):
    id: int
    tenant_id: int
    occurred_at: date
    title: str
    body: str | None
    # Display name of the admin who wrote it (joined from
    # Person.name). Null if the membership was deleted after
    # the incident was logged.
    created_by_name: str | None
    created_at: datetime
    updated_at: datetime
