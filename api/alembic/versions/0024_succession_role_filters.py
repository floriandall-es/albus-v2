"""Per-team-role filters on succession rules.

Adds `after_team_role_id` and `forbid_team_role_id` (both nullable FKs
to `slot_team_roles.id`) to `slot_succession_rules`. NULL on either
side means "any role / the slot as a whole" — preserves the legacy
behaviour, which is the default for every existing row.

Used so an admin can express e.g. "after Trasplante · Explante, no
Quirófano same day" — i.e. the rule fires only when the trigger is
that specific sub-role, not any of the slot's other roles.

The original UNIQUE(tenant_id, after_slot_id, forbid_slot_id,
days_after, applies_to) constraint is replaced with an expression
index that COALESCEs the new role columns to -1 before comparing,
so Postgres treats NULL as a distinct-from-everything-else value
(rather than Postgres's default "two NULLs are not equal" which
would silently allow duplicates).

Revision ID: 0024_succession_role_filters
Revises: 0023_schedule_reopened_at
Create Date: 2026-05-16
"""

import sqlalchemy as sa
from alembic import op

revision = "0024_succession_role_filters"
down_revision = "0023_schedule_reopened_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "slot_succession_rules",
        sa.Column(
            "after_team_role_id",
            sa.Integer(),
            sa.ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )
    op.add_column(
        "slot_succession_rules",
        sa.Column(
            "forbid_team_role_id",
            sa.Integer(),
            sa.ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )

    # Replace the existing strict UNIQUE with one that's null-safe.
    op.drop_constraint(
        "uq_succession_unique", "slot_succession_rules", type_="unique"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_succession_unique "
        "ON slot_succession_rules ("
        "  tenant_id, after_slot_id, forbid_slot_id, days_after, "
        "  applies_to, "
        "  COALESCE(after_team_role_id, -1), "
        "  COALESCE(forbid_team_role_id, -1)"
        ")"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_succession_unique")
    op.create_unique_constraint(
        "uq_succession_unique",
        "slot_succession_rules",
        ["tenant_id", "after_slot_id", "forbid_slot_id", "days_after", "applies_to"],
    )
    op.drop_column("slot_succession_rules", "forbid_team_role_id")
    op.drop_column("slot_succession_rules", "after_team_role_id")
