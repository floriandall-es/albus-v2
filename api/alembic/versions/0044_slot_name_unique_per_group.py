"""Allow slots in different sub-equipos to share names.

The old `uq_slots_tenant_name` constraint on (tenant_id, name)
rejected two slots with the same name even when they belonged to
different sub-equipos. In practice clinical teams reuse short
labels ("Consulta", "Planta", "Guardia") across the main team
AND each sub-equipo — every rota is its own conceptual surface,
and forcing globally unique names would force prefixes like
"R: Consulta" purely to satisfy the database.

This migration replaces the single constraint with two partial
unique indexes:

  - uq_slots_main_team_name: unique (tenant_id, name) WHERE
    group_id IS NULL — main-team slots are still unique within
    the tenant.
  - uq_slots_group_name: unique (tenant_id, group_id, name)
    WHERE group_id IS NOT NULL — sub-equipo slots are unique
    within their group only.

We use partial indexes rather than a 3-column UniqueConstraint
because Postgres treats NULLs as distinct in unique constraints
by default (so (1, NULL, 'X') and (1, NULL, 'X') would NOT
collide — wrong for main-team uniqueness). Postgres 15+ has
`UNIQUE NULLS NOT DISTINCT` but we're not yet pinning to that
version. Partial indexes give the same semantics on any modern
Postgres.

Existing data is safe: the old constraint was MORE restrictive,
so anything that satisfies it still satisfies the new pair.

Revision ID: 0044_slot_name_unique_per_group
Revises: 0043_person_password_nullable
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op


revision = "0044_slot_name_unique_per_group"
down_revision = "0043_person_password_nullable"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.drop_constraint("uq_slots_tenant_name", "slots", type_="unique")
    op.create_index(
        "uq_slots_main_team_name",
        "slots",
        ["tenant_id", "name"],
        unique=True,
        postgresql_where=sa.text("group_id IS NULL"),
    )
    op.create_index(
        "uq_slots_group_name",
        "slots",
        ["tenant_id", "group_id", "name"],
        unique=True,
        postgresql_where=sa.text("group_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_slots_group_name", table_name="slots")
    op.drop_index("uq_slots_main_team_name", table_name="slots")
    op.create_unique_constraint(
        "uq_slots_tenant_name", "slots", ["tenant_id", "name"]
    )
