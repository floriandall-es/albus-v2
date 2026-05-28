"""Billing email idempotency table.

Tracks which billing-lifecycle emails have already been sent to a
given recipient so the daily scheduler tick can run as many times
as it likes (laptop wakes, container restart mid-tick, deploy
flapping) without spamming admins / members with duplicate trial-
ending nudges.

Each row is one send. Uniqueness key: (kind, tenant_id, person_id)
— so an admin can receive both the day-23 and the day-29 nudge
(different `kind`), but never the same nudge twice. `person_id` is
nullable for tenant-level events (admin_payment_failed, etc.)
where the email targets every tenant admin via fan-out at send time.

Kinds we record (matches the template function names in
app/services/email_templates.py, chunk 14):

  admin_trial_ending_d7      admin_trial_ended
  admin_trial_ending_d3      admin_payment_failed
  admin_trial_ending_d1      admin_subscription_canceled
  member_trial_ending_d7     member_trial_ended
  member_trial_ending_d3     member_payment_failed
  member_trial_ending_d1
  member_switched_to_team_pays

The trial_ending kinds use days-remaining (7/3/1) in the suffix
rather than days-into-trial (23/27/29) — easier to reason about
when a tenant has a non-standard trial length (grandfather, comp
account, etc.).

Revision ID: 0082_billing_emails_sent
Revises: 0081_grandfather_alpha
Create Date: 2026-05-28
"""

import sqlalchemy as sa
from alembic import op


revision = "0082_billing_emails_sent"
down_revision = "0081_grandfather_alpha"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "billing_emails_sent",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("kind", sa.Text(), nullable=False),
        # Tenant target — non-null for every kind, since every
        # billing event happens in tenant context.
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        # Person target — non-null for the member-* kinds (which
        # email a specific clinician), null for admin-* kinds (which
        # fan out to every admin in the tenant at send time).
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "sent_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        # Email error from the most recent send attempt, NULL when
        # the row was created on a successful send. Lets us look up
        # silently-failed sends without grep-ing the API logs.
        sa.Column("error", sa.Text(), nullable=True),
    )
    # Uniqueness key. person_id IS NULL for admin-* kinds, which
    # Postgres treats as distinct under a plain UNIQUE constraint —
    # so we use a partial unique INDEX for each branch.
    op.create_index(
        "ux_billing_emails_sent_admin_kind",
        "billing_emails_sent",
        ["kind", "tenant_id"],
        unique=True,
        postgresql_where=sa.text("person_id IS NULL"),
    )
    op.create_index(
        "ux_billing_emails_sent_member_kind",
        "billing_emails_sent",
        ["kind", "tenant_id", "person_id"],
        unique=True,
        postgresql_where=sa.text("person_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ux_billing_emails_sent_member_kind",
        table_name="billing_emails_sent",
    )
    op.drop_index(
        "ux_billing_emails_sent_admin_kind",
        table_name="billing_emails_sent",
    )
    op.drop_table("billing_emails_sent")
