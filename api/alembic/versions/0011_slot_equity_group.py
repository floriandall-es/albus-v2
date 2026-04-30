"""sprint 5.5: slots.equity_group_key

Free-text grouping tag for fairness. The solver computes one balance term
per distinct equity_group_key (NULL is its own catch-all group). Lets a
tenant balance "guardias" among themselves and "quirófano" among themselves
without lumping them together.

Slots where counts_for_equity=False are ignored for fairness entirely;
this column has no effect on them.

Revision ID: 0011_slot_equity_group
Revises: 0010_availability_workflow
Create Date: 2026-04-30
"""

from alembic import op
import sqlalchemy as sa

revision = "0011_slot_equity_group"
down_revision = "0010_availability_workflow"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "slots", sa.Column("equity_group_key", sa.Text(), nullable=True)
    )


def downgrade() -> None:
    op.drop_column("slots", "equity_group_key")
