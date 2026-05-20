"""Make persons.hashed_password nullable.

Until now an invited team member only became a Person row when
they accepted the invitation. That meant the admin couldn't
schedule somebody who hadn't logged in — wrong fit for a paid
B2B tool where the admin owns the rota whether each individual
clinician uses the app or not.

After this migration the Person + Membership are created at
INVITE time (see create_invitation refactor) with
hashed_password=NULL ("pendiente"). The invitee gets a normal
password set when they later open the invitation link and
activate; cross-tenant invites of an already-active person
keep their existing password unchanged.

NULL convention:
  hashed_password IS NULL → pendiente (invited, never logged in)
  hashed_password IS NOT NULL → activo (has a working password)

Existing rows all keep their non-null bcrypt hashes — they were
created at accept time under the old flow, so they're activo
by definition. No backfill needed.

Login + forgot-password short-circuit cleanly on NULL (see
auth.py guards). The solver doesn't care — it scans Memberships,
not Persons, so pendientes get scheduled like anyone else.

Revision ID: 0043_person_password_nullable
Revises: 0042_tenant_setup_flags
Create Date: 2026-05-20
"""

import sqlalchemy as sa
from alembic import op

revision = "0043_person_password_nullable"
down_revision = "0042_tenant_setup_flags"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.alter_column(
        "persons",
        "hashed_password",
        existing_type=sa.String(length=255),
        nullable=True,
    )


def downgrade() -> None:
    # Downgrade only works if no pendientes exist; otherwise the
    # NOT NULL would fail at apply time. Caller's responsibility
    # to either delete pendientes or set placeholder hashes first.
    op.alter_column(
        "persons",
        "hashed_password",
        existing_type=sa.String(length=255),
        nullable=False,
    )
