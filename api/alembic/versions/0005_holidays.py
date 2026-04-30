"""sprint 4: holidays + tenant country/region defaults

Tenant-scoped holidays table with RLS. Holidays come from three sources:
- 'national' (e.g. España's national days)
- 'regional' (e.g. autonomous community-specific)
- 'custom'   (admin-added, anything that doesn't fit the canonical lists)

Multiple sources can land on the same date with different names (e.g. a
regional patron saint that coincides with a national holiday). The unique
key tolerates that but blocks duplicate (date, name) pairs.

Tenants gain country_code (ISO 3166-1 alpha-2) and region_code (e.g. ES-MD)
as the defaults the admin chose during signup / onboarding — used by the
"import festivos" action so the admin doesn't have to pick the country every
year.

Revision ID: 0005_holidays
Revises: 0004_tenant_onboarding
Create Date: 2026-04-28
"""

from alembic import op
import sqlalchemy as sa

revision = "0005_holidays"
down_revision = "0004_tenant_onboarding"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("country_code", sa.String(length=8), nullable=True),
    )
    op.add_column(
        "tenants",
        sa.Column("region_code", sa.String(length=16), nullable=True),
    )

    op.create_table(
        "holidays",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("source", sa.String(length=16), nullable=False),
        sa.Column("region_code", sa.String(length=16), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "source IN ('national','regional','custom')",
            name="ck_holidays_source",
        ),
        sa.UniqueConstraint(
            "tenant_id", "date", "name", name="uq_holidays_tenant_date_name"
        ),
    )
    op.create_index("ix_holidays_tenant_id", "holidays", ["tenant_id"])
    op.create_index("ix_holidays_tenant_date", "holidays", ["tenant_id", "date"])

    op.execute("ALTER TABLE holidays ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE holidays FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY holidays_tenant_isolation ON holidays
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON holidays TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE holidays_id_seq TO albus_app")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS holidays_tenant_isolation ON holidays")
    op.execute("ALTER TABLE holidays DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_holidays_tenant_date", table_name="holidays")
    op.drop_index("ix_holidays_tenant_id", table_name="holidays")
    op.drop_table("holidays")
    op.drop_column("tenants", "region_code")
    op.drop_column("tenants", "country_code")
