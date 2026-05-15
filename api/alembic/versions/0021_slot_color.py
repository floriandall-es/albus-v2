"""Add slots.color so admins can colour-code slot row dots in the grid.

Stored as a 7-char hex string (#rrggbb) or null. Nullable because most
existing slots won't have one set; the UI falls back to no dot.

Revision ID: 0021_slot_color
Revises: 0020_assignment_swap_marker
Create Date: 2026-05-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0021_slot_color"
down_revision = "0020_assignment_swap_marker"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "slots",
        sa.Column("color", sa.String(length=7), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("slots", "color")
