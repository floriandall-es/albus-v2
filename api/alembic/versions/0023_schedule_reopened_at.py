"""Track when (and by whom) a published schedule was reopened to draft.

Mirrors the existing `published_at` / `generated_by_membership_id`
pattern. Nullable on existing rows. The reopen endpoint flips
status published → draft; the UI surfaces the timestamp as a small
badge ("Reabierta — revisión en curso") so admins can see the
schedule has been brought back from publication.

Revision ID: 0023_schedule_reopened_at
Revises: 0022_person_avatar
Create Date: 2026-05-16
"""

import sqlalchemy as sa
from alembic import op

revision = "0023_schedule_reopened_at"
down_revision = "0022_person_avatar"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "schedules",
        sa.Column("reopened_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.add_column(
        "schedules",
        sa.Column(
            "reopened_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )


def downgrade() -> None:
    op.drop_column("schedules", "reopened_by_membership_id")
    op.drop_column("schedules", "reopened_at")
