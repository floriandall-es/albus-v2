"""Tenant transplants_enabled flag.

Adds `tenants.transplants_enabled BOOLEAN NOT NULL DEFAULT FALSE`.

Trasplantes is an opt-in module: most clinical teams have no use
for a transplant case log (it's specific to thoracic / cardiac /
abdominal transplant programs). Defaulting to FALSE keeps the
feature dormant for the 95% of tenants who don't need it — the
"Trasplantes" sidebar entry hides, and /api/transplants returns
404 across the board, so the surface area is invisible.

The admin checks an "¿Tu servicio realiza trasplantes?" box on
signup to flip this true; everyone else can ignore the feature
entirely.

Revision ID: 0046_tenant_transplants_enabled
Revises: 0045_transplants
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op


revision = "0046_tenant_transplants_enabled"
down_revision = "0045_transplants"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "transplants_enabled",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("tenants", "transplants_enabled")
