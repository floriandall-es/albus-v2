"""Admin-only dashboard endpoints.

Today this is one route — `/admin/pendientes` — that returns the
three things sitting in a tenant admin's queue: bloqueos waiting
for approval, invitations that were sent but the member never
activated, and open swap offers in the tenant. The /admin Inicio
page surfaces the three counts as a "Pendientes" panel, and the
sidebar shows a single roll-up badge on the Inicio link the same
way /me/mensajes shows unread DMs.

Kept in its own file because the dashboard will grow — incident
log summaries, member onboarding nudges, etc. all belong here.
"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field

from sqlalchemy import text

from app.models import (
    AvailabilityBlock,
    Invitation,
    ShiftSwapOffer,
)
from app.routes.deps import RequestContext, get_current_context

router = APIRouter()


class AdminPendientesCounts(BaseModel):
    """Three roll-ups feeding the admin Pendientes inbox.

    Each number is the count of currently-actionable rows in the
    tenant for that category:

      - bloqueos_pending : AvailabilityBlock.status == 'pending'.
        Admin needs to approve or deny.
      - invitations_open : Invitation rows still live (not
        accepted, not revoked, not expired). Admin sees who hasn't
        clicked yet; can resend.
      - swap_offers_open : ShiftSwapOffer.status == 'open' across
        the tenant. The admin doesn't action these directly (the
        requester does), but they're visible here as awareness —
        admin can chase if someone's been stuck for days.
      - swap_offers_pending_admin : ShiftSwapOffer.status ==
        'pending_admin'. The admin DOES action these — they need
        to approve or veto before the cambio takes effect (only
        relevant when tenant.swap_requires_admin_approval is on).
    """
    bloqueos_pending: int
    invitations_open: int
    swap_offers_open: int
    swap_offers_pending_admin: int
    # Phase D.3: pending sibling equipos awaiting approval in the
    # caller's Servicio. Zero for legacy tenants without a
    # servicio_id. Same shape as the other counts — one number
    # for the badge / Inicio card.
    equipos_pending: int


def _require_admin(ctx: RequestContext) -> None:
    if "admin" not in ctx.membership.roles:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )


@router.get(
    "/admin/pendientes",
    response_model=AdminPendientesCounts,
)
def admin_pendientes(
    ctx: RequestContext = Depends(get_current_context),
) -> AdminPendientesCounts:
    """Counts feeding the unified admin Pendientes inbox.

    Three small .count() queries. Polled from the admin layout
    every minute the same way /me/unread-count is — keeps the
    sidebar badge fresh without becoming a perceived expense.
    """
    _require_admin(ctx)
    now = datetime.now(timezone.utc)

    # Local pending bloqueos: every pending block in the caller's
    # tenant where this admin is allowed to review — which is either
    # (a) the block has no chosen reviewer (legacy: any local admin),
    # or (b) the block is locked to THIS membership. Blocks locked
    # to a different sibling admin must not show up in this count.
    bloqueos = (
        ctx.db.query(AvailabilityBlock)
        .filter(AvailabilityBlock.status == "pending")
        .filter(
            (AvailabilityBlock.reviewer_membership_id.is_(None))
            | (AvailabilityBlock.reviewer_membership_id == ctx.membership.id)
        )
        .count()
    )
    # Plus cross-tenant blocks where this admin is the chosen
    # reviewer (migration 0083). Lives in a sibling equipo's tenant,
    # so RLS on the caller's connection can't see it — use
    # AdminSessionLocal. Bounded to the same membership id we
    # would have allowed locally, so it's safe.
    from app.db.session import AdminSessionLocal as _Admin
    with _Admin() as adb:
        bloqueos += (
            adb.query(AvailabilityBlock)
            .filter(
                AvailabilityBlock.status == "pending",
                AvailabilityBlock.reviewer_membership_id == ctx.membership.id,
                AvailabilityBlock.tenant_id != ctx.tenant.id,
            )
            .count()
        )
    invitations = (
        ctx.db.query(Invitation)
        .filter(
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
            Invitation.expires_at > now,
        )
        .count()
    )
    swap_offers = (
        ctx.db.query(ShiftSwapOffer)
        .filter(ShiftSwapOffer.status == "open")
        .count()
    )
    # Migration 0084. Offers awaiting admin approve/veto. Indexed
    # via ix_swap_offers_pending_admin so this is fast even on a
    # busy tenant.
    swap_offers_pending_admin = (
        ctx.db.query(ShiftSwapOffer)
        .filter(ShiftSwapOffer.status == "pending_admin")
        .count()
    )

    # Pending sibling equipos in this servicio (excluding own —
    # the caller's own tenant is by definition not in this list
    # because their own approval_state isn't pending if they're
    # an admin who already activated). Zero when servicio_id is
    # null (legacy tenant).
    equipos_pending = 0
    if ctx.tenant.servicio_id is not None:
        equipos_pending = int(
            ctx.db.execute(
                text(
                    "SELECT COUNT(*) "
                    "FROM list_servicio_equipos(:sid) "
                    "WHERE approval_state = 'pending' "
                    "  AND tenant_id <> :ct"
                ),
                {"sid": ctx.tenant.servicio_id, "ct": ctx.tenant.id},
            ).scalar() or 0
        )

    return AdminPendientesCounts(
        bloqueos_pending=bloqueos,
        invitations_open=invitations,
        swap_offers_open=swap_offers,
        swap_offers_pending_admin=swap_offers_pending_admin,
        equipos_pending=equipos_pending,
    )



# ---------------------------------------------------------------------------
# Tenant settings (admin-editable display name)
# ---------------------------------------------------------------------------


class TenantSettingsOut(BaseModel):
    """What the admin sees on /admin/settings under the team card."""

    id: int
    # `name` is the human-friendly display string admins can rewrite
    # at will. Shown in the sidebar header, tenant picker, peer
    # rows in DMs, email subject lines, etc.
    name: str
    # `slug` is the URL-stable identifier — frozen by design.
    # Surfaced read-only so the admin knows what the system uses
    # for routing and can't accidentally break shared links by
    # editing it.
    slug: str
    # Parent hospital read-only (Phase D — admins don't move
    # tenants between hospitals from here).
    hospital_name: str | None


class TenantSettingsPatch(BaseModel):
    name: str = Field(min_length=2, max_length=120)


@router.get("/admin/tenant", response_model=TenantSettingsOut)
def get_tenant_settings(
    ctx: RequestContext = Depends(get_current_context),
) -> TenantSettingsOut:
    _require_admin(ctx)
    return TenantSettingsOut(
        id=ctx.tenant.id,
        name=ctx.tenant.name,
        slug=ctx.tenant.slug,
        hospital_name=ctx.tenant.hospital.name if ctx.tenant.hospital else None,
    )


@router.patch("/admin/tenant", response_model=TenantSettingsOut)
def patch_tenant_settings(
    payload: TenantSettingsPatch,
    ctx: RequestContext = Depends(get_current_context),
) -> TenantSettingsOut:
    """Rename the caller's tenant. Display-only — slug stays
    frozen so shared URLs and the tenant picker keep working.

    Same RLS-after-commit caveat as the pulse PATCH: we read
    back inside the same transaction and build the response from
    locals, never querying again after commit().
    """
    _require_admin(ctx)
    new_name = payload.name.strip()
    if not new_name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="El nombre no puede estar vacío.",
        )
    hospital_name = (
        ctx.tenant.hospital.name if ctx.tenant.hospital else None
    )
    slug = ctx.tenant.slug
    tid = ctx.tenant.id
    ctx.db.execute(
        text(
            """
            UPDATE tenants
            SET name = :name, updated_at = NOW()
            WHERE id = :tid
            """
        ),
        {"name": new_name, "tid": tid},
    )
    ctx.db.commit()
    return TenantSettingsOut(
        id=tid,
        name=new_name,
        slug=slug,
        hospital_name=hospital_name,
    )
