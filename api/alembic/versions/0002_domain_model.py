"""sprint 2: generalized domain model

Adds the tenant-scoped domain tables:
  categories, pools, pool_memberships, skills, person_skills,
  slots, slot_team_roles, slot_team_role_categories, slot_skills_required.
Also extends `memberships` with per-tenant person attributes
  (category_id, fte_pct, does_guardias, guardia_types, exemption_*).

All new tables have FORCE RLS with a tenant_isolation policy and CRUD
grants to albus_app, matching 0001_initial.

Revision ID: 0002_domain_model
Revises: 0001_initial
Create Date: 2026-04-28

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0002_domain_model"
down_revision = "0001_initial"
branch_labels = None
depends_on = None


# Tables created in this migration that carry tenant_id and need RLS.
NEW_TENANT_SCOPED_TABLES = [
    "categories",
    "pools",
    "pool_memberships",
    "skills",
    "person_skills",
    "slots",
    "slot_team_roles",
    "slot_team_role_categories",
    "slot_skills_required",
]


def _enable_rls(table: str) -> None:
    op.execute(f"ALTER TABLE {table} ENABLE ROW LEVEL SECURITY")
    op.execute(f"ALTER TABLE {table} FORCE ROW LEVEL SECURITY")
    op.execute(
        f"""
        CREATE POLICY {table}_tenant_isolation ON {table}
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {table} TO albus_app")
    op.execute(f"GRANT USAGE, SELECT ON SEQUENCE {table}_id_seq TO albus_app")


def upgrade() -> None:
    # ------------------------------------------------------------------
    # 1. categories — must come before the memberships ALTER because the
    #    new memberships.category_id column FKs into it.
    # ------------------------------------------------------------------
    op.create_table(
        "categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("level", sa.Integer(), nullable=True),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_categories_tenant_name"),
    )
    op.create_index("ix_categories_tenant_id", "categories", ["tenant_id"])

    # ------------------------------------------------------------------
    # 2. ALTER memberships — per-tenant attributes
    # ------------------------------------------------------------------
    op.add_column(
        "memberships",
        sa.Column(
            "category_id",
            sa.Integer(),
            sa.ForeignKey("categories.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "memberships",
        sa.Column("fte_pct", sa.Integer(), nullable=False, server_default="100"),
    )
    op.add_column(
        "memberships",
        sa.Column("does_guardias", sa.Boolean(), nullable=False, server_default=sa.true()),
    )
    op.add_column(
        "memberships",
        sa.Column(
            "guardia_types",
            postgresql.ARRAY(sa.String()),
            nullable=False,
            server_default="{}",
        ),
    )
    op.add_column("memberships", sa.Column("exemption_type", sa.String(length=32), nullable=True))
    op.add_column("memberships", sa.Column("exemption_until", sa.Date(), nullable=True))

    op.create_check_constraint(
        "ck_memberships_fte_pct_range",
        "memberships",
        "fte_pct >= 0 AND fte_pct <= 200",
    )
    op.create_check_constraint(
        "ck_memberships_exemption_type",
        "memberships",
        "exemption_type IS NULL OR exemption_type IN ('permanent','temporary')",
    )
    op.create_index("ix_memberships_category_id", "memberships", ["category_id"])

    # ------------------------------------------------------------------
    # 3. pools
    # ------------------------------------------------------------------
    op.create_table(
        "pools",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "department_id",
            sa.Integer(),
            sa.ForeignKey("departments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("membership_mode", sa.String(length=32), nullable=False),
        sa.Column("equity_independent", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_pools_tenant_name"),
        sa.CheckConstraint(
            "membership_mode IN ('dedicated','rotational','mixed')",
            name="ck_pools_membership_mode",
        ),
    )
    op.create_index("ix_pools_tenant_id", "pools", ["tenant_id"])
    op.create_index("ix_pools_department_id", "pools", ["department_id"])

    # ------------------------------------------------------------------
    # 4. pool_memberships
    # ------------------------------------------------------------------
    op.create_table(
        "pool_memberships",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("pool_id", sa.Integer(), sa.ForeignKey("pools.id", ondelete="CASCADE"), nullable=False),
        sa.Column("person_id", sa.Integer(), sa.ForeignKey("persons.id", ondelete="CASCADE"), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("pool_id", "person_id", name="uq_pool_memberships_pool_person"),
    )
    op.create_index("ix_pool_memberships_tenant_id", "pool_memberships", ["tenant_id"])
    op.create_index("ix_pool_memberships_pool_id", "pool_memberships", ["pool_id"])
    op.create_index("ix_pool_memberships_person_id", "pool_memberships", ["person_id"])

    # ------------------------------------------------------------------
    # 5. skills
    # ------------------------------------------------------------------
    op.create_table(
        "skills",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("description", sa.Text(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_skills_tenant_name"),
    )
    op.create_index("ix_skills_tenant_id", "skills", ["tenant_id"])

    # ------------------------------------------------------------------
    # 6. person_skills
    # ------------------------------------------------------------------
    op.create_table(
        "person_skills",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("person_id", sa.Integer(), sa.ForeignKey("persons.id", ondelete="CASCADE"), nullable=False),
        sa.Column("skill_id", sa.Integer(), sa.ForeignKey("skills.id", ondelete="CASCADE"), nullable=False),
        sa.Column("level", sa.Integer(), nullable=True),
        sa.Column("expires_at", sa.Date(), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "person_id", "skill_id", name="uq_person_skills_tenant_person_skill"),
    )
    op.create_index("ix_person_skills_tenant_id", "person_skills", ["tenant_id"])
    op.create_index("ix_person_skills_person_id", "person_skills", ["person_id"])
    op.create_index("ix_person_skills_skill_id", "person_skills", ["skill_id"])

    # ------------------------------------------------------------------
    # 7. slots
    # ------------------------------------------------------------------
    op.create_table(
        "slots",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "department_id",
            sa.Integer(),
            sa.ForeignKey("departments.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "pool_id",
            sa.Integer(),
            sa.ForeignKey("pools.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("start_time", sa.Time(), nullable=True),
        sa.Column("end_time", sa.Time(), nullable=True),
        sa.Column("days_applied", sa.String(length=32), nullable=False),
        sa.Column("custom_days_bitmap", sa.Integer(), nullable=True),
        sa.Column("staffing_mode", sa.String(length=32), nullable=False),
        sa.Column("headcount", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("post_slot_rest", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("counts_for_equity", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("tenant_id", "name", name="uq_slots_tenant_name"),
        sa.CheckConstraint(
            "days_applied IN ('all','weekdays','weekends_holidays','custom')",
            name="ck_slots_days_applied",
        ),
        sa.CheckConstraint(
            "staffing_mode IN ('single','multiple_same','team_composition')",
            name="ck_slots_staffing_mode",
        ),
        sa.CheckConstraint("headcount >= 1", name="ck_slots_headcount_positive"),
    )
    op.create_index("ix_slots_tenant_id", "slots", ["tenant_id"])
    op.create_index("ix_slots_department_id", "slots", ["department_id"])
    op.create_index("ix_slots_pool_id", "slots", ["pool_id"])

    # ------------------------------------------------------------------
    # 8. slot_team_roles
    # ------------------------------------------------------------------
    op.create_table(
        "slot_team_roles",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("slot_id", sa.Integer(), sa.ForeignKey("slots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("role_label", sa.String(length=255), nullable=False),
        sa.Column("headcount", sa.Integer(), nullable=False, server_default="1"),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("slot_id", "role_label", name="uq_slot_team_roles_slot_label"),
        sa.CheckConstraint("headcount >= 1", name="ck_slot_team_roles_headcount_positive"),
    )
    op.create_index("ix_slot_team_roles_tenant_id", "slot_team_roles", ["tenant_id"])
    op.create_index("ix_slot_team_roles_slot_id", "slot_team_roles", ["slot_id"])

    # ------------------------------------------------------------------
    # 9. slot_team_role_categories
    # ------------------------------------------------------------------
    op.create_table(
        "slot_team_role_categories",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column(
            "slot_team_role_id",
            sa.Integer(),
            sa.ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "category_id",
            sa.Integer(),
            sa.ForeignKey("categories.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("slot_team_role_id", "category_id", name="uq_strc_role_category"),
    )
    op.create_index("ix_strc_tenant_id", "slot_team_role_categories", ["tenant_id"])
    op.create_index("ix_strc_role_id", "slot_team_role_categories", ["slot_team_role_id"])
    op.create_index("ix_strc_category_id", "slot_team_role_categories", ["category_id"])

    # ------------------------------------------------------------------
    # 10. slot_skills_required
    # ------------------------------------------------------------------
    op.create_table(
        "slot_skills_required",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("tenant_id", sa.Integer(), sa.ForeignKey("tenants.id", ondelete="CASCADE"), nullable=False),
        sa.Column("slot_id", sa.Integer(), sa.ForeignKey("slots.id", ondelete="CASCADE"), nullable=False),
        sa.Column("skill_id", sa.Integer(), sa.ForeignKey("skills.id", ondelete="CASCADE"), nullable=False),
        sa.Column("strength", sa.String(length=8), nullable=False),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
        sa.UniqueConstraint("slot_id", "skill_id", name="uq_slot_skills_slot_skill"),
        sa.CheckConstraint("strength IN ('hard','soft')", name="ck_slot_skills_strength"),
    )
    op.create_index("ix_slot_skills_tenant_id", "slot_skills_required", ["tenant_id"])
    op.create_index("ix_slot_skills_slot_id", "slot_skills_required", ["slot_id"])
    op.create_index("ix_slot_skills_skill_id", "slot_skills_required", ["skill_id"])

    # ------------------------------------------------------------------
    # RLS for every new tenant-scoped table.
    # ------------------------------------------------------------------
    for table in NEW_TENANT_SCOPED_TABLES:
        _enable_rls(table)


def downgrade() -> None:
    # Drop policies first
    for table in NEW_TENANT_SCOPED_TABLES:
        op.execute(f"DROP POLICY IF EXISTS {table}_tenant_isolation ON {table}")
        op.execute(f"ALTER TABLE {table} DISABLE ROW LEVEL SECURITY")

    op.drop_table("slot_skills_required")
    op.drop_table("slot_team_role_categories")
    op.drop_table("slot_team_roles")
    op.drop_table("slots")
    op.drop_table("person_skills")
    op.drop_table("skills")
    op.drop_table("pool_memberships")
    op.drop_table("pools")

    # Revert memberships ALTER
    op.drop_index("ix_memberships_category_id", table_name="memberships")
    op.drop_constraint("ck_memberships_exemption_type", "memberships", type_="check")
    op.drop_constraint("ck_memberships_fte_pct_range", "memberships", type_="check")
    op.drop_column("memberships", "exemption_until")
    op.drop_column("memberships", "exemption_type")
    op.drop_column("memberships", "guardia_types")
    op.drop_column("memberships", "does_guardias")
    op.drop_column("memberships", "fte_pct")
    op.drop_column("memberships", "category_id")

    op.drop_table("categories")
