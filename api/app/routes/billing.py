"""Billing routes — admin-side + member-side endpoints.

Shape today (chunks 7–10 of docs/billing-plan.md):

  - PATCH /api/billing/model         tenant admin sets members_pay/team_pays
  - GET   /api/billing/summary       /admin/billing page payload
  - POST  /api/billing/portal        return Stripe Customer Portal URL
  - GET   /api/billing/me            /me/billing page payload
  - POST  /api/billing/me/portal     same for the person's own sub

Heavy Stripe work (Subscription CRUD, seat reconciliation) lives in
`app.services.stripe_client` + the webhook handler. This file is the
thin auth + persistence + DTO layer in front of those.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from sqlalchemy import func

from app.core.config import settings
from app.models import Membership, Person
from app.routes.deps import RequestContext, get_current_context
from app.services import stripe_client


logger = logging.getLogger("app.billing.routes")
router = APIRouter()


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _require_admin(ctx: RequestContext) -> None:
    """Admin-only because billing config is a per-tenant decision;
    regular members can't toggle this. Kept inline rather than
    cross-importing from routes/team.py."""
    if "admin" not in (ctx.membership.roles or []):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Admin role required",
        )


def _active_member_count(ctx: RequestContext) -> int:
    """How many seats the tenant is paying for under team_pays.

    Counts non-disabled memberships, including admins (the admin
    also occupies a seat — they get the app like everyone else).
    Pendientes count too: the admin invited them, they're part of
    the team even if they haven't activated yet. Auto-disabled
    rows are excluded because they're not consuming app access.
    """
    return int(
        ctx.db.query(func.count(Membership.id))
        .filter(
            Membership.tenant_id == ctx.tenant.id,
            Membership.disabled_at.is_(None),
        )
        .scalar()
        or 0
    )


# ---------------------------------------------------------------------------
# Billing model toggle (chunk 7)
# ---------------------------------------------------------------------------


class BillingModelUpdate(BaseModel):
    billing_model: Literal["members_pay", "team_pays"]


class BillingModelResponse(BaseModel):
    billing_model: Literal["members_pay", "team_pays"]


@router.patch("/billing/model", response_model=BillingModelResponse)
def update_billing_model(
    payload: BillingModelUpdate,
    ctx: RequestContext = Depends(get_current_context),
) -> BillingModelResponse:
    """Set the tenant's billing model. Admin-only.

    Both directions persist the column unconditionally. The
    Stripe-side rebalance (canceling member subs + adding items
    to the admin sub, or vice-versa) happens in a follow-up:
    today this just records the admin's choice.

    Called by:
      - /onboarding/done — initial pick before the trial starts
      - /admin/billing — switch later (with confirmation modal on
        the team→members direction since it pulls the rug from
        under the team)
    """
    _require_admin(ctx)
    ctx.tenant.billing_model = payload.billing_model
    ctx.db.flush()
    return BillingModelResponse(billing_model=payload.billing_model)


# ---------------------------------------------------------------------------
# Admin billing summary (chunk 9)
# ---------------------------------------------------------------------------


class BillingSummaryResponse(BaseModel):
    """Payload for the /admin/billing page.

    The frontend reads this to render the plan summary card, the
    seat breakdown (team_pays), the trial countdown banner, the
    "Gestionar facturación" button, and the model toggle (the
    backend bookkeeping for the toggle is /billing/model above).
    """
    billing_model: Literal["members_pay", "team_pays"]
    subscription_status: str | None
    trial_end_at: datetime | None
    # When the tenant has a Stripe Customer record. Frontend uses
    # this to decide whether to render the "Gestionar facturación"
    # button (no customer → grandfathered/never-checked-out tenant,
    # nothing for the Portal to manage).
    has_stripe_customer: bool
    # Seat counts. For team_pays this drives the "1 admin × 29,90
    # € + N members × 4,90 €" breakdown. For members_pay we still
    # surface them so the admin sees who's active on the app.
    seats_total: int
    seats_subscribed: int
    seats_trialing: int
    seats_paper: int  # never_subscribed + canceled — they exist but don't see the app


@router.get("/billing/summary", response_model=BillingSummaryResponse)
def billing_summary(
    ctx: RequestContext = Depends(get_current_context),
) -> BillingSummaryResponse:
    _require_admin(ctx)

    # Per-person seat breakdown. One query, group by status — the
    # tenant.team is small enough (dozens, never thousands) that
    # this is trivial. We exclude disabled memberships because
    # they're not consuming app access.
    rows = (
        ctx.db.query(Person.subscription_status, func.count(Person.id))
        .join(Membership, Membership.person_id == Person.id)
        .filter(
            Membership.tenant_id == ctx.tenant.id,
            Membership.disabled_at.is_(None),
        )
        .group_by(Person.subscription_status)
        .all()
    )
    by_status = {status_: count for status_, count in rows}

    subscribed = int(by_status.get("active", 0) + by_status.get("past_due", 0))
    trialing = int(by_status.get("trialing", 0))
    paper = int(
        by_status.get("never_subscribed", 0) + by_status.get("canceled", 0)
    )
    total = subscribed + trialing + paper

    return BillingSummaryResponse(
        billing_model=ctx.tenant.billing_model,
        subscription_status=ctx.tenant.subscription_status,
        trial_end_at=ctx.tenant.trial_end_at,
        has_stripe_customer=bool(ctx.tenant.stripe_customer_id),
        seats_total=total,
        seats_subscribed=subscribed,
        seats_trialing=trialing,
        seats_paper=paper,
    )


# ---------------------------------------------------------------------------
# Stripe Customer Portal — admin (chunk 9)
# ---------------------------------------------------------------------------


class PortalResponse(BaseModel):
    url: str


@router.post("/billing/portal", response_model=PortalResponse)
def billing_portal(
    ctx: RequestContext = Depends(get_current_context),
) -> PortalResponse:
    """Return a one-shot Stripe Customer Portal URL the frontend
    redirects to. Admin manages card / invoices / tax ID there;
    Stripe sends them back to /admin/billing afterwards.

    Refuses when the tenant has no Stripe Customer yet — that's
    the grandfathered case (alpha pilots) and the never-checked-out
    case (trial admin who hasn't subscribed). Frontend disables
    the button in those states; this 409 is a defensive belt.
    """
    _require_admin(ctx)
    if not ctx.tenant.stripe_customer_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No hay cuenta de facturación configurada todavía.",
        )
    url = stripe_client.create_portal_session(
        customer_id=ctx.tenant.stripe_customer_id,
        return_url=f"{settings.public_base_url}/admin/billing",
    )
    return PortalResponse(url=url)


# ---------------------------------------------------------------------------
# Member self-service (chunk 10)
# ---------------------------------------------------------------------------


class MyBillingResponse(BaseModel):
    """Payload for the /me/billing page.

    The same person may belong to multiple tenants; this endpoint
    answers "what's my situation IN THE CURRENT TENANT?" — i.e.
    routed through ctx.tenant.billing_model. If the tenant is
    team_pays the personal sub doesn't exist (the admin covers
    them) and the frontend renders the "Tu equipo paga tu
    suscripción" message.
    """
    tenant_billing_model: Literal["members_pay", "team_pays"]
    # Person-level subscription state. Under team_pays we still
    # report what the row says (typically 'active' from the auto-
    # provision flow) but the frontend doesn't expose any
    # actionable buttons.
    subscription_status: str
    trial_end_at: datetime | None
    has_stripe_customer: bool


@router.get("/billing/me", response_model=MyBillingResponse)
def my_billing(
    ctx: RequestContext = Depends(get_current_context),
) -> MyBillingResponse:
    return MyBillingResponse(
        tenant_billing_model=ctx.tenant.billing_model,
        subscription_status=ctx.person.subscription_status,
        trial_end_at=ctx.person.trial_end_at,
        has_stripe_customer=bool(ctx.person.stripe_customer_id),
    )


@router.post("/billing/me/portal", response_model=PortalResponse)
def my_billing_portal(
    ctx: RequestContext = Depends(get_current_context),
) -> PortalResponse:
    """Personal Stripe Customer Portal for the member's own card.
    Only meaningful under members_pay; we still allow team_pays
    members through if they happen to have a leftover personal
    customer (post-switch state) so they can manage refunds, etc.
    """
    if not ctx.person.stripe_customer_id:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="No tienes cuenta de facturación todavía.",
        )
    url = stripe_client.create_portal_session(
        customer_id=ctx.person.stripe_customer_id,
        return_url=f"{settings.public_base_url}/me/billing",
    )
    return PortalResponse(url=url)
