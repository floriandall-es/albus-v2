from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    tenant_name: str = Field(min_length=1, max_length=255)
    # Sprint 28 / migration 0051: optional hospital this department
    # belongs to. When provided, the signup endpoint find-or-creates
    # a Hospital row (matched by exact name + country_code) and links
    # the new tenant via tenants.hospital_id. Two departments at the
    # same hospital signing up with the same hospital_name will both
    # link to the same hospitals row — that's the whole point.
    # Empty/missing = standalone tenant, no hospital row created.
    hospital_name: str | None = Field(default=None, max_length=255)
    # `person_name` is the legacy single-field name. Kept for backward
    # compatibility with older clients; the server derives it from
    # first_name + last_name when both are provided.
    person_name: str | None = Field(default=None, max_length=255)
    first_name: str | None = Field(default=None, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=255)
    # ISO 3166-1 alpha-2. Defaults to ES — Trivu's v1 launch market. Used as
    # the default for the holiday import flow; admins can change it later.
    country_code: str | None = Field(default="ES", max_length=8)
    # The user must affirmatively acknowledge the ToS + Privacy
    # Policy at signup. The client sends `true` after the user
    # ticks the checkbox; the server stores the current version
    # string and the timestamp on the new Person row. Required —
    # missing or false rejects with 422.
    accept_terms: bool = False
    # "¿Vas a usar sub-equipos? (residentes, becarios, etc.)" answered
    # at signup. Stored on the tenant; later drives the /admin Inicio
    # checklist (a "Configura tus sub-equipos" card appears only when
    # this is True).
    has_subteams: bool = False
    # Opt-in module flag for the transplant case log. Checked at
    # signup by services that actually run a transplant program;
    # ignored (left false) by everyone else, which hides the
    # /admin/trasplantes UI + 404s /api/transplants.
    transplants_enabled: bool = False


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


class ForgotPasswordRequest(BaseModel):
    email: EmailStr


class PasswordResetRequest(BaseModel):
    token: str
    new_password: str = Field(min_length=8, max_length=255)


class SelectTenantRequest(BaseModel):
    pre_auth_token: str
    tenant_id: int


class TenantPickerOption(BaseModel):
    id: int
    slug: str
    name: str


class PreAuthPersonOut(BaseModel):
    id: int
    email: str
    name: str

    model_config = {"from_attributes": True}


class TenantSelectionResponse(BaseModel):
    requires_tenant_selection: bool = True
    pre_auth_token: str
    person: PreAuthPersonOut
    available_tenants: list[TenantPickerOption]


class TenantOut(BaseModel):
    id: int
    slug: str
    name: str
    country: str | None = None
    locale: str | None = None
    country_code: str | None = None
    region_code: str | None = None
    # Sprint 28 / migration 0051: optional parent hospital. Null on
    # standalone tenants (the default). When set, hospital_name is
    # populated server-side so the frontend doesn't need a second
    # fetch for the common "show 'Department · Hospital' label" use.
    hospital_id: int | None = None
    hospital_name: str | None = None
    created_at: datetime
    onboarding_completed_at: datetime | None = None
    # Set by the onboarding preset step. One of 'quirurgico' / 'medico'
    # / 'otro'. Null on tenants created before this feature shipped.
    preset_kind: str | None = None
    # Answered yes/no at signup. Drives whether /admin Inicio surfaces
    # a "Configura tus sub-equipos" card. False by default — admins
    # who change their mind later still have /admin/groups available.
    has_subteams: bool = False
    # Opt-in module flag: when true, the "Trasplantes" sidebar
    # entry appears and /api/transplants is reachable. False by
    # default — most services don't run a transplant program.
    transplants_enabled: bool = False
    # Sprint 28 / migration 0050: cap on cambios de turno per member
    # per monthly schedule. Null = unlimited (historical default).
    # When set, both sides of every fulfilled swap count toward the
    # limit for the month of the original assignment.
    max_swaps_per_member_per_month: int | None = None
    # Per-area "I'm done configuring" timestamps. NULL = pending,
    # surfaced in the Inicio checklist; non-null = admin marked it
    # done, card disappears and the first-visit banner stops
    # showing on the corresponding subpage.
    setup_activities_completed_at: datetime | None = None
    setup_rules_completed_at: datetime | None = None
    setup_team_completed_at: datetime | None = None
    setup_subteams_completed_at: datetime | None = None

    model_config = {"from_attributes": True}


class PersonOut(BaseModel):
    id: int
    email: str
    name: str
    first_name: str | None = None
    last_name: str | None = None
    locale: str | None = None
    avatar_url: str | None = None
    # Migration 0057: two optional phones (free format), separate
    # work + personal lines. Same phone is shared across all the
    # person's tenants; per-membership share_work_phone /
    # share_personal_phone / share_whatsapp flags decide which
    # appear in any given hospital directory. WhatsApp is always
    # linked to personal_phone.
    work_phone: str | None = None
    personal_phone: str | None = None
    # Migration 0060: free-text job title surfaced on the directory
    # card. Independent of the scheduling categoría.
    cargo: str | None = None
    # Timestamp the user clicked the signup verification link.
    # Null = not yet verified — the web UI shows a "verifica tu
    # correo" banner with a resend button. Existing accounts
    # were backfilled to NOW() by migration 0038.
    email_verified_at: datetime | None = None
    created_at: datetime

    model_config = {"from_attributes": True}


class MembershipOut(BaseModel):
    id: int
    tenant_id: int
    person_id: int
    roles: list[str]
    category_id: int | None = None
    fte_pct: int = 100
    disabled_at: datetime | None = None
    # Set when the person belongs to a sub-team group. Drives the
    # per-context filtering on /me/turnos so a resident sees their
    # group's planning instead of the main team's.
    group_id: int | None = None
    # Sprint 28 / migration 0052: hospital directory opt-out. True
    # = visible in the cross-tenant directory of the parent hospital
    # (default). Frontend reads this on the settings page to render
    # the toggle's current state.
    directory_visible: bool = True
    # Per-channel opt-in. share_email defaults TRUE (institutional
    # — migration 0054). share_work_phone, share_personal_phone and
    # share_whatsapp default FALSE (migration 0057 / 0053).
    # Directory renders the corresponding button when the flag is
    # true AND the underlying datum exists. share_whatsapp always
    # targets personal_phone — the route layer hides the WhatsApp
    # link when personal_phone is null.
    share_work_phone: bool = False
    share_personal_phone: bool = False
    share_email: bool = True
    share_whatsapp: bool = False
    created_at: datetime

    model_config = {"from_attributes": True}


class DepartmentOut(BaseModel):
    id: int
    tenant_id: int
    name: str
    created_at: datetime

    model_config = {"from_attributes": True}


class RoleTypeOut(BaseModel):
    id: int
    tenant_id: int
    department_id: int | None
    name: str
    color: str | None
    defaults_jsonb: dict[str, Any]
    created_at: datetime

    model_config = {"from_attributes": True}


class AuthResponse(BaseModel):
    access_token: str
    token_type: str = "bearer"
    tenant: TenantOut
    person: PersonOut
    memberships: list[MembershipOut]
    # Mirrors MeResponse.lead_group_id — set when the person is the
    # designated lead of a group in the selected tenant. Lets the
    # login redirect send them to /admin instead of /me without an
    # extra /me round-trip.
    lead_group_id: int | None = None


class TenantSummaryCounts(BaseModel):
    categories: int
    slots: int


class MeResponse(BaseModel):
    person: PersonOut
    current_tenant: TenantOut
    memberships: list[MembershipOut]
    role_types: list[RoleTypeOut]
    departments: list[DepartmentOut]
    counts: TenantSummaryCounts
    # When this person is the lead of a group, the group's id.
    # Frontend uses it to give them the (scoped) admin UI even
    # though their role is plain "member". Null otherwise.
    lead_group_id: int | None = None


# Profile self-management. `name` retained for backward compat with the
# legacy single-field flow; new clients send first_name + last_name and
# the server composes `name` from them.
class ProfileUpdateRequest(BaseModel):
    name: str | None = Field(default=None, max_length=255)
    first_name: str | None = Field(default=None, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)
    # Migration 0057: two free-format phones, work + personal. Pass
    # an empty string to clear a field; pass None (omit the key) to
    # leave it unchanged. Length capped at 50 chars — enough for
    # "(96) 197 25 00 ext. 1234" style entries without giving us a
    # storage nightmare.
    work_phone: str | None = Field(default=None, max_length=50)
    personal_phone: str | None = Field(default=None, max_length=50)
    # Migration 0060: free-text job title. Empty string clears;
    # None (omitted key) leaves the existing value alone.
    cargo: str | None = Field(default=None, max_length=120)


class PasswordChangeRequest(BaseModel):
    current_password: str
    new_password: str = Field(min_length=8, max_length=255)


class EmailChangeRequest(BaseModel):
    current_password: str
    new_email: EmailStr


class EmailChangeRequested(BaseModel):
    """Response shape for POST /me/email — the email is NOT yet
    changed. Confirmation link sent to new_email; the actual swap
    happens via POST /me/email/confirm after the user clicks it."""
    new_email: EmailStr
    sent_to: EmailStr


class SetPresetRequest(BaseModel):
    """Body for POST /onboarding/preset. Literal-typed so FastAPI
    rejects unknown kinds with a 422 before our code runs."""
    kind: Literal["quirurgico", "medico", "otro"]
