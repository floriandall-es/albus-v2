"""Caller scope helpers for sub-team (Group) permissions.

Three possible scopes for an authenticated caller:

  - tenant_admin: caller's membership has "admin" in roles. Full
    access to everything in the tenant.
  - group_lead:   caller's membership is the lead_membership_id
    of some Group. Admin rights restricted to that group's
    members and slots.
  - member:       neither admin nor a lead. Read-only on most
    admin endpoints (existing 403 behavior).

The helpers here return a single `CallerScope` capturing which of
the three the caller is, plus the relevant group_id when they're
a lead. Route handlers consume it to:
  - decide whether to 403 on admin-only endpoints
  - filter list responses
  - validate that a mutation target is within scope
"""

from __future__ import annotations

from dataclasses import dataclass

from app.models import Group
from app.routes.deps import RequestContext


@dataclass(frozen=True)
class CallerScope:
    is_tenant_admin: bool
    group_id: int | None  # set when is_group_lead is True

    @property
    def is_group_lead(self) -> bool:
        return self.group_id is not None and not self.is_tenant_admin

    @property
    def has_admin_powers(self) -> bool:
        """True if the caller can mutate at least SOMETHING admin-y
        (either tenant-wide or scoped to a group)."""
        return self.is_tenant_admin or self.is_group_lead


def caller_scope(ctx: RequestContext) -> CallerScope:
    """Compute the caller's effective scope. Tenant-admin trumps
    everything; we only look up the group-lead binding if the
    caller isn't already a tenant admin (cheap optimization)."""
    is_admin = "admin" in ctx.membership.roles
    if is_admin:
        return CallerScope(is_tenant_admin=True, group_id=None)

    lead_of = (
        ctx.db.query(Group.id)
        .filter(Group.lead_membership_id == ctx.membership.id)
        .first()
    )
    if lead_of:
        return CallerScope(is_tenant_admin=False, group_id=lead_of[0])

    return CallerScope(is_tenant_admin=False, group_id=None)
