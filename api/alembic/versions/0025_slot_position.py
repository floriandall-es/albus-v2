"""Admin-controlled slot ordering.

Adds `slots.position` so admins can decide which order their turnos
appear in the planning grid (and elsewhere). Backfilled to match the
current alphabetical ordering so nothing visible jumps on the first
deploy. New slots get max(position) + 1 — see create_slot in the
route.

Revision ID: 0025_slot_position
Revises: 0024_succession_role_filters
Create Date: 2026-05-16
"""

import sqlalchemy as sa
from alembic import op

revision = "0025_slot_position"
down_revision = "0024_succession_role_filters"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "slots",
        sa.Column(
            "position", sa.Integer(), nullable=False, server_default="0"
        ),
    )
    # Backfill so existing rows reflect the current alphabetical
    # ordering. ROW_NUMBER is per-tenant so positions are tenant-local.
    op.execute(
        """
        UPDATE slots SET position = sub.rn - 1
        FROM (
            SELECT id, ROW_NUMBER() OVER (
                PARTITION BY tenant_id ORDER BY name, id
            ) AS rn
            FROM slots
        ) sub
        WHERE slots.id = sub.id
        """
    )
    # Drop the server-side default. New slots set position
    # explicitly in the route (max(position)+1).
    op.alter_column("slots", "position", server_default=None)


def downgrade() -> None:
    op.drop_column("slots", "position")
