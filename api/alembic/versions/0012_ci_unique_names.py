"""Case-insensitive unique names for categories, skills, pools

Two admins of the same tenant should not be able to create the same
category twice — but case-sensitive uniqueness lets "Adjunto" and
"adjunto" coexist. This migration replaces the existing
`UNIQUE (tenant_id, name)` constraints on categories / skills / pools
with **functional unique indexes on `(tenant_id, lower(name))`** so the
DB enforces case-insensitive uniqueness regardless of entry path
(API, CSV import, future bulk operations).

Slots are also affected (their UniqueConstraint shares the pattern) but
slot names are admin-controlled rare strings; we leave that one alone
for now to keep the scope narrow.

Revision ID: 0012_ci_unique_names
Revises: 0011_slot_equity_group
Create Date: 2026-05-04
"""

from alembic import op

revision = "0012_ci_unique_names"
down_revision = "0011_slot_equity_group"
branch_labels = None
depends_on = None


# tables that get the case-insensitive treatment in this migration
TABLES = ("categories", "pools", "skills")


def upgrade() -> None:
    for table in TABLES:
        # Drop the case-sensitive composite unique constraint.
        op.drop_constraint(f"uq_{table}_tenant_name", table, type_="unique")
        # Replace with a functional unique index on (tenant_id, lower(name)).
        # Postgres requires functions in unique indexes to be IMMUTABLE; lower()
        # qualifies. Indexed lookups also benefit any subsequent case-insensitive
        # query the routes do (Sprint 6's idempotent create flow).
        op.execute(
            f"CREATE UNIQUE INDEX uq_{table}_tenant_lower_name "
            f"ON {table} (tenant_id, lower(name))"
        )


def downgrade() -> None:
    for table in TABLES:
        op.execute(f"DROP INDEX IF EXISTS uq_{table}_tenant_lower_name")
        op.create_unique_constraint(
            f"uq_{table}_tenant_name", table, ["tenant_id", "name"]
        )
