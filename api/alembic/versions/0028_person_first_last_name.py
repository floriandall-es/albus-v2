"""Split person name into first_name + last_name.

`Person.name` stays as the canonical display string (the column the
rest of the codebase reads), but two new nullable columns let us
greet by first name ("Hola, Gabriel") while still showing surnames
in the planning grid ("Sales", "Fontana"). New signups + invitation
acceptances ask for both fields; existing rows are left NULL and
the consuming code falls back to the legacy single-`name` value
with a heuristic split.

We deliberately don't backfill. Spanish names typically have two
surnames (Pérez García) — a "first token = first name, rest =
surname" heuristic gets it wrong often enough that we'd rather
admit "unknown" than misclassify and store the wrong value.

Revision ID: 0028_person_first_last_name
Revises: 0027_invitation_token_lookup
Create Date: 2026-05-18
"""

import sqlalchemy as sa
from alembic import op

revision = "0028_person_first_last_name"
down_revision = "0027_invitation_token_lookup"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column("first_name", sa.String(length=255), nullable=True),
    )
    op.add_column(
        "persons",
        sa.Column("last_name", sa.String(length=255), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("persons", "last_name")
    op.drop_column("persons", "first_name")
