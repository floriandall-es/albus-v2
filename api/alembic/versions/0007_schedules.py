"""sprint 4: schedules + assignments

Greedy stub generator lives behind these tables. The real constraint solver
lands in Sprint 5/6 — the data shapes here have to be sufficient for both.

A schedule belongs to a tenant, covers a single calendar month (period =
first day of the month) and has a status: draft | published | archived.
Assignments cascade from schedules and are unique per (slot, date,
team_role) — null person_id is allowed for "no eligible staff" gaps.

Revision ID: 0007_schedules
Revises: 0006_availability_blocks
Create Date: 2026-04-28
"""

from alembic import op
import sqlalchemy as sa

revision = "0007_schedules"
down_revision = "0006_availability_blocks"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "schedules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("period", sa.Date(), nullable=False),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("generated_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "generated_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("published_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "status IN ('draft','published','archived')",
            name="ck_schedules_status",
        ),
        sa.UniqueConstraint("tenant_id", "period", name="uq_schedules_tenant_period"),
    )
    op.create_index("ix_schedules_tenant_id", "schedules", ["tenant_id"])

    op.execute("ALTER TABLE schedules ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE schedules FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY schedules_tenant_isolation ON schedules
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON schedules TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE schedules_id_seq TO albus_app")

    op.create_table(
        "assignments",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "schedule_id",
            sa.Integer(),
            sa.ForeignKey("schedules.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "slot_id",
            sa.Integer(),
            sa.ForeignKey("slots.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "team_role_id",
            sa.Integer(),
            sa.ForeignKey("slot_team_roles.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index(
        "ix_assignments_schedule_date",
        "assignments",
        ["schedule_id", "date"],
    )
    op.create_index(
        "ix_assignments_schedule_person",
        "assignments",
        ["schedule_id", "person_id"],
    )
    op.create_index("ix_assignments_tenant_id", "assignments", ["tenant_id"])

    op.execute("ALTER TABLE assignments ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE assignments FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY assignments_tenant_isolation ON assignments
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON assignments TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE assignments_id_seq TO albus_app")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS assignments_tenant_isolation ON assignments")
    op.execute("ALTER TABLE assignments DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_assignments_tenant_id", table_name="assignments")
    op.drop_index("ix_assignments_schedule_person", table_name="assignments")
    op.drop_index("ix_assignments_schedule_date", table_name="assignments")
    op.drop_table("assignments")

    op.execute("DROP POLICY IF EXISTS schedules_tenant_isolation ON schedules")
    op.execute("ALTER TABLE schedules DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_schedules_tenant_id", table_name="schedules")
    op.drop_table("schedules")
