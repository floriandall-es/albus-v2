"""Per-cell "no aplica hoy" override on assignments.

Adds a nullable `dismissed_at` timestamp to `assignments`. When set,
the assignment row represents "this slot/role/date doesn't apply" —
the cell is intentionally not staffed, distinct from "empty/unfilled"
(which is `person_id IS NULL AND dismissed_at IS NULL`).

Scheduler integration:
  - Dismissed rows are auto-locked at the same time, so the
    existing lock-carry mechanism preserves them verbatim across
    regenerations.
  - The demand-generation pass detects dismissed (slot_id, date)
    pairs and skips emitting solver demands for them, propagating
    the dismissal to every role/headcount slot on that date.

UI:
  - Planning grid renders dismissed cells with a strikethrough +
    "No aplica" label, visually distinct from the empty placeholder.
  - The assignment edit modal exposes a "No aplica hoy" button to
    mark, and "Volver a aplicar" to revert.

Revision ID: 0049_assignment_dismissed
Revises: 0048_slot_categories
Create Date: 2026-05-22
"""

import sqlalchemy as sa
from alembic import op


revision = "0049_assignment_dismissed"
down_revision = "0048_slot_categories"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assignments",
        sa.Column("dismissed_at", sa.DateTime(timezone=True), nullable=True),
    )
    # Partial index — most rows are not dismissed; only index the small
    # subset so the scheduler's "is this (slot, date) dismissed?" lookup
    # stays cheap on large schedules.
    op.create_index(
        "ix_assignments_dismissed",
        "assignments",
        ["schedule_id", "slot_id", "date"],
        postgresql_where=sa.text("dismissed_at IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("ix_assignments_dismissed", table_name="assignments")
    op.drop_column("assignments", "dismissed_at")
