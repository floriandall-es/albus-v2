from datetime import datetime

from pydantic import BaseModel, Field


class GroupCreate(BaseModel):
    name: str = Field(min_length=1, max_length=255)
    # Initial lead can be set at create time or later. Null = no
    # lead yet (no group-scoped admin until one is assigned).
    lead_membership_id: int | None = None


class GroupUpdate(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    lead_membership_id: int | None = None
    # Sentinel for "clear the lead" (since None could also mean
    # "no change" in PATCH semantics). When True, server sets
    # lead_membership_id to NULL.
    clear_lead: bool = False


class GroupOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    lead_membership_id: int | None
    # Display name of the lead, joined from Person — null if no
    # lead set or if the lead's membership was deleted.
    lead_name: str | None
    # Headcount summary so the /admin/groups list doesn't need a
    # second round-trip to count members.
    member_count: int
    slot_count: int
    created_at: datetime


class GroupMembersUpdate(BaseModel):
    """Body for PUT /api/groups/{id}/members — replaces the group's
    membership list with `membership_ids`. Memberships removed from
    the group go to "main team" (group_id = NULL). Memberships in
    the list that belonged to a different group are moved here."""
    membership_ids: list[int] = Field(default_factory=list)
