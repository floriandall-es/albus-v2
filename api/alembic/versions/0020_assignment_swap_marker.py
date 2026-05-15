"""Mark assignments that were modified by a shift swap.

Adds `assignments.swap_offer_id` — nullable FK to the swap offer that
produced the current state. Set on BOTH sides of a swap (the original
assignment and the responder's traded assignment, when applicable).
SET NULL on delete so removing a swap-offer record doesn't cascade
into clearing the assignment.

The UI uses this to render a small "swapped" icon on the planning
grid.

Revision ID: 0020_assignment_swap_marker
Revises: 0019_shift_swaps
Create Date: 2026-05-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0020_assignment_swap_marker"
down_revision = "0019_shift_swaps"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assignments",
        sa.Column(
            "swap_offer_id",
            sa.Integer(),
            sa.ForeignKey(
                "shift_swap_offers.id", ondelete="SET NULL"
            ),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("assignments", "swap_offer_id")
