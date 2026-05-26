"""Vacation periods — schema (V.1 foundation).

Adds the structural pieces for the period-aware scheduling feature
described in docs/vacation-periods.md. This is the minimal schema:
the periodo itself + per-slot overrides. Per-rule, per-succession,
and per-cap overrides land in V.2 as additional tables. No data
movement, no behavior change yet (no code reads these tables until
V.1 backend work lands).

Two new tables, both tenant-scoped with FORCE RLS:

  periodos_especiales      one row per defined vacation/special window
  slot_period_overrides    optional per-(period, slot) override delta

Non-overlap constraint
----------------------
A tenant cannot have two periodos covering the same date. Enforced
via a GiST exclusion constraint over (tenant_id, daterange). Requires
the btree_gist extension — added here. The extension is idempotent
(`CREATE EXTENSION IF NOT EXISTS`) so re-running on a system that
already has it is a no-op.

Daterange is inclusive on both ends ('[]') to match how Mara thinks
about it ("Verano 2026 del 15 de julio al 31 de agosto" — both days
are part of summer). The CHECK below also enforces start <= end so
single-day periodos are valid (an unusual but legal shape).

Override semantics
------------------
slot_period_overrides is a sparse delta: only slots Mara explicitly
changes during the period get a row. Every override field is nullable
(except `dismissed`, which has a default of false). NULL means "use
the slot's default for this field." `dismissed = true` short-circuits
the slot for every date in the period — no headcount, no assignments
created. UNIQUE(period_id, slot_id) so the (slot, period) pair is the
key — Mara can only express one override per slot per period.

Revision ID: 0075_vacation_periods
Revises: 0074_drop_tenants_has_subteams
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0075_vacation_periods"
down_revision = "0074_drop_tenants_has_subteams"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # btree_gist is required for the non-overlap exclusion constraint
    # below (mixing equality on tenant_id with range && on daterange).
    op.execute("CREATE EXTENSION IF NOT EXISTS btree_gist")

    # ------------------------------------------------------------
    # 1. periodos_especiales — the periodo itself.
    # ------------------------------------------------------------
    op.create_table(
        "periodos_especiales",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column("start_date", sa.Date, nullable=False),
        sa.Column("end_date", sa.Date, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.CheckConstraint(
            "end_date >= start_date",
            name="ck_periodos_especiales_date_order",
        ),
    )

    # Non-overlap per tenant via GiST exclusion. SQLAlchemy doesn't
    # have a first-class helper for "tenant_id WITH = AND daterange
    # WITH &&", so we drop to raw DDL. The daterange uses inclusive
    # bounds on both ends ('[]') to match the column semantics.
    op.execute(
        """
        ALTER TABLE periodos_especiales
        ADD CONSTRAINT ex_periodos_especiales_no_overlap
        EXCLUDE USING gist (
            tenant_id WITH =,
            daterange(start_date, end_date, '[]') WITH &&
        )
        """
    )

    op.execute("ALTER TABLE periodos_especiales ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE periodos_especiales FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY periodos_especiales_tenant_isolation
        ON periodos_especiales
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON periodos_especiales TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE periodos_especiales_id_seq TO albus_app"
    )

    # ------------------------------------------------------------
    # 2. slot_period_overrides — per-(period, slot) override deltas.
    # ------------------------------------------------------------
    op.create_table(
        "slot_period_overrides",
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
        sa.Column("headcount_override", sa.Integer, nullable=True),
        sa.Column(
            "staffing_mode_override", sa.String(length=32), nullable=True
        ),
        sa.Column(
            "dismissed",
            sa.Boolean,
            nullable=False,
            server_default=sa.text("false"),
        ),
        # Int-array overrides for the two list-shaped fields. NULL
        # means "use the slot's default list." Empty array means
        # "drop the restriction entirely" (any category / any person
        # eligible during the period).
        sa.Column(
            "allowed_category_ids_override",
            postgresql.ARRAY(sa.Integer),
            nullable=True,
        ),
        sa.Column(
            "allowed_person_ids_override",
            postgresql.ARRAY(sa.Integer),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "period_id", "slot_id", name="uq_slot_period_overrides_period_slot"
        ),
        sa.CheckConstraint(
            "headcount_override IS NULL OR headcount_override >= 1",
            name="ck_slot_period_overrides_headcount_positive",
        ),
        sa.CheckConstraint(
            "staffing_mode_override IS NULL OR "
            "staffing_mode_override IN ('single','multiple_same','team_composition')",
            name="ck_slot_period_overrides_staffing_mode",
        ),
    )

    op.execute("ALTER TABLE slot_period_overrides ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE slot_period_overrides FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY slot_period_overrides_tenant_isolation
        ON slot_period_overrides
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON slot_period_overrides TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE slot_period_overrides_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.execute("DROP TABLE IF EXISTS slot_period_overrides CASCADE")
    op.execute("DROP TABLE IF EXISTS periodos_especiales CASCADE")
    # Leave btree_gist installed — other tables may grow to use it.
