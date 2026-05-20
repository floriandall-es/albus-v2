from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.schemas.auth import AuthResponse


class InviteCreateRequest(BaseModel):
    email: EmailStr
    person_name: str = Field(min_length=1, max_length=255)
    category_id: int | None = None
    roles: list[str] = Field(default_factory=lambda: ["member"])


class InvitationOut(BaseModel):
    id: int
    tenant_id: int
    email: str
    person_name: str
    expires_at: datetime
    accepted_at: datetime | None
    revoked_at: datetime | None
    category_id: int | None
    roles: list[str]
    created_at: datetime

    model_config = {"from_attributes": True}


class InviteCreateResponse(BaseModel):
    invitation_id: int
    email: str
    expires_at: datetime
    accept_url: str


class InvitationPublicView(BaseModel):
    """What the invitee sees BEFORE accepting — no PII beyond the obvious."""

    tenant_name: str
    tenant_slug: str
    email: str
    person_name: str
    expires_at: datetime


class InviteAcceptRequest(BaseModel):
    password: str = Field(min_length=8, max_length=255)
    # Sprint 18: split-name flow. Old clients keep using person_name;
    # new clients send first_name + last_name and the server composes
    # both `person_name` (the legacy single field) and stores the
    # split values too.
    person_name: str | None = Field(default=None, min_length=1, max_length=255)
    first_name: str | None = Field(default=None, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)
    # The invitee must affirmatively accept the ToS + Privacy
    # Policy. Server rejects with 422 if false. For invitees who
    # are already a Person in the db (cross-tenant invite), the
    # ack is treated as a no-op since they accepted on their
    # original signup; the server still requires the field to be
    # true so the invitee saw and ticked the checkbox.
    accept_terms: bool = False


# The response is the same shape as login — frontend can drop the user
# straight into /me without an extra call.
class InviteAcceptResponse(AuthResponse):
    pass
