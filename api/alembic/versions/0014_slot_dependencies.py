"""sprint 14: cross-slot dependencies (succession rules + frequency caps)

Two new tenant-scoped tables that let admins express scheduling rules
that span more than one slot:

- slot_succession_rule: "after slot A, person can't take slot B for N
  days". Hard or soft.
- slot_frequency_cap: "at most N assignments to slot S per person per
  rolling/iso/calendar window". Hard or soft.

Both follow the standard RLS pattern.

Revision ID: 0014_slot_dependencies
Revises: 0013_slot_rules
Create Date: 2026-05-04
"""

from alembic import op
import sqlalchemy as sa


revision = "0014_slot_dependencies"
down_revision = "0013_slot_rules"
branch_labels = None
depends_on = None


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
    op.create_table(
        "slot_succession_rules",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "after_slot_id",
            sa.Integer(),
            sa.ForeignKey("slots.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "forbid_slot_id",
            sa.Integer(),
            sa.ForeignKey("slots.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("days_after", sa.Integer(), nullable=False),
        sa.Column(
            "applies_to",
            sa.String(length=16),
            nullable=False,
            server_default="same_person",
        ),
        sa.Column(
            "severity", sa.String(length=8), nullable=False, server_default="hard"
        ),
        sa.Column("weight", sa.Integer(), nullable=False, server_default="5"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "days_after BETWEEN 1 AND 14",
            name="ck_succession_days_after_range",
        ),
        sa.CheckConstraint(
            "applies_to IN ('same_person','whole_team')",
            name="ck_succession_applies_to",
        ),
        sa.CheckConstraint(
            "severity IN ('hard','soft')",
            name="ck_succession_severity",
        ),
        sa.UniqueConstraint(
            "tenant_id",
            "after_slot_id",
            "forbid_slot_id",
            "days_after",
            "applies_to",
            name="uq_succession_unique",
        ),
    )
    op.create_index(
        "ix_slot_succession_rules_tenant_id",
        "slot_succession_rules",
        ["tenant_id"],
    )
    op.create_index(
        "ix_slot_succession_rules_after_slot_id",
        "slot_succession_rules",
        ["after_slot_id"],
    )
    op.create_index(
        "ix_slot_succession_rules_forbid_slot_id",
        "slot_succession_rules",
        ["forbid_slot_id"],
    )
    _enable_rls("slot_succession_rules")

    op.create_table(
        "slot_frequency_caps",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "slot_id",
            sa.Integer(),
            sa.ForeignKey("slots.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("period", sa.String(length=24), nullable=False),
        sa.Column("max_count", sa.Integer(), nullable=False),
        sa.Column(
            "severity", sa.String(length=8), nullable=False, server_default="hard"
        ),
        sa.Column("weight", sa.Integer(), nullable=False, server_default="5"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "period IN ('rolling_7','rolling_14','rolling_28','iso_week','calendar_month')",
            name="ck_freqcap_period",
        ),
        sa.CheckConstraint("max_count >= 0", name="ck_freqcap_max_count"),
        sa.CheckConstraint(
            "severity IN ('hard','soft')", name="ck_freqcap_severity"
        ),
        sa.UniqueConstraint(
            "tenant_id", "slot_id", "period", name="uq_freqcap_unique"
        ),
    )
    op.create_index(
        "ix_slot_frequency_caps_tenant_id",
        "slot_frequency_caps",
        ["tenant_id"],
    )
    op.create_index(
        "ix_slot_frequency_caps_slot_id",
        "slot_frequency_caps",
        ["slot_id"],
    )
    _enable_rls("slot_frequency_caps")


def downgrade() -> None:
    op.execute(
        "DROP POLICY IF EXISTS slot_frequency_caps_tenant_isolation ON slot_frequency_caps"
    )
    op.execute("ALTER TABLE slot_frequency_caps DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_slot_frequency_caps_slot_id", table_name="slot_frequency_caps")
    op.drop_index(
        "ix_slot_frequency_caps_tenant_id", table_name="slot_frequency_caps"
    )
    op.drop_table("slot_frequency_caps")

    op.execute(
        "DROP POLICY IF EXISTS slot_succession_rules_tenant_isolation ON slot_succession_rules"
    )
    op.execute("ALTER TABLE slot_succession_rules DISABLE ROW LEVEL SECURITY")
    op.drop_index(
        "ix_slot_succession_rules_forbid_slot_id",
        table_name="slot_succession_rules",
    )
    op.drop_index(
        "ix_slot_succession_rules_after_slot_id",
        table_name="slot_succession_rules",
    )
    op.drop_index(
        "ix_slot_succession_rules_tenant_id", table_name="slot_succession_rules"
    )
    op.drop_table("slot_succession_rules")
