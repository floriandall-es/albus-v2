"""Vacation periods V.2.5 — replace slot+rule delta overrides with a
snapshot model.

Background: V.1 (migration 0075) shipped per-slot deltas
(slot_period_overrides) and V.2 (0076) added per-rule deltas
(slot_rule_period_overrides). After Mara reviewed the V.2 editor she
flagged two issues:

  1. The editor UI invented a different visual language from the
     /admin/slots editor admins already know.
  2. The delta model couldn't add brand-new rules per period, change
     rotation members per period, etc.

This migration pivots to a snapshot model. Nine new tables mirror the
slot family (slot + rules + rule child rows + team_roles +
allow-lists). When a snapshot exists for (period, slot), the solver
uses the snapshot in place of the slot's defaults for in-period
dates. When no snapshot exists, defaults apply unchanged.

Succession + frequency cap overrides (0076) DO NOT change here.
They're tenant-scoped (cross-slot), not per-slot — the delta model
still fits. The "Reglas" tab in the editor keeps using them.

V.1 + V.2 slot+rule override tables are dropped in this same
migration. Both are empty in prod (the V.1/V.2 UI shipped but Mara
hasn't used it for real data yet) so no data is at risk.

Revision ID: 0077_vacation_slot_snapshots
Revises: 0076_vacation_rule_overrides
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from alembic import op


revision = "0077_vacation_slot_snapshots"
down_revision = "0076_vacation_rule_overrides"
branch_labels = None
depends_on = None


def _enable_rls_and_grant(table: str) -> None:
    """Standard RLS + grant block, factored to keep upgrade() readable."""
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
    # ------------------------------------------------------------
    # 1. Drop the V.1/V.2 slot+rule delta tables. Empty in prod;
    # no data lost. The succession + cap delta tables stay — they
    # don't fit the snapshot model and still make sense.
    # ------------------------------------------------------------
    op.execute("DROP TABLE IF EXISTS slot_rule_period_overrides CASCADE")
    op.execute("DROP TABLE IF EXISTS slot_period_overrides CASCADE")

    # ------------------------------------------------------------
    # 2. slot_period_snapshots — top-level snapshot row. Mirrors
    # slot config fields except `name` (slot keeps its name across
    # periods) and `position` (display order is a property of the
    # base slot, not a period concern). When dismissed=true the
    # other fields are ignored — the slot doesn't run during the
    # period at all.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshots",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "period_id",
            sa.Integer,
            sa.ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "slot_id",
            sa.Integer,
            sa.ForeignKey("slots.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "dismissed",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        # Slot config mirror. Same nullability + checks as the
        # base `slots` table where applicable.
        sa.Column("start_time", sa.Time, nullable=True),
        sa.Column("end_time", sa.Time, nullable=True),
        sa.Column("days_applied", sa.String(length=32), nullable=False),
        sa.Column("custom_days_bitmap", sa.Integer, nullable=True),
        sa.Column("staffing_mode", sa.String(length=32), nullable=False),
        sa.Column("headcount", sa.Integer, nullable=False),
        sa.Column(
            "post_slot_rest",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "counts_for_equity",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("true"),
        ),
        sa.Column("guardia_type", sa.Text, nullable=True),
        sa.Column("color", sa.String(length=7), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "period_id", "slot_id", name="uq_slot_period_snapshots_period_slot"
        ),
        sa.CheckConstraint(
            "days_applied IN ('all','weekdays','weekends_holidays','custom')",
            name="ck_slot_period_snapshots_days_applied",
        ),
        sa.CheckConstraint(
            "staffing_mode IN ('single','multiple_same','team_composition')",
            name="ck_slot_period_snapshots_staffing_mode",
        ),
        sa.CheckConstraint(
            "headcount >= 1",
            name="ck_slot_period_snapshots_headcount_positive",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshots")

    # ------------------------------------------------------------
    # 3. slot_period_snapshot_rules — mirrors slot_rules.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_rules",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_id",
            sa.Integer,
            sa.ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("days_bitmap", sa.Integer, nullable=False),
        sa.Column("strategy", sa.String(length=16), nullable=False),
        sa.Column("anchor_date", sa.Date, nullable=True),
        sa.Column(
            "weeks_per_position",
            sa.Integer,
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "snapshot_id",
            "position",
            name="uq_slot_period_snapshot_rules_snapshot_position",
        ),
        sa.CheckConstraint(
            "strategy IN ('solver','fixed_weekly','rotation','manual')",
            name="ck_slot_period_snapshot_rules_strategy",
        ),
        sa.CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_period_snapshot_rules_bitmap_range",
        ),
        sa.CheckConstraint(
            "weeks_per_position >= 1",
            name="ck_slot_period_snapshot_rules_weeks_per_position_positive",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_rules")

    # ------------------------------------------------------------
    # 4. slot_period_snapshot_rule_weekly_pins — mirrors
    # slot_rule_weekly_pins.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_rule_weekly_pins",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_rule_id",
            sa.Integer,
            sa.ForeignKey(
                "slot_period_snapshot_rules.id", ondelete="CASCADE"
            ),
            nullable=False,
            index=True,
        ),
        sa.Column("weekday", sa.SmallInteger, nullable=False),
        sa.Column(
            "person_id",
            sa.Integer,
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
            name="ck_slot_period_snapshot_rule_weekly_pins_weekday_range",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_rule_weekly_pins")

    # ------------------------------------------------------------
    # 5. slot_period_snapshot_rule_rotation_blocks — mirrors
    # slot_rule_rotation_blocks.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_rule_rotation_blocks",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_rule_id",
            sa.Integer,
            sa.ForeignKey(
                "slot_period_snapshot_rules.id", ondelete="CASCADE"
            ),
            nullable=False,
            index=True,
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column("days_bitmap", sa.Integer, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "snapshot_rule_id",
            "position",
            name="uq_slot_period_snapshot_rule_rotation_blocks_rule_pos",
        ),
        sa.CheckConstraint(
            "days_bitmap > 0 AND days_bitmap <= 127",
            name="ck_slot_period_snapshot_rule_rotation_blocks_bitmap_range",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_rule_rotation_blocks")

    # ------------------------------------------------------------
    # 6. slot_period_snapshot_rule_rotation_members — mirrors
    # slot_rule_rotation_members.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_rule_rotation_members",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_rule_id",
            sa.Integer,
            sa.ForeignKey(
                "slot_period_snapshot_rules.id", ondelete="CASCADE"
            ),
            nullable=False,
            index=True,
        ),
        sa.Column("position", sa.Integer, nullable=False),
        sa.Column(
            "person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        # Same uniqueness shape as slot_rule_rotation_members
        # (migration 0015 + 0044 lineage): a person can hold one
        # position per rule, but a position can have multiple
        # members (team rotation).
        sa.UniqueConstraint(
            "snapshot_rule_id",
            "person_id",
            name="uq_slot_period_snapshot_rule_rotation_members_rule_person",
        ),
        sa.UniqueConstraint(
            "snapshot_rule_id",
            "position",
            "person_id",
            name="uq_slot_period_snapshot_rule_rotation_members_rule_pos_person",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_rule_rotation_members")

    # ------------------------------------------------------------
    # 7. slot_period_snapshot_team_roles — mirrors slot_team_roles.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_team_roles",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_id",
            sa.Integer,
            sa.ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("role_label", sa.String(length=255), nullable=False),
        sa.Column(
            "headcount",
            sa.Integer,
            nullable=False,
            server_default=sa.text("1"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "snapshot_id",
            "role_label",
            name="uq_slot_period_snapshot_team_roles_snapshot_label",
        ),
        sa.CheckConstraint(
            "headcount >= 1",
            name="ck_slot_period_snapshot_team_roles_headcount_positive",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_team_roles")

    # ------------------------------------------------------------
    # 8. slot_period_snapshot_team_role_categories — mirrors
    # slot_team_role_categories.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_team_role_categories",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_team_role_id",
            sa.Integer,
            sa.ForeignKey(
                "slot_period_snapshot_team_roles.id", ondelete="CASCADE"
            ),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "category_id",
            sa.Integer,
            sa.ForeignKey("categories.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "snapshot_team_role_id",
            "category_id",
            name="uq_slot_period_snapshot_team_role_categories_role_cat",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_team_role_categories")

    # ------------------------------------------------------------
    # 9. slot_period_snapshot_categories — mirrors slot_categories.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_categories",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_id",
            sa.Integer,
            sa.ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "category_id",
            sa.Integer,
            sa.ForeignKey("categories.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "snapshot_id",
            "category_id",
            name="uq_slot_period_snapshot_categories_snapshot_category",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_categories")

    # ------------------------------------------------------------
    # 10. slot_period_snapshot_allowed_persons — mirrors
    # slot_allowed_persons.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_snapshot_allowed_persons",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "snapshot_id",
            sa.Integer,
            sa.ForeignKey("slot_period_snapshots.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "person_id",
            sa.Integer,
            sa.ForeignKey("persons.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "snapshot_id",
            "person_id",
            name="uq_slot_period_snapshot_allowed_persons_snapshot_person",
        ),
    )
    _enable_rls_and_grant("slot_period_snapshot_allowed_persons")


def downgrade() -> None:
    # Drop in reverse FK-dependency order. Each CASCADE handles RLS
    # policies + child references automatically.
    op.execute(
        "DROP TABLE IF EXISTS slot_period_snapshot_allowed_persons CASCADE"
    )
    op.execute("DROP TABLE IF EXISTS slot_period_snapshot_categories CASCADE")
    op.execute(
        "DROP TABLE IF EXISTS slot_period_snapshot_team_role_categories CASCADE"
    )
    op.execute("DROP TABLE IF EXISTS slot_period_snapshot_team_roles CASCADE")
    op.execute(
        "DROP TABLE IF EXISTS slot_period_snapshot_rule_rotation_members CASCADE"
    )
    op.execute(
        "DROP TABLE IF EXISTS slot_period_snapshot_rule_rotation_blocks CASCADE"
    )
    op.execute(
        "DROP TABLE IF EXISTS slot_period_snapshot_rule_weekly_pins CASCADE"
    )
    op.execute("DROP TABLE IF EXISTS slot_period_snapshot_rules CASCADE")
    op.execute("DROP TABLE IF EXISTS slot_period_snapshots CASCADE")
    # Recreating the V.1/V.2 override tables on downgrade is left
    # to a manual restore from backup — they were empty in prod, so
    # not worth the boilerplate to recreate skeletons here.
