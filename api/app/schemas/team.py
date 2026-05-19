from datetime import datetime

from pydantic import BaseModel, EmailStr, Field

from app.schemas.auth import MembershipOut


class TeamMemberOut(BaseModel):
    """Membership joined with person info for the admin /team list."""

    id: int
    tenant_id: int
    person_id: int
    person_name: str
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
    # Sub-team this person belongs to (null = main team). The
    # group's lead can manage them; tenant admin always can.
    group_id: int | None = None
    group_name: str | None = None
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
    # Tenant admin only: move this member into / out of a group.
    # Null = main team. Group leads can't change this via the team
    # endpoint — they use POST /api/groups/{id}/members instead.
    group_id: int | None = None
    clear_group: bool = False


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
