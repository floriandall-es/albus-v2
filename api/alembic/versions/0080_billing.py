"""Billing — Stripe subscriptions on tenants + persons.

Phase 1 of the self-serve billing rollout (see docs/billing-plan.md).
Adds the schema to support two billing models picked per-tenant at
admin signup:

  - members_pay (default): admin pays €29.90/mo on the tenant
    subscription; each member optionally subscribes for their own
    app access at €4.90/mo on a personal subscription.
  - team_pays: admin pays €29.90 + €4.90 × N on a single tenant
    subscription that covers every active member's app access.

Three pieces:

  1. `tenants` gets the admin-side billing fields plus a
     `billing_model` column flagging which mode the equipo runs on.
  2. `persons` gets per-person Stripe subscription fields. Defaults
     to `subscription_status = 'never_subscribed'` so existing rows
     are treated as "paper-only" until they actively start a trial.
  3. `stripe_events` table for webhook idempotency + audit. Stripe
     re-delivers events on failure; the `event_id` unique constraint
     guarantees we never double-process.

Alpha-pilot grandfather (set all existing tenants + their members
to `active` + far-future trial_end) is deliberately NOT in this
migration — it's a one-off data migration that runs once the
Stripe Dashboard side is configured and we know the go-live date.

Revision ID: 0080_billing
Revises: 0079_founder_dashboard
Create Date: 2026-05-28
"""

import sqlalchemy as sa
from alembic import op


revision = "0080_billing"
down_revision = "0079_founder_dashboard"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # -----------------------------------------------------------------
    # tenants — admin-side billing fields + billing_model toggle
    # -----------------------------------------------------------------
    op.add_column(
        "tenants",
        sa.Column("stripe_customer_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("stripe_subscription_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column(
            "subscription_status",
            sa.Text(),
            nullable=True,
        ),
    )
    op.create_check_constraint(
        "ck_tenants_subscription_status",
        "tenants",
        "subscription_status IS NULL OR subscription_status IN "
        "('trialing','active','past_due','unpaid','canceled')",
    )
    op.add_column(
        "tenants",
        sa.Column("trial_end_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("billing_email", sa.Text(), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("billing_tax_id", sa.Text(), nullable=True),
    )
    # billing_model is NOT NULL with a default — every existing tenant
    # gets 'members_pay' (the less-committal default). The grandfather
    # migration may flip these later for alpha pilots.
    op.add_column(
        "tenants",
        sa.Column(
            "billing_model",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'members_pay'"),
        ),
    )
    op.create_check_constraint(
        "ck_tenants_billing_model",
        "tenants",
        "billing_model IN ('members_pay','team_pays')",
    )

    # -----------------------------------------------------------------
    # persons — per-person Stripe subscription state
    # -----------------------------------------------------------------
    # Default 'never_subscribed' means: the person exists (admin
    # created them, they may be assigned to shifts) but has no app
    # access and no Stripe Customer. The members_pay invite flow
    # transitions them to 'trialing' if they click "Probar 30 días
    # gratis"; under team_pays they jump straight to 'active' (with
    # access inherited from the tenant — no personal Customer).
    op.add_column(
        "persons",
        sa.Column("stripe_customer_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "persons",
        sa.Column("stripe_subscription_id", sa.Text(), nullable=True),
    )
    op.add_column(
        "persons",
        sa.Column(
            "subscription_status",
            sa.Text(),
            nullable=False,
            server_default=sa.text("'never_subscribed'"),
        ),
    )
    op.create_check_constraint(
        "ck_persons_subscription_status",
        "persons",
        "subscription_status IN "
        "('never_subscribed','trialing','active','past_due','canceled')",
    )
    op.add_column(
        "persons",
        sa.Column("trial_end_at", sa.DateTime(timezone=True), nullable=True),
    )

    # -----------------------------------------------------------------
    # stripe_events — webhook idempotency + audit log
    # -----------------------------------------------------------------
    op.create_table(
        "stripe_events",
        sa.Column("id", sa.Integer(), primary_key=True),
        # Stripe's event ID (evt_xxxxx). UNIQUE so re-delivered
        # webhooks short-circuit before any DB writes hit the
        # business logic.
        sa.Column("event_id", sa.Text(), nullable=False, unique=True),
        sa.Column("type", sa.Text(), nullable=False),
        sa.Column(
            "payload",
            sa.dialects.postgresql.JSONB(),
            nullable=False,
        ),
        sa.Column(
            "received_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # Set when the handler completes successfully. NULL while
        # in-flight — combined with `error` we can spot stuck events.
        sa.Column(
            "processed_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
        sa.Column("error", sa.Text(), nullable=True),
    )
    op.create_index(
        "ix_stripe_events_type",
        "stripe_events",
        ["type"],
    )

    # -----------------------------------------------------------------
    # Helpful indexes — keep webhook lookups + portal redirects fast
    # -----------------------------------------------------------------
    op.create_index(
        "ix_tenants_stripe_customer_id",
        "tenants",
        ["stripe_customer_id"],
        unique=True,
        postgresql_where=sa.text("stripe_customer_id IS NOT NULL"),
    )
    op.create_index(
        "ix_tenants_stripe_subscription_id",
        "tenants",
        ["stripe_subscription_id"],
        unique=True,
        postgresql_where=sa.text("stripe_subscription_id IS NOT NULL"),
    )
    op.create_index(
        "ix_persons_stripe_customer_id",
        "persons",
        ["stripe_customer_id"],
        unique=True,
        postgresql_where=sa.text("stripe_customer_id IS NOT NULL"),
    )
    op.create_index(
        "ix_persons_stripe_subscription_id",
        "persons",
        ["stripe_subscription_id"],
        unique=True,
        postgresql_where=sa.text("stripe_subscription_id IS NOT NULL"),
    )


def downgrade() -> None:
    # Idempotency table first — nothing FKs into it.
    op.drop_index("ix_stripe_events_type", table_name="stripe_events")
    op.drop_table("stripe_events")

    # persons billing fields + their indexes
    op.drop_index(
        "ix_persons_stripe_subscription_id", table_name="persons"
    )
    op.drop_index("ix_persons_stripe_customer_id", table_name="persons")
    op.drop_constraint(
        "ck_persons_subscription_status", "persons", type_="check"
    )
    op.drop_column("persons", "trial_end_at")
    op.drop_column("persons", "subscription_status")
    op.drop_column("persons", "stripe_subscription_id")
    op.drop_column("persons", "stripe_customer_id")

    # tenants billing fields + their indexes
    op.drop_index(
        "ix_tenants_stripe_subscription_id", table_name="tenants"
    )
    op.drop_index("ix_tenants_stripe_customer_id", table_name="tenants")
    op.drop_constraint(
        "ck_tenants_billing_model", "tenants", type_="check"
    )
    op.drop_column("tenants", "billing_model")
    op.drop_column("tenants", "billing_tax_id")
    op.drop_column("tenants", "billing_email")
    op.drop_column("tenants", "trial_end_at")
    op.drop_constraint(
        "ck_tenants_subscription_status", "tenants", type_="check"
    )
    op.drop_column("tenants", "subscription_status")
    op.drop_column("tenants", "stripe_subscription_id")
    op.drop_column("tenants", "stripe_customer_id")
