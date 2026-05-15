"""Add persons.avatar_url for profile photos.

Stores the relative path of the resized 128x128 JPEG (e.g.
/api/avatars/12-ab12cd34.jpg) served by FastAPI from the avatars
volume. Null when the person hasn't uploaded a photo — the UI falls
back to a colored-initials chip.

Revision ID: 0022_person_avatar
Revises: 0021_slot_color
Create Date: 2026-05-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0022_person_avatar"
down_revision = "0021_slot_color"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column("avatar_url", sa.String(length=512), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("persons", "avatar_url")
