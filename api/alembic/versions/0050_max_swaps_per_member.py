"""Per-tenant cap on shift swaps per member per monthly schedule.

Sales asked for a knob to limit how many cambios de turno each
team member can do per month. Without a cap, frequent swappers
can quietly redistribute the schedule the solver produced and
drain other members' fairness windows.

Adds `tenants.max_swaps_per_member_per_month` as a nullable
integer. Null = unlimited (today's behaviour). Non-null = both
sides of each fulfilled swap count toward the limit, scoped to
the month of the original assignment.

Revision ID: 0050_max_swaps_per_member
Revises: 0049_assignment_dismissed
Create Date: 2026-05-22
"""

import sqlalchemy as sa
from alembic import op


revision = "0050_max_swaps_per_member"
down_revision = "0049_assignment_dismissed"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column(
            "max_swaps_per_member_per_month",
            sa.Integer(),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("tenants", "max_swaps_per_member_per_month")
