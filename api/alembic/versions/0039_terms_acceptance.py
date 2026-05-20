"""Terms-of-Service + Privacy-Policy acceptance on persons.

Adds two columns to `persons`:
  - terms_accepted_at      TIMESTAMPTZ NULL
  - terms_accepted_version VARCHAR(16) NULL

We track BOTH a timestamp and the version string the user
acknowledged. When the legal text is updated (bumping the
version constant in code), the frontend can compare against
`terms_accepted_version` and re-prompt for re-acceptance.

Existing rows are backfilled with the current version ('1.0')
at NOW(). Rationale: grandfathering existing users with
version=NULL would force everyone in the db to immediately
re-accept on next login, which is worse UX than treating the
v1 launch text as having always applied. If the legal team
substantively rewrites the terms later, we bump the version
and explicit re-acceptance prompts kick in for everyone.

Revision ID: 0039_terms_acceptance
Revises: 0038_email_verified_at
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0039_terms_acceptance"
down_revision = "0038_email_verified_at"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column(
            "terms_accepted_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "persons",
        sa.Column(
            "terms_accepted_version",
            sa.String(length=16),
            nullable=True,
        ),
    )
    # Grandfather every existing row to v1.0 as of now. Fresh signups
    # set their own values via the signup / invitation-accept flow.
    op.execute(
        "UPDATE persons "
        "SET terms_accepted_at = NOW(), terms_accepted_version = '1.0' "
        "WHERE terms_accepted_at IS NULL"
    )


def downgrade() -> None:
    op.drop_column("persons", "terms_accepted_version")
    op.drop_column("persons", "terms_accepted_at")
