from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.schemas.auth import AuthResponse


class InviteCreateRequest(BaseModel):
    email: EmailStr
    person_name: str = Field(min_length=1, max_length=255)
    category_id: int | None = None
    roles: list[str] = Field(default_factory=lambda: ["member"])
    # When false, the endpoint creates the Person + Membership +
    # Invitation row but skips the actual email send. Used by the
    # onboarding /team step: admins want to capture the roster
    # during signup but defer the email blast until the rest of
    # the configuration (actividades, reglas) is ready. They'll
    # later trigger the per-row "Enviar invitación" button on
    # /admin/team to deliver the email.
    send_email: bool = True


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
    # Timestamp of the most recent successful SMTP send. NULL =
    # never delivered (either the row was never emailed, or the
    # very first send failed).
    last_email_sent_at: datetime | None = None
    # Error string from the most recent send attempt. NULL when
    # the last attempt succeeded. Surfaced to admin UI as the
    # "Falló" pill so SMTP issues are visible instead of silent.
    last_email_error: str | None = None
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
    # Structured first/last from the underlying Person row, if one
    # exists for this email (it does for migrated-pendiente users
    # and cross-tenant invitees). Null for fresh invites where
    # the admin only typed a composite name. The accept form uses
    # these to prefill the two name inputs cleanly — splitting
    # `person_name` on whitespace mis-handles single-token last
    # names (e.g. "Sales" landing in the first-name field).
    first_name: str | None = None
    last_name: str | None = None
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
