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
from pydantic import BaseModel

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
    """
    bloqueos_pending: int
    invitations_open: int
    swap_offers_open: int


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

    bloqueos = (
        ctx.db.query(AvailabilityBlock)
        .filter(AvailabilityBlock.status == "pending")
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

    return AdminPendientesCounts(
        bloqueos_pending=bloqueos,
        invitations_open=invitations,
        swap_offers_open=swap_offers,
    )
