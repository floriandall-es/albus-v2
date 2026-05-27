"""Founder dashboard — is_founder + last_login_at on persons.

Background: Florian (the founder) needs a cross-tenant overview
of every signed-up equipo without having to query the DB by hand.
We add two columns to `persons`:

  - `is_founder` BOOLEAN — gates `/api/founder/tenants`. Default
    false so existing rows + new signups stay untouched. Flipped
    manually with `UPDATE persons SET is_founder = true WHERE
    email = '<email>'` for the founder account(s).
  - `last_login_at` TIMESTAMPTZ — bumped on every successful login
    (both single-tenant fast path and the multi-tenant select-tenant
    exchange). Surfaced in the founder dashboard as a per-tenant
    rollup (MAX across the tenant's members) so Florian can spot
    inactive equipos at a glance.

No RLS work — `persons` has no RLS policy (it's the cross-tenant
identity table) so the cross-tenant rollup in the founder route
reads it directly via `AdminSessionLocal`.

Revision ID: 0079_founder_dashboard
Revises: 0078_succession_period_extras
Create Date: 2026-05-27
"""

import sqlalchemy as sa
from alembic import op


revision = "0079_founder_dashboard"
down_revision = "0078_succession_period_extras"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column(
            "is_founder",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "persons",
        sa.Column(
            "last_login_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("persons", "last_login_at")
    op.drop_column("persons", "is_founder")
