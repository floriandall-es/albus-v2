"""sprint 5: assignment locking + manual-edit metadata

Locked assignments survive a regenerate (the solver pins them). We also
carry an updated_at so the UI can show "edited at" timestamps later.

Revision ID: 0009_assignment_locks
Revises: 0008_slot_guardia_type
Create Date: 2026-04-28
"""

from alembic import op
import sqlalchemy as sa

revision = "0009_assignment_locks"
down_revision = "0008_slot_guardia_type"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "assignments",
        sa.Column("locked_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "assignments",
        sa.Column(
            "locked_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "assignments",
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )


def downgrade() -> None:
    op.drop_column("assignments", "updated_at")
    op.drop_column("assignments", "locked_by_membership_id")
    op.drop_column("assignments", "locked_at")
