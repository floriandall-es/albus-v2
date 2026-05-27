"""Vacation periods — period-only succession rules.

Background: the V.2 delta-override model on succession rules only lets
admins tweak days_after / severity / disabled for rules that already
exist globally. It can't express "during summer there's an additional
incompatibility that doesn't apply outside the period."

This migration adds `slot_succession_rule_period_extras` — a table of
period-scoped succession rules that live alongside the global ones.
Same columns as `slot_succession_rules` (after/forbid slot + sub-role,
days_after, severity, weight) plus a `period_id` FK. The scheduler +
violations engine union extras with globals whenever the triggering
date sits inside the extras' period.

The delta-override table for existing global rules is unchanged. The
two surfaces are complementary:

  - "Modificar regla en el periodo" → updates the delta override on
    an existing global rule (days/severity/disable)
  - "Añadir regla del periodo" → creates a brand-new rule that only
    applies during the period

Same-day incompatibilities (days_after=0) and multi-day succession
(days_after>=1) live in the same table — exactly the layout of
`slot_succession_rules`. The UI groups them into the two existing
sections.

No frequency-cap extras here. The customer hasn't asked for them and
the same approach would apply if we add them later.

Revision ID: 0078_succession_period_extras
Revises: 0077_vacation_slot_snapshots
Create Date: 2026-05-27
"""

import sqlalchemy as sa
from alembic import op


revision = "0078_succession_period_extras"
down_revision = "0077_vacation_slot_snapshots"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "slot_succession_rule_period_extras",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "period_id",
            sa.Integer(),
            sa.ForeignKey("periodos_especiales.id", ondelete="CASCADE"),
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
        sa.Column(
            "after_team_role_id",
            sa.Integer(),
            sa.ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column(
            "forbid_team_role_id",
            sa.Integer(),
            sa.ForeignKey("slot_team_roles.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("days_after", sa.Integer(), nullable=False),
        sa.Column(
            "applies_to",
            sa.String(length=16),
            nullable=False,
            server_default="same_person",
        ),
        sa.Column(
            "severity",
            sa.String(length=8),
            nullable=False,
            server_default="hard",
        ),
        sa.Column(
            "weight", sa.Integer(), nullable=False, server_default="5"
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.text("NOW()"),
            nullable=False,
        ),
        sa.CheckConstraint(
            "days_after BETWEEN 0 AND 14",
            name="ck_succ_extra_days_after_range",
        ),
        sa.CheckConstraint(
            "applies_to IN ('same_person','whole_team')",
            name="ck_succ_extra_applies_to",
        ),
        sa.CheckConstraint(
            "severity IN ('hard','soft')",
            name="ck_succ_extra_severity",
        ),
    )
    op.create_index(
        "ix_succ_extra_period",
        "slot_succession_rule_period_extras",
        ["period_id"],
    )
    op.create_index(
        "ix_succ_extra_tenant",
        "slot_succession_rule_period_extras",
        ["tenant_id"],
    )

    # RLS. Same shape as every other tenant-scoped table.
    op.execute(
        "ALTER TABLE slot_succession_rule_period_extras "
        "ENABLE ROW LEVEL SECURITY"
    )
    op.execute(
        "ALTER TABLE slot_succession_rule_period_extras "
        "FORCE ROW LEVEL SECURITY"
    )
    op.execute(
        """
        CREATE POLICY slot_succession_rule_period_extras_tenant_isolation
        ON slot_succession_rule_period_extras
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON "
        "slot_succession_rule_period_extras TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE "
        "slot_succession_rule_period_extras_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.drop_index(
        "ix_succ_extra_tenant",
        table_name="slot_succession_rule_period_extras",
    )
    op.drop_index(
        "ix_succ_extra_period",
        table_name="slot_succession_rule_period_extras",
    )
    op.drop_table("slot_succession_rule_period_extras")
