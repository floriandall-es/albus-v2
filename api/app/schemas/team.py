from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.schemas.auth import MembershipOut


class TeamMemberOut(BaseModel):
    """Membership joined with person info for the admin /team list."""

    id: int
    tenant_id: int
    person_id: int
    person_name: str
    # Structured last name (NULL for legacy single-name rows). Lets the
    # frontend render last-name-only labels without guessing where the
    # surname starts (e.g. "Jose Alfonso Ceron" → "Ceron").
    person_last_name: str | None = None
    person_email: str
    person_locale: str | None
    person_avatar_url: str | None = None
    roles: list[str]
    category_id: int | None
    category_name: str | None
    fte_pct: int
    # Non-null = paused membership; solver excludes them, admin
    # UI shows a "Desactivado" badge. Past assignments + login
    # remain unaffected.
    disabled_at: datetime | None = None
    # True when the underlying Person row still has a NULL
    # hashed_password — the admin invited them but they haven't yet
    # opened the activation link to set a password. The solver
    # schedules pendientes like any other member; this flag just
    # drives the "Pendiente" pill on the admin team list and
    # silences routine email notifications.
    is_pending: bool = False
    # Migration 0080. Mirrors `persons.subscription_status` — one of
    # 'never_subscribed' / 'trialing' / 'active' / 'past_due' /
    # 'canceled'. Under `team_pays` the tenant covers everyone and
    # the per-person value is whatever the grandfather/auto-flow set
    # (typically 'active' for grandfathered teams). The /admin/team
    # chip column reads this to render the subscription state pill.
    subscription_status: str = "never_subscribed"
    # Null when no trial has ever started. Used by the chip tooltip
    # to show "Prueba termina el {date}" while trialing.
    trial_end_at: datetime | None = None
    created_at: datetime


class TeamMemberUpdate(BaseModel):
    category_id: int | None = None
    fte_pct: int | None = Field(default=None, ge=0, le=200)
    roles: list[str] | None = None
    # If provided, controls the active/disabled state of the
    # membership. True = disable now (server stamps disabled_at);
    # False = re-enable (server clears disabled_at). Omit to leave
    # the state untouched.
    disabled: bool | None = None
    # Inverse view of slot_allowed_persons. The IDs of activities
    # this person should be authorized on. Server syncs the union
    # against existing rows, BUT only for slots that are already
    # restricted — unrestricted slots stay unrestricted (we'd
    # silently turn "Todo el equipo" into "everyone-except-Pérez"
    # otherwise, a side effect this view should not produce).
    allowed_slot_ids: list[int] | None = None
    # Admin override for a pendiente member's email. Only honoured
    # when the underlying Person is still pendiente (hashed_password
    # IS NULL). Once a member has activated, they change their own
    # email via /me/email's confirmation flow — admins can't reset
    # it from this endpoint. Used during migration to swap the
    # placeholder *.invalid emails the customer's residents got out
    # for their real addresses.
    email: EmailStr | None = None


class TeamInviteRequest(BaseModel):
    email: EmailStr
    person_name: str = Field(min_length=1, max_length=255)
    category_id: int | None = None
    roles: list[str] = Field(default_factory=list)
    fte_pct: int = Field(default=100, ge=0, le=200)


class TeamInviteResponse(BaseModel):
    membership: MembershipOut
    person_id: int
    email: str
    created_person: bool
