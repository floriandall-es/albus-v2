"""Hospital layer above Tenant.

Introduces a new top-level `hospitals` table so multiple departments
at the same physical hospital can roll up under one organizational
parent. The alpha customer (Cirugía Torácica) is one department of
Hospital La Fe — adding a hospital row lets future departments at
La Fe (Cirugía Cardiaca, Trauma, Pediatría, …) be linked siblings
instead of unrelated tenants.

Schema:
  hospitals — id, slug, name, country_code, region_code, created_at.
              No tenant_id. Shared across all tenants; readable by any
              authenticated caller. No RLS policy — this table sits
              above the per-tenant boundary.
  tenants   — gain nullable hospital_id FK (ON DELETE SET NULL so
              dropping a hospital row never cascades into tenant
              loss).

Behaviour:
  - NULL hospital_id remains the default. Existing tenants stay NULL
    and behave exactly as before — no functional change to any
    scheduler / planning / swap / availability code path.
  - Signup endpoint (post-deploy) accepts an optional hospital_name
    and find-or-creates the hospital row, then sets hospital_id on
    the new tenant. Same hospital_name from a second signup links
    the new tenant to the existing hospital row.
  - The alpha customer is backfilled via scripts.backfill_hospital.

Revision ID: 0051_hospitals
Revises: 0050_max_swaps_per_member
Create Date: 2026-05-23
"""

import sqlalchemy as sa
from alembic import op


revision = "0051_hospitals"
down_revision = "0050_max_swaps_per_member"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "hospitals",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column("slug", sa.String(64), nullable=False, unique=True),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("country_code", sa.String(8), nullable=True),
        sa.Column("region_code", sa.String(16), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    # Add the FK on tenants pointing at the new hospitals table.
    op.add_column(
        "tenants",
        sa.Column(
            "hospital_id",
            sa.Integer(),
            sa.ForeignKey("hospitals.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.create_index(
        "ix_tenants_hospital_id", "tenants", ["hospital_id"]
    )
    # Grants — hospitals is a global table; the per-tenant RLS
    # boundary doesn't apply. The app role needs full DML so the
    # signup find-or-create and any future admin tooling can write.
    op.execute(
        "GRANT SELECT, INSERT, UPDATE ON hospitals TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE hospitals_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.drop_index("ix_tenants_hospital_id", table_name="tenants")
    op.drop_column("tenants", "hospital_id")
    op.drop_table("hospitals")
