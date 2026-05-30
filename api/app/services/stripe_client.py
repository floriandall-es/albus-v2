"""Thin wrapper around stripe-python.

Two goals:

  1. **Keep call sites readable.** stripe-python's API is verbose
     (`stripe.Subscription.create(customer=..., items=[...],
     trial_period_days=..., metadata=...)`) and easy to misuse.
     This module gives the rest of the codebase narrow, well-named
     helpers (`create_admin_subscription`, `update_member_seats`,
     `pause_subscription`, …) that encapsulate the option shape.

  2. **Centralise API-key configuration.** Every call goes through
     `_with_stripe()`, which raises early if the secret key isn't
     set in settings — i.e. in dev or in test, where we want Stripe
     code to fail loud rather than silently make a no-op network
     call to nowhere. Production env (/srv/albus/.env) supplies the
     real key; tests should mock this module.

This is a pure pass-through to the Stripe SDK — no DB writes, no
business logic. Domain rules (when to create a subscription, when
to update item quantities, when to pause) live in
`app.services.billing` and the future
`app.services.subscription_reconciler`.

See docs/billing-plan.md, chunk 3.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from app.core.config import settings


logger = logging.getLogger("app.billing.stripe")


def _with_stripe():
    """Return the configured stripe module. Raises RuntimeError if
    `STRIPE_SECRET_KEY` isn't set — every caller is in a billing
    code path that's pointless without it, so failing loud beats
    a confusing "no such customer" later.

    Imported lazily so unconfigured environments (dev without
    Stripe) don't pay the import cost at app startup."""
    if not settings.stripe_secret_key:
        raise RuntimeError(
            "Stripe is not configured: set STRIPE_SECRET_KEY in /srv/albus/.env"
        )
    import stripe  # noqa: WPS433 — lazy on purpose

    stripe.api_key = settings.stripe_secret_key
    return stripe


# ---------------------------------------------------------------------------
# Customers
# ---------------------------------------------------------------------------


def create_tenant_customer(
    *,
    tenant_id: int,
    email: str,
    name: str,
) -> str:
    """Create a Stripe Customer for an equipo (tenant). Returns the
    customer ID (cus_…). The tenant_id goes in metadata so the
    webhook can resolve back to our row without a separate lookup
    table."""
    stripe = _with_stripe()
    customer = stripe.Customer.create(
        email=email,
        name=name,
        metadata={"tenant_id": str(tenant_id), "kind": "tenant"},
    )
    return customer["id"]


def create_person_customer(
    *,
    person_id: int,
    email: str,
    name: str,
) -> str:
    """Create a Stripe Customer for an individual person (used in
    members_pay mode). Person_id in metadata for webhook resolution."""
    stripe = _with_stripe()
    customer = stripe.Customer.create(
        email=email,
        name=name,
        metadata={"person_id": str(person_id), "kind": "person"},
    )
    return customer["id"]


# ---------------------------------------------------------------------------
# Subscriptions
# ---------------------------------------------------------------------------


def create_admin_subscription(
    *,
    customer_id: str,
    tenant_id: int,
    billing_model: str,
    member_quantity: int = 0,
    trial_days: int = 30,
) -> dict[str, Any]:
    """Create the tenant's Subscription. Always includes a
    `price_admin × 1` item; under `team_pays` adds a
    `price_member × N` item too. Stripe handles proration when N
    changes later.

    `trial_days` defaults to 30; callers can pass 0 for the
    grandfather flow (existing alpha pilots → straight to 'active'
    with no trial). Returns the full Subscription object so the
    caller can persist `id`, `status`, `trial_end`, etc.
    """
    stripe = _with_stripe()
    items: list[dict[str, Any]] = [
        {"price": settings.stripe_price_admin, "quantity": 1}
    ]
    if billing_model == "team_pays" and member_quantity > 0:
        items.append(
            {"price": settings.stripe_price_member, "quantity": member_quantity}
        )
    kwargs: dict[str, Any] = {
        "customer": customer_id,
        "items": items,
        "metadata": {
            "tenant_id": str(tenant_id),
            "kind": "tenant",
            "billing_model": billing_model,
        },
        # `payment_behavior=default_incomplete` would force card-up-
        # front. We want trial-without-card, so omit. Stripe defaults
        # to allowing the trial to start without a payment method.
        "payment_settings": {
            "save_default_payment_method": "on_subscription",
        },
    }
    if trial_days > 0:
        kwargs["trial_period_days"] = trial_days
    return stripe.Subscription.create(**kwargs)


def create_member_subscription(
    *,
    customer_id: str,
    person_id: int,
    tenant_id: int,
    trial_days: int = 30,
) -> dict[str, Any]:
    """Create a personal Subscription for a Person under
    `members_pay`. One Item — `price_member × 1`. tenant_id in
    metadata so the auto-pause-when-admin-lapses sweep can find
    all the member subs of a given tenant."""
    stripe = _with_stripe()
    kwargs: dict[str, Any] = {
        "customer": customer_id,
        "items": [{"price": settings.stripe_price_member, "quantity": 1}],
        "metadata": {
            "person_id": str(person_id),
            "tenant_id": str(tenant_id),
            "kind": "person",
        },
        "payment_settings": {
            "save_default_payment_method": "on_subscription",
        },
    }
    if trial_days > 0:
        kwargs["trial_period_days"] = trial_days
    return stripe.Subscription.create(**kwargs)


def update_admin_seats(
    *,
    subscription_id: str,
    new_quantity: int,
) -> dict[str, Any]:
    """Set the `price_admin` SubscriptionItem quantity on a tenant's
    subscription. Mirrors `update_member_seats` but locks onto the
    admin item by `price.id == settings.stripe_price_admin`.

    Used when an admin role flips on or off (promotion / demotion via
    /admin/team, admin-role invitations, etc.). Every tenant has at
    least one admin (the backend guards the last-admin demotion), so
    we never expect new_quantity == 0 here — but we handle the
    "delete the item" branch defensively, same shape as the member
    helper, in case a future tenant model legitimately allows an
    admin-less tenant."""
    stripe = _with_stripe()
    sub = stripe.Subscription.retrieve(subscription_id)
    admin_item_id: str | None = None
    for item in sub["items"]["data"]:
        if item["price"]["id"] == settings.stripe_price_admin:
            admin_item_id = item["id"]
            break
    if admin_item_id is None and new_quantity > 0:
        # No existing admin item — add it. Shouldn't happen on any
        # tenant created via signup (create_admin_subscription
        # always includes admin × 1) but we handle it for robustness
        # against hand-curated subs or future tenant kinds.
        return stripe.SubscriptionItem.create(
            subscription=subscription_id,
            price=settings.stripe_price_admin,
            quantity=new_quantity,
            proration_behavior="create_prorations",
        )
    if admin_item_id and new_quantity == 0:
        return stripe.SubscriptionItem.delete(
            admin_item_id, proration_behavior="create_prorations"
        )
    assert admin_item_id is not None
    return stripe.SubscriptionItem.modify(
        admin_item_id,
        quantity=new_quantity,
        proration_behavior="create_prorations",
    )


def update_member_seats(
    *,
    subscription_id: str,
    new_quantity: int,
) -> dict[str, Any]:
    """Set the `price_member` SubscriptionItem quantity on a
    tenant's `team_pays` subscription to `new_quantity`. Stripe
    handles proration of the next invoice automatically.

    The function locates the right SubscriptionItem by matching
    `price.id == settings.stripe_price_member` — Subscription
    can carry both `price_admin` and `price_member` items, and we
    must not touch the admin one.
    """
    stripe = _with_stripe()
    sub = stripe.Subscription.retrieve(subscription_id)
    member_item_id: str | None = None
    for item in sub["items"]["data"]:
        if item["price"]["id"] == settings.stripe_price_member:
            member_item_id = item["id"]
            break
    if member_item_id is None and new_quantity > 0:
        # No existing member item — add it. Happens on the first
        # team_pays activation if the subscription was created with
        # zero members initially.
        return stripe.SubscriptionItem.create(
            subscription=subscription_id,
            price=settings.stripe_price_member,
            quantity=new_quantity,
            proration_behavior="create_prorations",
        )
    if member_item_id and new_quantity == 0:
        # Removing the last member: delete the item entirely so the
        # subscription has only the admin line.
        return stripe.SubscriptionItem.delete(
            member_item_id, proration_behavior="create_prorations"
        )
    assert member_item_id is not None
    return stripe.SubscriptionItem.modify(
        member_item_id,
        quantity=new_quantity,
        proration_behavior="create_prorations",
    )


def swap_subscription_item_price(
    *,
    subscription_id: str,
    from_price: str,
    to_price: str,
) -> dict[str, Any]:
    """Swap a single SubscriptionItem from `from_price` to `to_price`
    on the given Subscription. Used under members_pay to move a
    promoted member's personal sub from price_member to price_admin
    (or back on demote). Stripe prorates the difference on the next
    invoice.

    No-op when:
      - The subscription has no item matching `from_price` (the
        person never had an item at that price — could mean their
        sub was created at a different price than expected).
      - `from_price == to_price` (same role, called defensively).

    We modify in place rather than delete+create so the Customer
    keeps continuity (no proration weirdness around mid-cycle
    create dates)."""
    if from_price == to_price:
        return {}
    stripe = _with_stripe()
    sub = stripe.Subscription.retrieve(subscription_id)
    target_item_id: str | None = None
    for item in sub["items"]["data"]:
        if item["price"]["id"] == from_price:
            target_item_id = item["id"]
            break
    if target_item_id is None:
        return {}
    return stripe.SubscriptionItem.modify(
        target_item_id,
        price=to_price,
        proration_behavior="create_prorations",
    )


def pause_subscription(subscription_id: str) -> dict[str, Any]:
    """Pause collection on a Subscription without canceling it.
    Used when an admin's sub lapses and we auto-pause every
    member's personal sub in that tenant. Resuming = call
    `resume_subscription(...)`."""
    stripe = _with_stripe()
    return stripe.Subscription.modify(
        subscription_id,
        pause_collection={"behavior": "void"},
    )


def resume_subscription(subscription_id: str) -> dict[str, Any]:
    """Unpause a previously paused Subscription."""
    stripe = _with_stripe()
    return stripe.Subscription.modify(
        subscription_id,
        pause_collection="",  # passing empty string clears the pause
    )


def cancel_subscription(subscription_id: str, *, at_period_end: bool = True) -> dict[str, Any]:
    """Cancel a Subscription. `at_period_end=True` (default) lets
    the admin/member finish the month they paid for; the webhook
    flips status to 'canceled' at period end."""
    stripe = _with_stripe()
    if at_period_end:
        return stripe.Subscription.modify(
            subscription_id, cancel_at_period_end=True
        )
    return stripe.Subscription.cancel(subscription_id)


# ---------------------------------------------------------------------------
# Checkout — first-time activation (card collection + Customer + Sub)
# ---------------------------------------------------------------------------
# Used when an admin or member clicks Activar suscripción on their
# billing surface. Stripe Checkout in `subscription` mode creates the
# Customer AND the Subscription atomically, collecting the card on a
# Stripe-hosted page so we never touch PCI data. The metadata we
# stamp on `subscription_data` lets the webhook handler resolve the
# resulting `customer.subscription.created` event back to our row.
#
# If the caller is still inside their trial window we pass
# `subscription_data.trial_end` so Stripe honors the days they were
# already promised — no charge until the original trial would have
# ended. Outside the window (trial already lapsed / never granted)
# we omit it and charging starts immediately.


def _maybe_trial_end(trial_end_at: datetime | None) -> dict[str, Any]:
    """Return a {trial_end: unix_ts} dict to splice into
    subscription_data when the caller still has trial days left,
    else an empty dict. Centralised so the admin + member checkout
    helpers stay short."""
    if trial_end_at and trial_end_at > datetime.now(timezone.utc):
        return {"trial_end": int(trial_end_at.timestamp())}
    return {}


def create_tenant_checkout_session(
    *,
    tenant_id: int,
    email: str,
    name: str,
    billing_model: str,
    member_quantity: int,
    trial_end_at: datetime | None,
    success_url: str,
    cancel_url: str,
) -> str:
    """Create a Stripe Checkout Session for the admin's first
    activation. Returns the URL to redirect the browser to.

    Adds a `price_admin × 1` line item always; under `team_pays`
    appends `price_member × member_quantity` so the admin also
    pays for the active member roster. The Subscription that
    results carries our tenant_id in metadata so the webhook flips
    the status correctly."""
    stripe = _with_stripe()
    line_items: list[dict[str, Any]] = [
        {"price": settings.stripe_price_admin, "quantity": 1}
    ]
    if billing_model == "team_pays" and member_quantity > 0:
        line_items.append(
            {"price": settings.stripe_price_member, "quantity": member_quantity}
        )
    subscription_data: dict[str, Any] = {
        "metadata": {
            "tenant_id": str(tenant_id),
            "kind": "tenant",
            "billing_model": billing_model,
        },
        **_maybe_trial_end(trial_end_at),
    }
    session = stripe.checkout.Session.create(
        mode="subscription",
        customer_email=email,
        client_reference_id=f"tenant:{tenant_id}",
        line_items=line_items,
        subscription_data=subscription_data,
        success_url=success_url,
        cancel_url=cancel_url,
        # Persist the metadata at the session level too so the
        # checkout.session.completed event can resolve back without
        # round-tripping through the Subscription.
        metadata={"tenant_id": str(tenant_id), "kind": "tenant"},
    )
    return session["url"]


def create_person_checkout_session(
    *,
    person_id: int,
    tenant_id: int,
    email: str,
    name: str,
    trial_end_at: datetime | None,
    success_url: str,
    cancel_url: str,
) -> str:
    """Create a Stripe Checkout Session for a member's personal
    activation under members_pay. One `price_member × 1` line.
    person_id + tenant_id in metadata so the webhook can resolve
    back AND so the auto-pause-when-admin-lapses sweep can find
    member subs of a given tenant."""
    stripe = _with_stripe()
    subscription_data: dict[str, Any] = {
        "metadata": {
            "person_id": str(person_id),
            "tenant_id": str(tenant_id),
            "kind": "person",
        },
        **_maybe_trial_end(trial_end_at),
    }
    session = stripe.checkout.Session.create(
        mode="subscription",
        customer_email=email,
        client_reference_id=f"person:{person_id}",
        line_items=[
            {"price": settings.stripe_price_member, "quantity": 1}
        ],
        subscription_data=subscription_data,
        success_url=success_url,
        cancel_url=cancel_url,
        metadata={"person_id": str(person_id), "kind": "person"},
    )
    return session["url"]


# ---------------------------------------------------------------------------
# Customer Portal — hosted card-management UI
# ---------------------------------------------------------------------------


def create_portal_session(
    *,
    customer_id: str,
    return_url: str,
) -> str:
    """Create a Stripe Customer Portal session and return the URL
    to redirect to. The Portal handles card update, invoice
    history, tax ID, and (configurably) cancellation. `return_url`
    is where Stripe sends the user back when they're done — should
    be /admin/billing or /me/billing as appropriate."""
    stripe = _with_stripe()
    session = stripe.billing_portal.Session.create(
        customer=customer_id, return_url=return_url
    )
    return session["url"]


# ---------------------------------------------------------------------------
# Webhook signature verification
# ---------------------------------------------------------------------------


def construct_webhook_event(
    payload: bytes,
    signature_header: str,
) -> dict[str, Any]:
    """Verify the webhook signature and return the parsed event.
    Raises if signature is invalid or the secret isn't configured
    — webhook handler must catch and 400.

    Stripe re-delivers events on any non-2xx, so verification + a
    quick idempotency check (via `stripe_events.event_id`) are
    enough; we don't need to handle ordering or replay attacks
    beyond that."""
    if not settings.stripe_webhook_secret:
        raise RuntimeError(
            "Stripe webhook is not configured: set STRIPE_WEBHOOK_SECRET"
        )
    stripe = _with_stripe()
    return stripe.Webhook.construct_event(
        payload, signature_header, settings.stripe_webhook_secret
    )
