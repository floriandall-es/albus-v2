"""Per-person directory favorites ("starred contacts").

Each row records that `person_id` has starred `favorite_person_id`
in the hospital directory. Personal preference of the user — NOT
scoped per-tenant or per-hospital. The directory query later
filters by who's actually visible to the caller (their hospital,
opted-in, active), so favorites for someone outside the current
hospital simply don't surface there.

No RLS: the table is keyed by person_id and accessed only via the
/api/me/directory-favorites endpoints, which gate every row by
`person_id = ctx.person.id`. Adding tenant-scoped RLS would be
misleading — favorites are a property of the user, not of their
employment at a given tenant.

Revision ID: 0058_directory_favorites
Revises: 0057_split_phone_work_personal
Create Date: 2026-05-24
"""

import sqlalchemy as sa
from alembic import op


revision = "0058_directory_favorites"
down_revision = "0057_split_phone_work_personal"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "directory_favorites",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "favorite_person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Can't favorite yourself. Cheap check at the DB level so
        # the route validation is belt-and-braces.
        sa.CheckConstraint(
            "person_id != favorite_person_id",
            name="ck_directory_favorites_self",
        ),
        # One favorite row per (owner, target). UNIQUE here means the
        # POST endpoint can rely on UPSERT semantics (we use ON
        # CONFLICT DO NOTHING in the route) instead of pre-checking.
        sa.UniqueConstraint(
            "person_id",
            "favorite_person_id",
            name="uq_directory_favorites_pair",
        ),
    )


def downgrade() -> None:
    op.drop_table("directory_favorites")
