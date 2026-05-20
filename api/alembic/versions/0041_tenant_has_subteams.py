"""Tenant has_subteams flag.

Adds `tenants.has_subteams BOOLEAN NOT NULL DEFAULT FALSE`.

The admin answers a "¿Vas a usar sub-equipos? (residentes,
becarios, etc.)" yes/no on the signup form. The answer drives
whether the post-signup Inicio dashboard surfaces a
"Configura tus sub-equipos" card — it does NOT take the admin
to /admin/groups during signup. The previous CTA on
/onboarding/done is replaced by this state-aware behaviour.

Existing rows default to FALSE; if an admin later decides they
do want sub-equipos they can still hit /admin/groups directly.

Revision ID: 0041_tenant_has_subteams
Revises: 0040_invitation_delivery
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0041_tenant_has_subteams"
down_revision = "0040_invitation_delivery"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "has_subteams",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
    )


def downgrade() -> None:
    op.drop_column("tenants", "has_subteams")
