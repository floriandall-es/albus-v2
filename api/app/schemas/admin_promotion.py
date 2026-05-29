"""Pydantic schemas for the admin promotion consent flow
(migration 0087).

Used by /admin/team to request a promotion and by the public
accept/decline landing page (frontend route /confirm-admin-
promotion). Server enforces the lifecycle; these shapes just
carry data over the wire."""

from datetime import datetime
from typing import Literal

from pydantic import BaseModel


PromotionStatus = Literal[
    "pending", "accepted", "declined", "cancelled", "expired"
]


class AdminPromotionRequestOut(BaseModel):
    """One row of the admin's "pending promotions" panel + the
    payload returned right after creating a request. The display
    fields (target_person_name, requested_by_person_name) are
    denormalised at read time so the UI doesn't need a second
    fetch to render."""

    id: int
    target_membership_id: int
    target_person_name: str
    requested_by_membership_id: int | None
    requested_by_person_name: str | None
    status: PromotionStatus
    created_at: datetime
    expires_at: datetime
    decided_at: datetime | None


class AdminPromotionPreviewOut(BaseModel):
    """What the accept/decline landing page renders before the
    target hits Accept. No bearer required — the page is reachable
    by anyone with the token, since that's the consent surface.

    `tenant_name` and `inviter_name` are the trust signals
    ("Are you sure you want X to invite you?"). Status is
    surfaced too so we can render a clear "already accepted" or
    "expired" state instead of throwing the user into a confusing
    error."""

    tenant_name: str
    target_person_name: str
    inviter_person_name: str | None
    status: PromotionStatus
    expires_at: datetime
