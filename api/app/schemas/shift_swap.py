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
    # Migration 0063: optional audience. Pass a non-empty list of
    # membership ids to narrow who can see + respond + receive the
    # email. Omit (None) to send to the whole tenant — back-compat
    # for API clients that don't care yet. Max 500 ids is a sanity
    # cap (real services have ~20-50 members).
    audience_membership_ids: list[int] | None = Field(
        default=None, max_length=500
    )


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
    # Migration 0063: who the request went to. NULL means "everyone
    # in the tenant" (legacy or wide-cast offers); a list means
    # only those memberships were notified and may respond.
    audience_membership_ids: list[int] | None = None
    responses: list[SwapResponseOut] = Field(default_factory=list)
