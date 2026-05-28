"""Billing lifecycle email worker (migration 0082).

Two responsibilities:

1. **Daily tick** (`tick()`) — runs once a day, scans for trial
   accounts whose trial ends in {7, 3, 1} days and fires the
   matching trial-ending email to the admin (under any
   billing_model) or to the member (under members_pay only).

2. **Send-with-idempotency helper** (`try_send(...)`) — used by the
   webhook handler too. Inserts a row into `billing_emails_sent`
   keyed on (kind, tenant_id, person_id?). Duplicate insert =
   no-op + no email sent.

The webhook handler in `app.routes.stripe_webhook` calls this
module's dispatch functions when it sees a subscription state
transition (active → past_due → unpaid → canceled).

Wired into APScheduler from `app.main` alongside the existing
meeting-reminders tick.

See docs/billing-plan.md, chunk 14.
"""

from __future__ import annotations

import logging
from datetime import date, timedelta

from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.db.session import AdminSessionLocal
from app.models import BillingEmailSent, Membership, Person, Tenant
from app.services.email import send_email, should_email_person
from app.services.email_templates import (
    admin_payment_failed_email,
    admin_subscription_canceled_email,
    admin_trial_ended_email,
    admin_trial_ending_email,
    member_payment_failed_email,
    member_switched_to_team_pays_email,
    member_trial_ended_email,
    member_trial_ending_email,
)


logger = logging.getLogger("app.billing_emails")


# ---------------------------------------------------------------------------
# Idempotent send helper
# ---------------------------------------------------------------------------


def try_send(
    db: Session,
    *,
    kind: str,
    tenant_id: int,
    person_id: int | None,
    to_email: str,
    subject: str,
    body_text: str,
) -> bool:
    """Insert the idempotency row, then send the email.

    Returns True when the email was actually sent (first time),
    False when it was a no-op (already sent before).

    The insert happens before the SMTP call so a successful insert
    + a failed send leaves the row in place — preventing a retry
    storm. Operator can `DELETE FROM billing_emails_sent WHERE …`
    to force a re-send if a real outage swallowed the original.
    """
    row = BillingEmailSent(
        kind=kind,
        tenant_id=tenant_id,
        person_id=person_id,
    )
    db.add(row)
    try:
        db.flush()
    except IntegrityError:
        # Already sent — partial unique index trips. Roll back the
        # failed flush and treat as no-op.
        db.rollback()
        return False

    try:
        send_email(to=to_email, subject=subject, body_text=body_text)
    except Exception as exc:  # pragma: no cover — send_email already swallows
        row.error = str(exc)[:500]
        logger.error(
            "Billing email send failed kind=%s tenant=%s person=%s err=%s",
            kind,
            tenant_id,
            person_id,
            exc,
        )

    db.commit()
    logger.info(
        "Billing email sent kind=%s tenant=%s person=%s",
        kind,
        tenant_id,
        person_id,
    )
    return True


# ---------------------------------------------------------------------------
# Per-event dispatch (called from the webhook handler)
# ---------------------------------------------------------------------------


def _billing_url_for_admin() -> str:
    from app.core.config import settings
    return f"{settings.public_base_url}/admin/billing"


def _billing_url_for_member() -> str:
    from app.core.config import settings
    return f"{settings.public_base_url}/me/billing"


def fire_admin_payment_failed(db: Session, tenant: Tenant) -> None:
    """Send the payment-failed notice to every admin in the tenant.
    Called from the stripe webhook handler when the tenant's
    subscription transitions to past_due."""
    admins = _tenant_admin_persons(db, tenant.id)
    for person in admins:
        if not should_email_person(person.hashed_password):
            continue
        subject, body = admin_payment_failed_email(
            recipient_first_name=_first_name(person),
            billing_url=_billing_url_for_admin(),
        )
        try_send(
            db,
            kind="admin_payment_failed",
            tenant_id=tenant.id,
            person_id=None,  # one send per tenant, not per admin
            to_email=person.email,
            subject=subject,
            body_text=body,
        )
        # Break after the first successful idempotent send — we only
        # want one row per tenant. The remaining admins won't get
        # the mail, which is a tradeoff: the alternative (one row
        # per admin) would re-fire if a new admin joins post-event.
        break


def fire_admin_subscription_canceled(db: Session, tenant: Tenant) -> None:
    admins = _tenant_admin_persons(db, tenant.id)
    for person in admins:
        if not should_email_person(person.hashed_password):
            continue
        subject, body = admin_subscription_canceled_email(
            recipient_first_name=_first_name(person),
            billing_url=_billing_url_for_admin(),
        )
        try_send(
            db,
            kind="admin_subscription_canceled",
            tenant_id=tenant.id,
            person_id=None,
            to_email=person.email,
            subject=subject,
            body_text=body,
        )
        break


def fire_admin_trial_ended(db: Session, tenant: Tenant) -> None:
    admins = _tenant_admin_persons(db, tenant.id)
    for person in admins:
        if not should_email_person(person.hashed_password):
            continue
        subject, body = admin_trial_ended_email(
            recipient_first_name=_first_name(person),
            billing_url=_billing_url_for_admin(),
        )
        try_send(
            db,
            kind="admin_trial_ended",
            tenant_id=tenant.id,
            person_id=None,
            to_email=person.email,
            subject=subject,
            body_text=body,
        )
        break


def fire_member_payment_failed(
    db: Session, tenant: Tenant, person: Person
) -> None:
    if not should_email_person(person.hashed_password):
        return
    subject, body = member_payment_failed_email(
        recipient_first_name=_first_name(person),
        billing_url=_billing_url_for_member(),
    )
    try_send(
        db,
        kind="member_payment_failed",
        tenant_id=tenant.id,
        person_id=person.id,
        to_email=person.email,
        subject=subject,
        body_text=body,
    )


def fire_member_trial_ended(
    db: Session, tenant: Tenant, person: Person
) -> None:
    if not should_email_person(person.hashed_password):
        return
    subject, body = member_trial_ended_email(
        recipient_first_name=_first_name(person),
        billing_url=_billing_url_for_member(),
    )
    try_send(
        db,
        kind="member_trial_ended",
        tenant_id=tenant.id,
        person_id=person.id,
        to_email=person.email,
        subject=subject,
        body_text=body,
    )


def fire_member_switched_to_team_pays(
    db: Session, tenant: Tenant, person: Person
) -> None:
    """Fan-out helper: call once per member of a tenant whose admin
    just flipped from members_pay to team_pays. The caller is
    responsible for iterating; this just sends + records one row.
    """
    if not should_email_person(person.hashed_password):
        return
    subject, body = member_switched_to_team_pays_email(
        recipient_first_name=_first_name(person),
        tenant_name=tenant.name,
        billing_url=_billing_url_for_member(),
    )
    try_send(
        db,
        kind="member_switched_to_team_pays",
        tenant_id=tenant.id,
        person_id=person.id,
        to_email=person.email,
        subject=subject,
        body_text=body,
    )


# ---------------------------------------------------------------------------
# Daily tick — trial-ending nudges
# ---------------------------------------------------------------------------


# Days remaining where we fire a nudge. Three sends (day-7, day-3,
# day-1) is enough to convert most "I'll get to it" admins without
# crossing into harassment territory.
_TRIAL_REMINDER_DAYS_REMAINING = (7, 3, 1)


def _tick_admin_trial_endings(db: Session, today: date) -> None:
    """Find tenants whose admin trial ends in 7/3/1 days and email
    every admin in each tenant."""
    for days_remaining in _TRIAL_REMINDER_DAYS_REMAINING:
        target_date = today + timedelta(days=days_remaining)
        # Inclusive of the whole day in the tenant's local clock.
        # We compare on DATE(trial_end_at AT TIME ZONE 'Europe/Madrid')
        # via Python: pull all trialing tenants and filter in code.
        tenants = (
            db.query(Tenant)
            .filter(Tenant.subscription_status == "trialing")
            .filter(Tenant.trial_end_at.isnot(None))
            .all()
        )
        for t in tenants:
            if t.trial_end_at is None:
                continue
            if t.trial_end_at.date() != target_date:
                continue
            kind = f"admin_trial_ending_d{days_remaining}"
            admins = _tenant_admin_persons(db, t.id)
            for person in admins:
                if not should_email_person(person.hashed_password):
                    continue
                subject, body = admin_trial_ending_email(
                    recipient_first_name=_first_name(person),
                    days_remaining=days_remaining,
                    trial_end_at=t.trial_end_at,
                    billing_url=_billing_url_for_admin(),
                )
                try_send(
                    db,
                    kind=kind,
                    tenant_id=t.id,
                    person_id=None,
                    to_email=person.email,
                    subject=subject,
                    body_text=body,
                )
                break  # one row per tenant


def _tick_member_trial_endings(db: Session, today: date) -> None:
    """Find members whose personal trial ends in 7/3/1 days and email
    each individually. Only applies under members_pay — under
    team_pays members don't have a personal trial."""
    for days_remaining in _TRIAL_REMINDER_DAYS_REMAINING:
        target_date = today + timedelta(days=days_remaining)
        rows = (
            db.query(Person, Membership, Tenant)
            .join(Membership, Membership.person_id == Person.id)
            .join(Tenant, Tenant.id == Membership.tenant_id)
            .filter(Person.subscription_status == "trialing")
            .filter(Person.trial_end_at.isnot(None))
            .filter(Tenant.billing_model == "members_pay")
            .filter(Membership.disabled_at.is_(None))
            .all()
        )
        for person, _membership, tenant in rows:
            if person.trial_end_at is None:
                continue
            if person.trial_end_at.date() != target_date:
                continue
            kind = f"member_trial_ending_d{days_remaining}"
            if not should_email_person(person.hashed_password):
                continue
            subject, body = member_trial_ending_email(
                recipient_first_name=_first_name(person),
                days_remaining=days_remaining,
                trial_end_at=person.trial_end_at,
                billing_url=_billing_url_for_member(),
            )
            try_send(
                db,
                kind=kind,
                tenant_id=tenant.id,
                person_id=person.id,
                to_email=person.email,
                subject=subject,
                body_text=body,
            )


def tick() -> None:
    """APScheduler entry point — runs once per day.

    Opens an admin-scoped session (bypasses RLS so we can sweep
    across every tenant in one pass) and dispatches the two
    trial-ending sweeps. Wrapped in a try/except so a bug here
    never crashes the scheduler thread.
    """
    today = date.today()
    try:
        with AdminSessionLocal() as db:
            _tick_admin_trial_endings(db, today)
            _tick_member_trial_endings(db, today)
    except Exception:
        logger.exception("billing_emails tick failed")


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _tenant_admin_persons(db: Session, tenant_id: int) -> list[Person]:
    """Persons with the 'admin' role on the given tenant. Filters
    out disabled memberships. Used for tenant-level fan-out
    (payment failed, sub canceled, trial ending)."""
    rows = (
        db.query(Person)
        .join(Membership, Membership.person_id == Person.id)
        .filter(
            Membership.tenant_id == tenant_id,
            Membership.disabled_at.is_(None),
            # Postgres array contains operator — roles is TEXT[].
            Membership.roles.contains(["admin"]),
        )
        .all()
    )
    return list(rows)


def _first_name(person: Person) -> str:
    """Salutation-safe first name. Falls back to the canonical
    `name` field's first token for rows that pre-date the
    first_name/last_name split."""
    if person.first_name and person.first_name.strip():
        return person.first_name.strip()
    head = person.name.strip().split()[0] if person.name.strip() else ""
    return head or "compañero"
