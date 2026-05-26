"""Caller scope helpers for admin permissions.

Two possible scopes for an authenticated caller:

  - tenant_admin: caller's membership has "admin" in roles. Full
    access to everything in the tenant.
  - member:       no "admin" role. Read-only on most admin
    endpoints (existing 403 behavior).

The helpers here return a single `CallerScope` capturing which of
the two the caller is. Route handlers consume it to decide
whether to 403 on admin-only endpoints.
"""

from __future__ import annotations

from dataclasses import dataclass

from app.routes.deps import RequestContext


@dataclass(frozen=True)
class CallerScope:
    is_tenant_admin: bool

    @property
    def has_admin_powers(self) -> bool:
        """True if the caller can mutate at least SOMETHING admin-y."""
        return self.is_tenant_admin


def caller_scope(ctx: RequestContext) -> CallerScope:
    """Compute the caller's effective scope."""
    is_admin = "admin" in ctx.membership.roles
    return CallerScope(is_tenant_admin=is_admin)
