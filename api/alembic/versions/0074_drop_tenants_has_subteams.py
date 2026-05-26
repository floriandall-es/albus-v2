"""Drop the now-vestigial tenants.has_subteams column.

Migration 0041 added this flag during the original sub-equipos
feature; the onboarding "¿Tienes sub-equipos?" question wrote it.
After Phase E retired the Groups machinery, the flag stopped
gating anything — every tenant is its own equipo, and the
sub-equipo concept simply doesn't exist anymore. Carrying a dead
boolean around just creates a "what's this for?" moment for the
next person reading the schema.

Revision ID: 0074_drop_tenants_has_subteams
Revises: 0073_drop_groups_machinery
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from alembic import op


revision = "0074_drop_tenants_has_subteams"
down_revision = "0073_drop_groups_machinery"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("tenants", "has_subteams")


def downgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "has_subteams",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
