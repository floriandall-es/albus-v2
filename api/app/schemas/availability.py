from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field, model_validator


BlockType = Literal["vacation", "sick", "training", "personal", "other"]


class AvailabilityBlockBase(BaseModel):
    person_id: int
    start_date: date
    end_date: date
    block_type: BlockType
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def _check_dates(self) -> "AvailabilityBlockBase":
        if self.end_date < self.start_date:
            raise ValueError("end_date must be >= start_date")
        return self


class AvailabilityBlockCreate(AvailabilityBlockBase):
    pass


class AvailabilityBlockUpdate(AvailabilityBlockBase):
    pass


class AvailabilityBlockOut(BaseModel):
    id: int
    tenant_id: int
    person_id: int
    person_name: str
    start_date: date
    end_date: date
    block_type: BlockType
    notes: str | None
    created_at: datetime

    model_config = {"from_attributes": True}
