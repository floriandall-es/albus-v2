"""Founder dashboard endpoints.

A founder-only surface (gated by Person.is_founder — migration
0079) that enumerates every signed-up equipo with per-tenant
rollups: how many members + admins it has, the most recent login
across its members, the most recent published schedule, and the
count of live (unaccepted, unrevoked, unexpired) invitations.

Cross-tenant reads happen via AdminSessionLocal — same pattern
the equipos-pendientes route uses. This is NOT request-scoped
data: we intentionally bypass RLS because the founder needs to
see every tenant, not just the one their bearer is scoped to.

Florian types `/founder` directly; the route is not wired into
the sidebar.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from sqlalchemy import text

from app.db.session import AdminSessionLocal
from app.routes.deps import RequestContext, get_current_context
from app.schemas.founder import FounderTenantSummary


router = APIRouter()


def _require_founder(ctx: RequestContext) -> None:
    """Refuse the request unless the caller's Person row has
    is_founder=true. Mirrors `_require_admin` in
    admin_dashboard.py — 403 with a generic detail string so we
    don't reveal whether the endpoint exists to non-founders."""
    if not getattr(ctx.person, "is_founder", False):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Founder role required",
        )


@router.get(
    "/founder/tenants",
    response_model=list[FounderTenantSummary],
)
def list_founder_tenants(
    ctx: RequestContext = Depends(get_current_context),
) -> list[FounderTenantSummary]:
    """All tenants in the database, with per-tenant rollups.

    Ordered by `tenants.created_at DESC` so the most recent
    signups land at the top. One round trip — the SQL joins
    hospitals + servicios and pulls aggregates via correlated
    subqueries. AdminSessionLocal bypasses RLS so cross-tenant
    counts across `memberships`, `schedules`, `invitations`
    return the full picture.

    `members_count` counts only ACTIVATED members (Person has a
    password set) that aren't disabled, matching the
    /admin/team "active roster" definition (`is_pending` in
    routes/team.py is `person.hashed_password IS NULL`).

    `admins_count` is the subset of those whose `roles` array
    contains 'admin' (per the standard role-check pattern).
    """
    _require_founder(ctx)

    admin_db = AdminSessionLocal()
    try:
        now = datetime.now(timezone.utc)
        rows = admin_db.execute(
            text(
                """
                SELECT
                    t.id            AS id,
                    t.name          AS name,
                    t.slug          AS slug,
                    h.name          AS hospital_name,
                    s.name          AS servicio_name,
                    t.created_at    AS signup_date,
                    (
                        SELECT COUNT(*)
                        FROM memberships m
                        JOIN persons p ON p.id = m.person_id
                        WHERE m.tenant_id = t.id
                          AND m.disabled_at IS NULL
                          AND p.hashed_password IS NOT NULL
                    )               AS members_count,
                    (
                        SELECT COUNT(*)
                        FROM memberships m
                        JOIN persons p ON p.id = m.person_id
                        WHERE m.tenant_id = t.id
                          AND m.disabled_at IS NULL
                          AND p.hashed_password IS NOT NULL
                          AND 'admin' = ANY(m.roles)
                    )               AS admins_count,
                    (
                        SELECT MAX(p.last_login_at)
                        FROM memberships m
                        JOIN persons p ON p.id = m.person_id
                        WHERE m.tenant_id = t.id
                    )               AS last_login_at,
                    (
                        SELECT MAX(sc.published_at)
                        FROM schedules sc
                        WHERE sc.tenant_id = t.id
                    )               AS last_schedule_published_at,
                    (
                        SELECT COUNT(*)
                        FROM invitations inv
                        WHERE inv.tenant_id = t.id
                          AND inv.accepted_at IS NULL
                          AND inv.revoked_at IS NULL
                          AND inv.expires_at > :now
                    )               AS pending_invitations_count
                FROM tenants t
                LEFT JOIN hospitals h ON h.id = t.hospital_id
                LEFT JOIN servicios s ON s.id = t.servicio_id
                ORDER BY t.created_at DESC
                """
            ),
            {"now": now},
        ).mappings().all()
        return [FounderTenantSummary(**dict(r)) for r in rows]
    finally:
        admin_db.close()
