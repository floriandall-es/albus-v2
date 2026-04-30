"""sprint 5: availability workflow (self-service requests + approval)

Adds status pending|approved|denied + audit columns. Existing rows are
admin-created and become 'approved' by default. Only approved blocks
gate the solver — pending and denied have no scheduling effect.

Revision ID: 0010_availability_workflow
Revises: 0009_assignment_locks
Create Date: 2026-04-28
"""

from alembic import op
import sqlalchemy as sa

revision = "0010_availability_workflow"
down_revision = "0009_assignment_locks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "availability_blocks",
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default="approved",
        ),
    )
    op.create_check_constraint(
        "ck_availability_blocks_status",
        "availability_blocks",
        "status IN ('pending','approved','denied')",
    )
    op.add_column(
        "availability_blocks",
        sa.Column(
            "requested_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "availability_blocks",
        sa.Column(
            "reviewed_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "availability_blocks",
        sa.Column("reviewed_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "availability_blocks",
        sa.Column("review_notes", sa.Text(), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("availability_blocks", "review_notes")
    op.drop_column("availability_blocks", "reviewed_at")
    op.drop_column("availability_blocks", "reviewed_by_membership_id")
    op.drop_column("availability_blocks", "requested_by_membership_id")
    op.drop_constraint(
        "ck_availability_blocks_status", "availability_blocks", type_="check"
    )
    op.drop_column("availability_blocks", "status")
