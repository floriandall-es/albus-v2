"""Billing domain logic (migration 0080).

This module holds the pure decision logic the rest of the codebase
needs to check billing state — plus the one impure helper that
pushes seat counts back to Stripe under `team_pays`.

Pure helpers:

  - `has_app_access(person, tenant)` — can this Person log into
    the app for THIS tenant? Routes through whichever
    `billing_model` the tenant uses.

  - `trial_horizon_end(today)` — the last date a trial admin is
    allowed to plan up to. Today + 2 calendar months (inclusive).

  - `can_generate_for(tenant, target_date, today=None)` — the
    guard called by the three planning-generation endpoints.
    Returns (False, reason) for blocked cases so the route can
    422/403 with a user-facing message.

Impure (depends on Stripe + DB):

  - `reconcile_team_pays_seats(tenant, db)` — pushes the current
    active-member count to the tenant's Stripe Subscription as
    the `price_member` quantity. No-op for grandfathered tenants
    (no Stripe sub) and for `members_pay` mode (the tenant sub
    only covers the admin in that mode).

  - `reconcile_admin_seats(tenant, db)` — pushes the current
    active-admin count as the `price_admin` quantity. Runs on
    BOTH billing models since the admin item lives on the tenant
    sub regardless of mode. Called when role or disabled state
    changes for an admin membership.

What's NOT here: Stripe SDK calls (those live in
`app.services.stripe_client`), webhook dispatch
(`app.routes.stripe_webhook`).

The pure helpers are stateless — every input comes via
arguments — so they're trivial to unit-test without a DB.

See docs/billing-plan.md, chunks 4 / 5 / 6 / 12.
"""

from __future__ import annotations

import calendar
import logging
from datetime import date

from sqlalchemy import func
from sqlalchemy.orm import Session

from app.core.config import settings
from app.models import Membership, Person, Tenant
from app.services import stripe_client


logger = logging.getLogger("app.billing.reconcile")


# Statuses that confer access. `trialing` and `active` are the
# happy paths; `past_due` is the 7-day grace window before the
# hard gate kicks in. `unpaid` and `canceled` are the no-access
# end states. `never_subscribed` means the Person opted out at
# invite-time (or pre-billing) — also no access.
_ACTIVE_STATUSES: frozenset[str] = frozenset({"trialing", "active", "past_due"})


def has_app_access(person: Person, tenant: Tenant) -> bool:
    """Can this Person open the app in this Tenant?

    Under `team_pays` the answer is the tenant's subscription
    status — the admin is paying for everyone. Under `members_pay`
    each Person pays for themselves and the answer is the person's
    own subscription status.

    Read-only views (already-published planning) bypass this check
    via dedicated endpoints; this gate covers the active-use
    surfaces (logging in, requesting swaps, viewing live updates,
    etc.). See `require_active_subscription` in `routes/deps.py`
    (to be added) for the call site.
    """
    if tenant.billing_model == "team_pays":
        return (tenant.subscription_status or "") in _ACTIVE_STATUSES
    # members_pay
    return person.subscription_status in _ACTIVE_STATUSES


def trial_horizon_end(today: date) -> date:
    """The last date a trial admin is allowed to plan up to.

    Today + 2 calendar months, inclusive of the entire end month.
    If today is 2026-05-28, the horizon ends 2026-07-31. A periodo
    or schedule with `end_date > 2026-07-31` is rejected for a
    trialing admin.

    Doesn't depend on `tenant` — every trial gets the same window.
    Called by `can_generate_for`.
    """
    # We want the last day of the month that's `today.month + 2`.
    y, m = today.year, today.month + 2
    # Roll into next year if we overflow December.
    while m > 12:
        m -= 12
        y += 1
    last_day = calendar.monthrange(y, m)[1]
    return date(y, m, last_day)


def can_generate_for(
    tenant: Tenant,
    target_date: date,
    *,
    today: date | None = None,
) -> tuple[bool, str | None]:
    """Decide whether the tenant can generate planning that ends on
    `target_date`. Used by the three generate endpoints:

      - POST /api/schedules                       (target = period last day)
      - POST /api/schedules/{id}/generate         (same)
      - POST /api/periodos/{id}/generate          (target = periodo.end_date)

    Returns `(True, None)` when allowed, `(False, reason)` when
    blocked. The reason is a Spanish user-facing string — the
    route hands it straight back as the 403 detail.

    Hard gates (no generation at all):
      - `unpaid` / `canceled` subscription
      - `None` subscription_status (shouldn't happen post-migration,
        but defensive — treats unknown as blocked)

    Trial gate (limited horizon):
      - `trialing` subscription + target beyond `trial_horizon_end`

    Otherwise allowed.
    """
    today = today or date.today()
    s = tenant.subscription_status

    if s in (None, "canceled", "unpaid"):
        return (
            False,
            "Tu suscripción no está activa. Reactívala para generar "
            "nuevas planificaciones.",
        )

    if s == "trialing":
        horizon = trial_horizon_end(today)
        if target_date > horizon:
            return (
                False,
                f"Durante la prueba sólo puedes planificar hasta "
                f"{_format_es_month_year(horizon)}. Suscríbete para "
                f"planificar todo el año.",
            )

    # 'active' or 'past_due' (within the 7-day grace window — the
    # hard-gate transition to 'unpaid' is what stops us) → unlimited
    # horizon.
    return True, None


def reconcile_admin_seats(tenant: Tenant, db: Session) -> None:
    """Push the current admin count to Stripe as the `price_admin`
    quantity on the tenant's subscription.

    Counts non-disabled memberships that carry the 'admin' role and
    calls `stripe_client.update_admin_seats` with the new quantity.
    Fires on BOTH billing models — the admin item lives on the
    tenant subscription in `members_pay` AND `team_pays` (it's the
    only item under members_pay; coexists with `price_member` under
    team_pays).

    Same silent-noop conditions as `reconcile_team_pays_seats` for
    Stripe-less envs and grandfathered tenants without a sub id.

    Call this from every route that changes the admin count:

      - PUT  /api/team/{id}            (roles or disabled toggle changes)
      - POST /api/invitations          (invite includes 'admin' role)
      - POST /api/team/invite/bulk/commit  (bulk invites with admin roles)
    """
    if not settings.stripe_secret_key:
        return
    if not tenant.stripe_subscription_id:
        return

    count = int(
        db.query(func.count(Membership.id))
        .filter(
            Membership.tenant_id == tenant.id,
            Membership.disabled_at.is_(None),
            Membership.roles.op("@>")(["admin"]),
        )
        .scalar()
        or 0
    )

    try:
        stripe_client.update_admin_seats(
            subscription_id=tenant.stripe_subscription_id,
            new_quantity=count,
        )
        logger.info(
            "Reconciled admin seats tenant=%s subscription=%s count=%d",
            tenant.id,
            tenant.stripe_subscription_id,
            count,
        )
    except Exception:
        logger.exception(
            "Stripe admin-seat reconcile failed for tenant=%s sub=%s",
            tenant.id,
            tenant.stripe_subscription_id,
        )


def reconcile_team_pays_seats(tenant: Tenant, db: Session) -> None:
    """Push the current active-member count to Stripe.

    Counts non-disabled memberships in the tenant, then calls
    `stripe_client.update_member_seats` with the new quantity for
    the `price_member` SubscriptionItem. Stripe prorates the next
    invoice automatically.

    No-op (and returns silently) when:

      - Stripe isn't configured for this environment
        (`STRIPE_SECRET_KEY` empty) — dev/test deploys.
      - `tenant.billing_model != 'team_pays'` — under `members_pay`
        the tenant sub only covers the admin (€29.90); members pay
        individually via their own Stripe subscription.
      - `tenant.stripe_subscription_id IS NULL` — grandfathered
        alpha pilots (migration 0081) and tenants that haven't gone
        through paid signup yet. Nothing to update.

    Catches every Stripe exception and just logs it — we never want
    a Stripe outage to break a member-invite request. The next
    reconcile call OR a future periodic sweep will heal any
    divergence between our seat count and Stripe's.

    Call this from every route that changes the count of active
    memberships in a tenant:

      - POST /api/invitations          (new member invited)
      - PUT  /api/team/{id}            (disabled toggle changes)
      - POST /api/team/invite/bulk/commit  (bulk invites)
      - Anywhere else a Membership is created or has disabled_at
        flipped.
    """
    if not settings.stripe_secret_key:
        return
    if tenant.billing_model != "team_pays":
        return
    if not tenant.stripe_subscription_id:
        return

    count = int(
        db.query(func.count(Membership.id))
        .filter(
            Membership.tenant_id == tenant.id,
            Membership.disabled_at.is_(None),
        )
        .scalar()
        or 0
    )

    try:
        stripe_client.update_member_seats(
            subscription_id=tenant.stripe_subscription_id,
            new_quantity=count,
        )
        logger.info(
            "Reconciled team_pays seats tenant=%s subscription=%s count=%d",
            tenant.slug,
            tenant.stripe_subscription_id,
            count,
        )
    except Exception as e:  # noqa: BLE001 — intentional broad catch
        # Don't propagate. The member-invite (or whatever) HTTP
        # response shouldn't 500 because Stripe is degraded.
        logger.error(
            "Stripe seat reconcile failed tenant=%s err=%s",
            tenant.slug,
            e,
        )


def _format_es_month_year(d: date) -> str:
    """'julio 2026' — Spanish month + year, lowercased. Inline so
    `can_generate_for` doesn't reach into a frontend i18n module."""
    months_es = (
        "enero",
        "febrero",
        "marzo",
        "abril",
        "mayo",
        "junio",
        "julio",
        "agosto",
        "septiembre",
        "octubre",
        "noviembre",
        "diciembre",
    )
    return f"{months_es[d.month - 1]} de {d.year}"
