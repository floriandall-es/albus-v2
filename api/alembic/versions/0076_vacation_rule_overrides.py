"""Vacation periods V.2 — rule / succession / frequency-cap overrides.

Adds three more override tables that share the same delta-style
shape as slot_period_overrides from migration 0075:

  slot_rule_period_overrides
      per (period, SlotRule) — switch the strategy
      (e.g. rotation → solver during vacation) or disable the rule
      entirely so the slot falls back to whatever follows.

  slot_succession_rule_period_overrides
      per (period, SlotSuccessionRule) — relax days_after, flip
      severity hard→soft, or disable.

  slot_frequency_cap_period_overrides
      per (period, SlotFrequencyCap) — raise max_count, flip
      severity, or disable.

Every override row is optional and sparse: only the things the
admin actually changed get a row. The scheduler reads the override
when the date falls inside the periodo; outside the periodo the
rule applies as configured by default.

See docs/vacation-periods.md (Phase V.2 section).

Revision ID: 0076_vacation_rule_overrides
Revises: 0075_vacation_periods
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from alembic import op


revision = "0076_vacation_rule_overrides"
down_revision = "0075_vacation_periods"
branch_labels = None
depends_on = None


def _enable_rls_and_grant(table: str) -> None:
    """RLS + tenant policy + albus_app grants — same shape every
    tenant-scoped table uses. Factored to keep the upgrade readable."""
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
    # 1. slot_rule_period_overrides — switch a SlotRule's strategy
    #    (or disable it) for dates inside the periodo.
    # ------------------------------------------------------------
    op.create_table(
        "slot_rule_period_overrides",
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
            "rule_id",
            sa.Integer,
            sa.ForeignKey("slot_rules.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # NULL = keep the rule's default strategy. Non-NULL = use this
        # strategy for dates inside the periodo. Canonical use-case:
        # rotation → solver (admin doesn't want to track who's "next"
        # in the rotation when half the team is on vacation).
        sa.Column(
            "strategy_override", sa.String(length=16), nullable=True
        ),
        # When true, the rule doesn't fire for any date in the periodo.
        # The slot falls through to "no rule applies" — handled the
        # same as today (admin chose not to cover this weekday).
        sa.Column(
            "disabled",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "period_id",
            "rule_id",
            name="uq_slot_rule_period_overrides_period_rule",
        ),
        sa.CheckConstraint(
            "strategy_override IS NULL OR "
            "strategy_override IN ('solver','fixed_weekly','rotation','manual')",
            name="ck_slot_rule_period_overrides_strategy",
        ),
    )
    _enable_rls_and_grant("slot_rule_period_overrides")

    # ------------------------------------------------------------
    # 2. slot_succession_rule_period_overrides — relax/disable a
    #    succession rule during a periodo.
    # ------------------------------------------------------------
    op.create_table(
        "slot_succession_rule_period_overrides",
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
            "succession_rule_id",
            sa.Integer,
            sa.ForeignKey("slot_succession_rules.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # NULL = keep the rule's default days_after. Non-NULL = use
        # this gap during the periodo. Useful for shortening the
        # forbidden window when the workforce is thinner — e.g. the
        # normal "guardia → no quirófano within 1 day" can become
        # "within 0 days" (same-day only) during summer.
        sa.Column("days_after_override", sa.Integer, nullable=True),
        # NULL = keep severity. 'soft' downgrades a 'hard' rule into
        # a penalty during the periodo (the rule fires but the solver
        # can break it if it must).
        sa.Column(
            "severity_override", sa.String(length=8), nullable=True
        ),
        sa.Column(
            "disabled",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "period_id",
            "succession_rule_id",
            name="uq_slot_succession_rule_period_overrides_period_rule",
        ),
        sa.CheckConstraint(
            "days_after_override IS NULL "
            "OR (days_after_override >= 0 AND days_after_override <= 14)",
            name="ck_slot_succession_rule_period_overrides_days_after",
        ),
        sa.CheckConstraint(
            "severity_override IS NULL OR "
            "severity_override IN ('hard','soft')",
            name="ck_slot_succession_rule_period_overrides_severity",
        ),
    )
    _enable_rls_and_grant("slot_succession_rule_period_overrides")

    # ------------------------------------------------------------
    # 3. slot_frequency_cap_period_overrides — raise / disable a
    #    frequency cap during a periodo.
    # ------------------------------------------------------------
    op.create_table(
        "slot_frequency_cap_period_overrides",
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
            "cap_id",
            sa.Integer,
            sa.ForeignKey("slot_frequency_caps.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        # NULL = keep the cap's default max_count. Non-NULL = use this
        # ceiling during the periodo. Use-case: normal "2 guardias/
        # month" can become "5" during summer when 60% of the team
        # is out — solver still tries to balance but won't refuse to
        # assign a 3rd guardia if the only alternative is Sin cubrir.
        sa.Column("max_count_override", sa.Integer, nullable=True),
        sa.Column(
            "severity_override", sa.String(length=8), nullable=True
        ),
        sa.Column(
            "disabled",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "period_id",
            "cap_id",
            name="uq_slot_frequency_cap_period_overrides_period_cap",
        ),
        sa.CheckConstraint(
            "max_count_override IS NULL OR max_count_override >= 0",
            name="ck_slot_frequency_cap_period_overrides_max_count",
        ),
        sa.CheckConstraint(
            "severity_override IS NULL OR "
            "severity_override IN ('hard','soft')",
            name="ck_slot_frequency_cap_period_overrides_severity",
        ),
    )
    _enable_rls_and_grant("slot_frequency_cap_period_overrides")


def downgrade() -> None:
    op.execute(
        "DROP TABLE IF EXISTS slot_frequency_cap_period_overrides CASCADE"
    )
    op.execute(
        "DROP TABLE IF EXISTS slot_succession_rule_period_overrides CASCADE"
    )
    op.execute("DROP TABLE IF EXISTS slot_rule_period_overrides CASCADE")
