from datetime import date, datetime
from typing import Literal

from pydantic import BaseModel, Field


OfferStatus = Literal["open", "fulfilled", "cancelled"]
ResponseKind = Literal["cover", "swap"]
ResponseStatus = Literal["pending", "accepted", "declined", "withdrawn"]


# ---------------------------------------------------------------------------
# Input
# ---------------------------------------------------------------------------


class CreateOfferRequest(BaseModel):
    assignment_id: int
    notes: str | None = Field(default=None, max_length=500)


class CreateResponseRequest(BaseModel):
    kind: ResponseKind
    swap_assignment_id: int | None = None
    notes: str | None = Field(default=None, max_length=500)


# ---------------------------------------------------------------------------
# Output
# ---------------------------------------------------------------------------


class AssignmentSummary(BaseModel):
    """Just enough about an assignment to render a swap card without
    refetching the full schedule."""
    id: int
    schedule_id: int
    date: date
    slot_id: int
    slot_name: str
    person_id: int | None
    person_name: str | None
    team_role_label: str | None = None


class SwapResponseOut(BaseModel):
    id: int
    offer_id: int
    responder_membership_id: int
    responder_person_id: int
    responder_person_name: str
    kind: ResponseKind
    swap_assignment: AssignmentSummary | None = None
    status: ResponseStatus
    notes: str | None
    created_at: datetime
    decided_at: datetime | None


class SwapOfferOut(BaseModel):
    id: int
    tenant_id: int
    assignment: AssignmentSummary
    requested_by_membership_id: int
    requested_by_person_id: int
    requested_by_person_name: str
    status: OfferStatus
    notes: str | None
    created_at: datetime
    closed_at: datetime | None
    responses: list[SwapResponseOut] = Field(default_factory=list)
