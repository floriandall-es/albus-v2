"""POST /api/stripe/webhook — Stripe Billing webhook handler.

Idempotent: every event Stripe sends carries an `evt_…` id, and
we record those in `stripe_events` with a UNIQUE constraint on
`event_id`. Re-delivered events short-circuit at the insert step
without re-running the handler. Stripe re-delivers on any non-2xx
response, on timeouts, and occasionally on success (network blips
on their side), so this matters.

Events we care about today:

  - customer.subscription.created
  - customer.subscription.updated
  - customer.subscription.deleted
  - customer.subscription.trial_will_end       (3-day-out heads-up)
  - invoice.paid
  - invoice.payment_failed

Each one resolves the affected row (tenant or person) via the
`metadata.tenant_id` / `metadata.person_id` we stamped at
Subscription creation in app/services/stripe_client.py — no
reverse-lookup table needed.

What this handler does NOT do (yet):

  - Send transactional emails (chunk 14 — wired up after the
    email templates are written).
  - Auto-pause member subscriptions when the admin's lapses
    (chunk 4b — added once we have a member roster query).

Status updates happen via the `AdminSessionLocal` bypass: we
need to write to `tenants` / `persons` cross-tenant (the webhook
isn't scoped to any one bearer), so RLS would otherwise block us.

See docs/billing-plan.md, chunk 4.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any

from fastapi import APIRouter, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.db.session import AdminSessionLocal
from app.models import Person, StripeEvent, Tenant
from app.services import billing_emails, stripe_client


logger = logging.getLogger("app.billing.webhook")
router = APIRouter()


# Subscription event types we react to. Anything else gets recorded
# in stripe_events (audit) but doesn't touch business state.
_HANDLED_TYPES: frozenset[str] = frozenset(
    {
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
        "customer.subscription.trial_will_end",
        "invoice.paid",
        "invoice.payment_failed",
    }
)


@router.post("/stripe/webhook", status_code=status.HTTP_200_OK)
async def stripe_webhook(request: Request) -> Response:
    """Entry point Stripe POSTs to. Reads the raw body (signature
    verification requires the unparsed bytes), verifies, persists
    the event row, dispatches to a handler.

    Returns 200 on success (Stripe stops re-delivering) and 400
    on signature mismatch / malformed payload. Internal errors get
    500 so Stripe retries; we don't want to silently lose events
    when a handler crashes."""
    payload = await request.body()
    sig_header = request.headers.get("stripe-signature", "")

    # Step 1: signature verification. Bad signature → 400 (Stripe
    # knows not to retry; this is either a misconfiguration or an
    # attacker probing the endpoint).
    try:
        event = stripe_client.construct_webhook_event(payload, sig_header)
    except RuntimeError as e:
        # Webhook secret not configured — 503 so it's loud in logs.
        logger.error("Webhook secret missing: %s", e)
        raise HTTPException(status_code=503, detail="Webhook unconfigured")
    except Exception as e:
        logger.warning("Stripe webhook signature failed: %s", e)
        raise HTTPException(status_code=400, detail="Bad signature")

    event_id: str = event["id"]
    event_type: str = event["type"]

    # Step 2: idempotency. INSERT … ON CONFLICT DO NOTHING via a
    # plain INSERT + IntegrityError catch — keeps the round-trip
    # to one query for the happy (new event) path.
    db = AdminSessionLocal()
    try:
        evt_row = StripeEvent(
            event_id=event_id,
            type=event_type,
            payload=event,
        )
        db.add(evt_row)
        try:
            db.flush()
        except IntegrityError:
            db.rollback()
            logger.info(
                "Stripe webhook %s (%s) already processed, skipping",
                event_id,
                event_type,
            )
            return Response(status_code=200)

        # Step 3: dispatch (only for types we react to).
        if event_type in _HANDLED_TYPES:
            try:
                _dispatch(db, event_type, event["data"]["object"])
            except Exception as exc:  # noqa: BLE001
                # Stamp the error on the row but re-raise so Stripe
                # retries (5xx response).
                evt_row.error = str(exc)[:1000]
                db.commit()
                logger.exception(
                    "Stripe webhook %s (%s) handler failed",
                    event_id,
                    event_type,
                )
                raise HTTPException(status_code=500, detail="Handler failed")

        evt_row.processed_at = datetime.now(timezone.utc)
        db.commit()
    finally:
        db.close()

    return Response(status_code=200)


# ---------------------------------------------------------------------------
# Dispatch + handlers
# ---------------------------------------------------------------------------


def _dispatch(db, event_type: str, obj: dict[str, Any]) -> None:
    """Route a Stripe event to the right handler. `obj` is the
    `data.object` from the webhook payload — either a Subscription
    or an Invoice depending on the event type."""
    if event_type in (
        "customer.subscription.created",
        "customer.subscription.updated",
        "customer.subscription.deleted",
    ):
        _handle_subscription_state(db, obj)
        return
    if event_type == "customer.subscription.trial_will_end":
        # Stripe sends this 3 days before trial_end. We persist the
        # subscription row update (status is still 'trialing') and
        # let the email worker pick up the reminder via the daily
        # trial-ending cron — keeps webhook handler simple.
        _handle_subscription_state(db, obj)
        return
    if event_type == "invoice.paid":
        # The subsequent customer.subscription.updated will sync our
        # status; the invoice event itself doesn't need a separate
        # write. Recorded in stripe_events for the audit trail.
        return
    if event_type == "invoice.payment_failed":
        # Same: the matching customer.subscription.updated (with
        # status='past_due') is what flips our row.
        return


def _handle_subscription_state(db, sub: dict[str, Any]) -> None:
    """Resolve sub → our row (Tenant or Person) and copy status +
    trial_end across. `sub` is a Stripe Subscription object; the
    `metadata.kind` field tells us which side we're on."""
    metadata = sub.get("metadata") or {}
    kind = metadata.get("kind")
    new_status = sub.get("status")
    trial_end_unix = sub.get("trial_end")
    trial_end_at = (
        datetime.fromtimestamp(trial_end_unix, tz=timezone.utc)
        if trial_end_unix
        else None
    )
    sub_id = sub["id"]

    if kind == "tenant":
        tenant_id_str = metadata.get("tenant_id")
        if not tenant_id_str:
            logger.warning("Subscription %s missing tenant_id metadata", sub_id)
            return
        tenant = db.execute(
            select(Tenant).where(Tenant.id == int(tenant_id_str))
        ).scalar_one_or_none()
        if tenant is None:
            logger.warning(
                "Subscription %s tenant_id=%s not found", sub_id, tenant_id_str
            )
            return
        # Capture the prior status BEFORE we mutate the row so we
        # can fire the right lifecycle email on the transition. We
        # use the old status, not the old trial_end, because all
        # the interesting events are status flips.
        old_status = tenant.subscription_status
        tenant.stripe_subscription_id = sub_id
        tenant.subscription_status = new_status
        tenant.trial_end_at = trial_end_at
        # First-time activation comes through Checkout, which
        # creates the Customer for us. Persist its id the first
        # time we see it so the Portal launcher on /admin/billing
        # becomes usable (it gates on stripe_customer_id).
        sub_customer_id = sub.get("customer")
        if sub_customer_id and not tenant.stripe_customer_id:
            tenant.stripe_customer_id = sub_customer_id
        db.flush()
        _fire_admin_transition_emails(db, tenant, old_status, new_status)
        return

    if kind == "person":
        person_id_str = metadata.get("person_id")
        if not person_id_str:
            logger.warning("Subscription %s missing person_id metadata", sub_id)
            return
        person = db.execute(
            select(Person).where(Person.id == int(person_id_str))
        ).scalar_one_or_none()
        if person is None:
            logger.warning(
                "Subscription %s person_id=%s not found", sub_id, person_id_str
            )
            return
        old_status = person.subscription_status
        person.stripe_subscription_id = sub_id
        person.subscription_status = new_status
        person.trial_end_at = trial_end_at
        # First-time activation: capture the Customer id Stripe
        # created during Checkout so the Portal launcher on
        # /me/billing becomes usable.
        sub_customer_id = sub.get("customer")
        if sub_customer_id and not person.stripe_customer_id:
            person.stripe_customer_id = sub_customer_id
        db.flush()
        # Person subs are members_pay only; find their tenant via
        # the metadata.tenant_id we stamp at sub creation, then fire
        # the right lifecycle email.
        member_tenant_id_str = metadata.get("tenant_id")
        if member_tenant_id_str:
            member_tenant = db.execute(
                select(Tenant).where(Tenant.id == int(member_tenant_id_str))
            ).scalar_one_or_none()
            if member_tenant is not None:
                _fire_member_transition_emails(
                    db, member_tenant, person, old_status, new_status
                )
        return

    logger.warning("Subscription %s has unknown metadata.kind=%r", sub_id, kind)


# ---------------------------------------------------------------------------
# Lifecycle email triggers (chunk 14 follow-up)
# ---------------------------------------------------------------------------


def _fire_admin_transition_emails(
    db,
    tenant: Tenant,
    old_status: str | None,
    new_status: str | None,
) -> None:
    """Detect interesting status transitions on a tenant sub and
    fire the matching lifecycle email. Each helper is idempotent
    via billing_emails_sent so a re-delivered webhook can't
    double-send.

    Transitions covered:
      - trialing → past_due   = trial ended (no payment method)
      - active   → past_due   = a renewal charge failed
      - anything → canceled   = subscription canceled (admin
                                  action OR all retries exhausted)
    """
    if old_status == new_status:
        return
    if old_status == "trialing" and new_status == "past_due":
        billing_emails.fire_admin_trial_ended(db, tenant)
    elif old_status == "active" and new_status == "past_due":
        billing_emails.fire_admin_payment_failed(db, tenant)
    elif new_status == "canceled":
        billing_emails.fire_admin_subscription_canceled(db, tenant)


def _fire_member_transition_emails(
    db,
    tenant: Tenant,
    person: Person,
    old_status: str | None,
    new_status: str | None,
) -> None:
    """Same shape as the admin helper, for a member's personal
    subscription under members_pay."""
    if old_status == new_status:
        return
    if old_status == "trialing" and new_status == "past_due":
        billing_emails.fire_member_trial_ended(db, tenant, person)
    elif old_status == "active" and new_status == "past_due":
        billing_emails.fire_member_payment_failed(db, tenant, person)
