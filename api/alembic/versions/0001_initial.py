"""initial schema with RLS

Revision ID: 0001_initial
Revises:
Create Date: 2026-04-28

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0001_initial"
down_revision = None
branch_labels = None
depends_on = None


TENANT_SCOPED_TABLES = ["memberships", "departments", "role_types"]


def upgrade() -> None:
    # Create an application role that does NOT bypass RLS.
    # The bootstrap Postgres superuser (POSTGRES_USER) bypasses RLS even with
    # FORCE — so the API runtime must connect as a non-superuser. We create
    # `albus_app` here and grant it CRUD on every table created below.
    # The API connects with APP_DATABASE_URL (see app.core.config).
    op.execute("""
        DO $$
        BEGIN
            IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'albus_app') THEN
                CREATE ROLE albus_app LOGIN PASSWORD 'albus_app_password' NOSUPERUSER NOBYPASSRLS;
            END IF;
        END
        $$;
    """)

    op.create_table(
        "tenants",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("slug", sa.String(length=64), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("country", sa.String(length=8), nullable=True),
        sa.Column("locale", sa.String(length=16), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("slug", name="uq_tenants_slug"),
    )
    op.create_index("ix_tenants_slug", "tenants", ["slug"])

    op.create_table(
        "persons",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("hashed_password", sa.String(length=255), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("locale", sa.String(length=16), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("email", name="uq_persons_email"),
    )
    op.create_index("ix_persons_email", "persons", ["email"])

    op.create_table(
        "memberships",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("person_id", sa.Integer(), sa.ForeignKey("persons.id", ondelete="CASCADE"), nullable=False),
        sa.Column("roles", postgresql.ARRAY(sa.String()), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "person_id", name="uq_membership_tenant_person"),
    )
    op.create_index("ix_memberships_tenant_id", "memberships", ["tenant_id"])
    op.create_index("ix_memberships_person_id", "memberships", ["person_id"])

    op.create_table(
        "departments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_departments_tenant_id", "departments", ["tenant_id"])

    op.create_table(
        "role_types",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("department_id", sa.Integer(), sa.ForeignKey("departments.id", ondelete="SET NULL"), nullable=True),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("color", sa.String(length=16), nullable=True),
        sa.Column("defaults_jsonb", postgresql.JSONB(), nullable=False, server_default="{}"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_role_types_tenant_id", "role_types", ["tenant_id"])
    op.create_index("ix_role_types_department_id", "role_types", ["department_id"])

    # Row-Level Security on all tenant-scoped tables.
    # Policies filter by current_setting('app.tenant_id', true) — the second
    # arg means "missing_ok": if unset, current_setting returns NULL and
    # the policy denies all rows. Application code MUST run
    # `SET LOCAL app.tenant_id = N` per request before any query.
    for table in TENANT_SCOPED_TABLES:
        op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"""
            CREATE POLICY {table}_tenant_isolation ON {table}
            USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
            WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
            """
        )

    # Grant runtime privileges to the non-superuser app role.
    for table in ("tenants", "persons", "memberships", "departments", "role_types"):
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO albus_app")
        op.execute(f"GRANT USAGE, SELECT ON SEQUENCE {table}_id_seq TO albus_app")


def downgrade() -> None:
    for table in TENANT_SCOPED_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.drop_table("role_types")
    op.drop_table("departments")
    op.drop_table("memberships")
    op.drop_table("persons")
    op.drop_table("tenants")
