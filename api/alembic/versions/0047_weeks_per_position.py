"""Multi-week rotation cycles + widen alembic_version column.

A rotation rule's cycle advances one position per (block, week)
step. For the common "Semanal" preset (k=1 block per cycle) with
N members, that meant each person held the slot for exactly 1
week before passing it on. Some teams want longer holds — "every
2 weeks", "every 4 weeks" — to reduce hand-off overhead and give
each person a contiguous block.

This migration adds an integer `weeks_per_position` column with
a default of 1 (preserves existing behaviour). The scheduler
divides the weeks-since-anchor by this value before multiplying
by the block count, so each position effectively holds for N
weeks instead of 1.

It ALSO widens alembic_version.version_num from VARCHAR(32) to
VARCHAR(64). The previous revision id for this migration —
"0047_slot_rule_weeks_per_position" — was 33 chars and crashed
the UPDATE statement at the end of the transaction with
StringDataRightTruncation. We've shortened the id to fit, but
future migrations might also want descriptive names without
bumping into the limit; widening the column once so the trap
goes away. The widening runs FIRST so the version-num update at
the very end of the transaction has room to write the new id.

Revision ID: 0047_weeks_per_position
Revises: 0046_tenant_transplants_enabled
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op


revision = "0047_weeks_per_position"
down_revision = "0046_tenant_transplants_enabled"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Widen the version_num column FIRST so the transactional DDL
    # commit at the end (which writes `revision` into this column)
    # has room. Cheap on a single-row table; idempotent against
    # a column already widened.
    op.alter_column(
        "alembic_version",
        "version_num",
        existing_type=sa.String(length=32),
        type_=sa.String(length=64),
    )
    op.add_column(
        "slot_rules",
        sa.Column(
            "weeks_per_position",
            sa.Integer,
            nullable=False,
            server_default=sa.text("1"),
        ),
    )
    op.create_check_constraint(
        "ck_slot_rules_weeks_per_position_positive",
        "slot_rules",
        "weeks_per_position >= 1",
    )


def downgrade() -> None:
    op.drop_constraint(
        "ck_slot_rules_weeks_per_position_positive",
        "slot_rules",
        type_="check",
    )
    op.drop_column("slot_rules", "weeks_per_position")
    # Deliberately leaving alembic_version.version_num at 64 chars
    # on downgrade — narrowing it back would break any in-flight
    # migration whose name happens to be over 32 chars.
