"""Allow days_after = 0 on succession rules (same-day incompatibility).

The succession rule's days_after column originally constrained
BETWEEN 1 AND 14 — meaning rules could only forbid the *next* N days.
We need to also express "X and Y can't happen on the same calendar day
for the same person" (e.g. Quirófano + Consulta same day, even when
their times don't overlap). Relaxing the CHECK to BETWEEN 0 AND 14
covers that without a separate table.

Frontend surfaces the days_after=0 case as a distinct rule type
("Incompatibilidades del mismo día") for clarity, but the data shape
is the same.

Revision ID: 0017_succession_same_day
Revises: 0016_person_memberships_fn
Create Date: 2026-05-06
"""

from alembic import op

revision = "0017_succession_same_day"
down_revision = "0016_person_memberships_fn"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint(
        "ck_succession_days_after_range",
        "slot_succession_rules",
        type_="check",
    )
    op.create_check_constraint(
        "ck_succession_days_after_range",
        "slot_succession_rules",
        "days_after BETWEEN 0 AND 14",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_succession_days_after_range",
        "slot_succession_rules",
        type_="check",
    )
    op.create_check_constraint(
        "ck_succession_days_after_range",
        "slot_succession_rules",
        "days_after BETWEEN 1 AND 14",
    )
