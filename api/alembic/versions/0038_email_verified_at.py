"""Email verification timestamp on persons.

Adds `persons.email_verified_at TIMESTAMPTZ NULL`. NULL means
"not yet verified"; a non-null timestamp records the moment
the user clicked the verification link.

Backfills every existing row to NOW() so the rollout is
non-disruptive: anyone in the database before this migration
ran is treated as already-verified (grandfathered). Fresh
signups going forward start with NULL.

Persons is NOT under RLS (it's the cross-tenant identity table,
joined through memberships); no policy work here.

Revision ID: 0038_email_verified_at
Revises: 0037_meetings
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0038_email_verified_at"
down_revision = "0037_meetings"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column(
            "email_verified_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    # Grandfather everyone already in the db. New signups from
    # this migration onward set this column themselves on first
    # confirm-click.
    op.execute(
        "UPDATE persons SET email_verified_at = NOW() "
        "WHERE email_verified_at IS NULL"
    )


def downgrade() -> None:
    op.drop_column("persons", "email_verified_at")
