"""Grant `albus_app` runtime role privileges on directory_favorites.

Hotfix for migration 0058 — that migration created the table but
forgot to GRANT, so every authenticated user got
"permission denied for table directory_favorites" the moment the
/api/hospital/directory route tried to look up their favorites set
on the live database.

The owner of the table at creation time (whatever role ran the
migration, typically the migrations user) keeps access, but the
NOBYPASSRLS runtime role `albus_app` that the FastAPI process
connects as had none. This migration fixes that retroactively;
0058 itself is left untouched so anyone bisecting history can see
what actually happened.

Revision ID: 0059_grant_directory_favorites
Revises: 0058_directory_favorites
Create Date: 2026-05-24
"""

from alembic import op


revision = "0059_grant_directory_favorites"
down_revision = "0058_directory_favorites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON directory_favorites "
        "TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE directory_favorites_id_seq "
        "TO albus_app"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE SELECT, INSERT, UPDATE, DELETE ON directory_favorites "
        "FROM albus_app"
    )
    op.execute(
        "REVOKE USAGE, SELECT ON SEQUENCE directory_favorites_id_seq "
        "FROM albus_app"
    )
