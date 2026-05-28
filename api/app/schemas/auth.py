from datetime import datetime
from typing import Any, Literal

from pydantic import BaseModel, EmailStr, Field


class SignupRequest(BaseModel):
    """Phase D.2 signup contract.

    Hospital → Servicio → Equipo, all bound to the CNH catalog.
    No more free-text hospital names; pick one from the seeded
    list (POST refuses anything else). Servicio is either picked
    from the chosen hospital's existing ones (join → equipo
    starts pending) or named freshly (create → equipo is
    auto-approved as the first one).
    """

    # Persona
    first_name: str = Field(min_length=1, max_length=255)
    last_name: str | None = Field(default=None, max_length=255)
    email: EmailStr
    password: str = Field(min_length=8, max_length=255)
    accept_terms: bool = False

    # Hospital — must reference a CNH-coded row. Free-text creation
    # was retired in Phase D.2; the wizard's typeahead is the only
    # way to land a hospital_id here.
    hospital_id: int

    # Servicio — exactly one of these two. If servicio_id is set,
    # the new equipo joins that existing servicio (and starts
    # pending — needs a sibling admin's approval). If
    # servicio_name is set, a fresh servicio is created and the
    # new equipo is auto-approved as the first one in it.
    servicio_id: int | None = None
    servicio_name: str | None = Field(default=None, max_length=255)

    # Equipo (tenant) — the user's team within the servicio.
    equipo_name: str = Field(min_length=1, max_length=255)

    # Opt-in flag for the transplant case log. Defaults false —
    # most equipos don't run a transplant program. Kept on signup
    # so trasplante-heavy teams don't have to flip it later from
    # /admin.
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
    # Equipos redesign (migration 0069): the Servicio this Equipo
    # belongs to. Null only for legacy tenants that pre-date the
    # Hospital layer (and were skipped by Phase A's backfill). The
    # frontend reads this to gate the "Servicio" sidebar entry and
    # the /admin/servicio page.
    servicio_id: int | None = None
    # 'none' / 'selected' / 'full' — what this equipo shares with
    # other peers in its servicio. The /admin/servicio page reads
    # and updates this.
    share_policy: str = "none"
    # 'pending' / 'approved'. Pending equipos don't appear in the
    # servicio timeline or cross-tenant meeting audiences until a
    # sibling admin approves them. All existing tenants are
    # 'approved' (Phase A default).
    approval_state: str = "approved"
    created_at: datetime
    onboarding_completed_at: datetime | None = None
    # Set by the onboarding preset step. One of 'quirurgico' / 'medico'
    # / 'otro'. Null on tenants created before this feature shipped.
    preset_kind: str | None = None
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

    # Migration 0080 / docs/billing-plan.md. `billing_model` drives
    # the onboarding picker default + the /admin/billing toggle.
    # `subscription_status` drives every banner / paywall the
    # frontend renders — null on tenants that haven't been
    # grandfathered or signed up post-billing yet.
    billing_model: str = "members_pay"
    subscription_status: str | None = None
    trial_end_at: datetime | None = None

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
    # Migration 0061: list of free-text job titles surfaced on the
    # directory card. A clinician can wear more than one hat.
    # Always a list — empty when unset. Independent of the
    # scheduling categoría.
    cargos: list[str] = []
    # Timestamp the user clicked the signup verification link.
    # Null = not yet verified — the web UI shows a "verifica tu
    # correo" banner with a resend button. Existing accounts
    # were backfilled to NOW() by migration 0038.
    email_verified_at: datetime | None = None
    # Migration 0065: per-user accent colour preference. One of the
    # 12 presets defined in web/src/lib/accent.ts. Default 'teal'
    # for everyone who hasn't touched the picker.
    preferred_accent: str = "teal"
    # Migration 0079: gates the founder dashboard. False for every
    # row by default; flipped manually via SQL for Florian's account.
    # Frontend uses this to gate the /founder route + hide its
    # entry point from the rest of the UI.
    is_founder: bool = False
    # Migration 0080: per-person subscription state, used under
    # `members_pay` billing. Default 'never_subscribed' for existing
    # rows; flipped to 'active' for alpha pilots by migration 0081.
    # The frontend reads this on /me/billing + the billing banner.
    subscription_status: str = "never_subscribed"
    trial_end_at: datetime | None = None
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
    # Migration 0061: replace the entire cargos list. Pass an empty
    # array to clear all; omit the key to leave them alone. Each
    # entry capped at 120 chars; total list capped at 10 to keep
    # the directory card readable.
    cargos: list[str] | None = Field(
        default=None,
        max_length=10,
    )


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


# Migration 0065. Valid accent values mirror web/src/lib/accent.ts
# ACCENT_PRESETS keys — keep in lockstep.
AccentName = Literal[
    "teal",
    "azul",
    "indigo",
    "violeta",
    "rosa",
    "ambar",
    "esmeralda",
    "pizarra",
    "cyan",
    "naranja",
    "lima",
    "fucsia",
]


class AppearanceUpdateRequest(BaseModel):
    """Body for PATCH /me/appearance. One field today, room to grow
    later (dark mode would land here too)."""
    preferred_accent: AccentName
