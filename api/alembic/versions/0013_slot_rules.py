"""sprint 6: per-rule slot assignment strategies

A slot now has 1+ rules. Each rule covers a subset of weekdays
(days_bitmap, bit 0=Mon … bit 6=Sun) and picks an assignment strategy:
'solver', 'fixed_weekly', 'rotation', 'manual'. Different parts of the
week can use different strategies on the same slot. Rules within a slot
must NOT overlap on weekdays — enforced at API level.

Children:
- slot_rule_weekly_pin: one row per (rule, weekday) for fixed_weekly.
- slot_rule_rotation_block: ordered "shape" of a rotation; each block
  covers a non-empty subset of the rule's bitmap, blocks partition the
  rule's bitmap.
- slot_rule_rotation_member: ordered cycle of N people for a rotation.

Backfill: every existing slot gets a single default rule covering all 7
days with strategy='solver' so behavior is unchanged for slots that
haven't been reconfigured.

Revision ID: 0013_slot_rules
Revises: 0012_ci_unique_names
Create Date: 2026-05-04
"""

from alembic import op
import sqlalchemy as sa

revision = "0013_slot_rules"
down_revision = "0012_ci_unique_names"
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
        "slot_rules",
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
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("days_bitmap", sa.Integer(), nullable=False),
        sa.Column("strategy", sa.String(length=16), nullable=False),
        sa.Column("anchor_date", sa.Date(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "strategy IN ('solver','fixed_weekly','rotation','manual')",
            name="ck_slot_rules_strategy",
        ),
        sa.CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_rules_bitmap_range",
        ),
        sa.UniqueConstraint("slot_id", "position", name="uq_slot_rules_slot_position"),
    )
    op.create_index("ix_slot_rules_tenant_id", "slot_rules", ["tenant_id"])
    op.create_index("ix_slot_rules_slot_id", "slot_rules", ["slot_id"])
    _enable_rls("slot_rules")

    op.create_table(
        "slot_rule_weekly_pins",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "rule_id",
            sa.Integer(),
            sa.ForeignKey("slot_rules.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("weekday", sa.SmallInteger(), nullable=False),
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "weekday >= 0 AND weekday <= 6",
            name="ck_slot_rule_weekly_pins_weekday_range",
        ),
    )
    op.create_index(
        "ix_slot_rule_weekly_pins_tenant_id", "slot_rule_weekly_pins", ["tenant_id"]
    )
    op.create_index(
        "ix_slot_rule_weekly_pins_rule_id", "slot_rule_weekly_pins", ["rule_id"]
    )
    _enable_rls("slot_rule_weekly_pins")

    op.create_table(
        "slot_rule_rotation_blocks",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "rule_id",
            sa.Integer(),
            sa.ForeignKey("slot_rules.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column("days_bitmap", sa.Integer(), nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_rule_rotation_blocks_bitmap_range",
        ),
        sa.UniqueConstraint(
            "rule_id", "position", name="uq_slot_rule_rotation_blocks_rule_position"
        ),
    )
    op.create_index(
        "ix_slot_rule_rotation_blocks_tenant_id",
        "slot_rule_rotation_blocks",
        ["tenant_id"],
    )
    op.create_index(
        "ix_slot_rule_rotation_blocks_rule_id",
        "slot_rule_rotation_blocks",
        ["rule_id"],
    )
    _enable_rls("slot_rule_rotation_blocks")

    op.create_table(
        "slot_rule_rotation_members",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "rule_id",
            sa.Integer(),
            sa.ForeignKey("slot_rules.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("position", sa.Integer(), nullable=False),
        sa.Column(
            "person_id",
            sa.Integer(),
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "rule_id", "position", name="uq_slot_rule_rotation_members_rule_position"
        ),
        sa.UniqueConstraint(
            "rule_id", "person_id", name="uq_slot_rule_rotation_members_rule_person"
        ),
    )
    op.create_index(
        "ix_slot_rule_rotation_members_tenant_id",
        "slot_rule_rotation_members",
        ["tenant_id"],
    )
    op.create_index(
        "ix_slot_rule_rotation_members_rule_id",
        "slot_rule_rotation_members",
        ["rule_id"],
    )
    _enable_rls("slot_rule_rotation_members")

    # Backfill: every existing slot gets a single default solver rule
    # covering all 7 days. This preserves current solver behavior for any
    # slot that hasn't been reconfigured to use per-rule strategies yet.
    op.execute(
        """
        INSERT INTO slot_rules (tenant_id, slot_id, position, days_bitmap, strategy, anchor_date)
        SELECT s.tenant_id, s.id, 0, 127, 'solver', NULL FROM slots s
        """
    )


def downgrade() -> None:
    op.execute(
        "DROP POLICY IF EXISTS slot_rule_rotation_members_tenant_isolation ON slot_rule_rotation_members"
    )
    op.execute(
        "ALTER TABLE slot_rule_rotation_members DISABLE ROW LEVEL SECURITY"
    )
    op.drop_index(
        "ix_slot_rule_rotation_members_rule_id", table_name="slot_rule_rotation_members"
    )
    op.drop_index(
        "ix_slot_rule_rotation_members_tenant_id",
        table_name="slot_rule_rotation_members",
    )
    op.drop_table("slot_rule_rotation_members")

    op.execute(
        "DROP POLICY IF EXISTS slot_rule_rotation_blocks_tenant_isolation ON slot_rule_rotation_blocks"
    )
    op.execute(
        "ALTER TABLE slot_rule_rotation_blocks DISABLE ROW LEVEL SECURITY"
    )
    op.drop_index(
        "ix_slot_rule_rotation_blocks_rule_id", table_name="slot_rule_rotation_blocks"
    )
    op.drop_index(
        "ix_slot_rule_rotation_blocks_tenant_id", table_name="slot_rule_rotation_blocks"
    )
    op.drop_table("slot_rule_rotation_blocks")

    op.execute(
        "DROP POLICY IF EXISTS slot_rule_weekly_pins_tenant_isolation ON slot_rule_weekly_pins"
    )
    op.execute("ALTER TABLE slot_rule_weekly_pins DISABLE ROW LEVEL SECURITY")
    op.drop_index(
        "ix_slot_rule_weekly_pins_rule_id", table_name="slot_rule_weekly_pins"
    )
    op.drop_index(
        "ix_slot_rule_weekly_pins_tenant_id", table_name="slot_rule_weekly_pins"
    )
    op.drop_table("slot_rule_weekly_pins")

    op.execute("DROP POLICY IF EXISTS slot_rules_tenant_isolation ON slot_rules")
    op.execute("ALTER TABLE slot_rules DISABLE ROW LEVEL SECURITY")
    op.drop_index("ix_slot_rules_slot_id", table_name="slot_rules")
    op.drop_index("ix_slot_rules_tenant_id", table_name="slot_rules")
    op.drop_table("slot_rules")
