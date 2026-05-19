"""Drop slots.equity_group_key — fairness is always per-slot now.

The `equity_group_key` field let admins pool multiple slots into
one fairness bucket (e.g. all guardia variants balance together).
In practice:
  - The default (NULL key → per-slot bucket) was almost always the
    right answer.
  - The pooled mode looked authoritative but produced surprises:
    "person X does 100% of localizadas, person Y does 100% of
    presenciales, totals look balanced" is technically what pooled
    fairness asks for but never what the admin meant.
  - It added a concept admins had to grok before they could trust
    the planner.

Replacement is just the per-slot default: each activity balances
its own assignments as fairly as possible. Team-composition slots
still get the existing per-role balance term (W_ROLE_BALANCE) on
top, so within a multi-role slot each rol is also balanced
separately. That covers the "balance each subfunction as well as
possible" intent.

Drops the column. No data preserved; the only thing it carried
was opt-in pooling that we're removing.

Revision ID: 0033_drop_equity_group_key
Revises: 0032_member_disabled_at
Create Date: 2026-05-19
"""

import sqlalchemy as sa
from alembic import op

revision = "0033_drop_equity_group_key"
down_revision = "0032_member_disabled_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_column("slots", "equity_group_key")


def downgrade() -> None:
    op.add_column(
        "slots",
        sa.Column("equity_group_key", sa.Text(), nullable=True),
    )
