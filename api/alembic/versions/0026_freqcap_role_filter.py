"""Per-team-role filter on frequency caps.

Adds `team_role_id` (nullable FK to slot_team_roles) to
`slot_frequency_caps`, mirroring what 0024 did for succession
rules. NULL = "any role of the named slot", the legacy semantics
and the default for every existing row. When set, the cap counts
only that specific sub-role's assignments — e.g.
"max 4 Cirujano-1 per week per person".

The original UNIQUE(tenant_id, slot_id, period) is replaced with
a Postgres expression index that COALESCEs team_role_id to -1 so
NULL is treated as a distinct-from-everything-else value (rather
than Postgres's default "NULLs are not equal" which would
silently allow duplicate any-role caps).

Revision ID: 0026_freqcap_role_filter
Revises: 0025_slot_position
Create Date: 2026-05-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0026_freqcap_role_filter"
down_revision = "0025_slot_position"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "slot_frequency_caps",
        sa.Column(
            "team_role_id",
            sa.Integer(),
            sa.ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
            nullable=True,
        ),
    )

    op.drop_constraint(
        "uq_freqcap_unique", "slot_frequency_caps", type_="unique"
    )
    op.execute(
        "CREATE UNIQUE INDEX uq_freqcap_unique "
        "ON slot_frequency_caps ("
        "  tenant_id, slot_id, period, "
        "  COALESCE(team_role_id, -1)"
        ")"
    )


def downgrade() -> None:
    op.execute("DROP INDEX IF EXISTS uq_freqcap_unique")
    op.create_unique_constraint(
        "uq_freqcap_unique",
        "slot_frequency_caps",
        ["tenant_id", "slot_id", "period"],
    )
    op.drop_column("slot_frequency_caps", "team_role_id")
