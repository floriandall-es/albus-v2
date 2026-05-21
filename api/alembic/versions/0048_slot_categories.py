"""Per-slot categoría restriction (slot_categories join table).

Until now, restricting which categorías could cover a slot was
only possible via `slot_team_role_categories` — and only for
team_composition slots, where each role had its own list of
allowed categories. Single and multiple_same slots had no
per-categoría filter; an admin could only restrict who could
cover them via the per-person `slot_allowed_persons` allow-list.

The alpha customer wants to say "only Adjuntos can cover Planta"
without dropping into team_composition (overkill for a 1-person
slot) and without manually listing every Adjunto in the per-
person allow-list (fragile, needs updating each time the team
changes).

This migration adds a `slot_categories` join table — same
pattern as `slot_team_role_categories` but keyed on the slot
directly. Empty = no restriction (any categoría); non-empty =
only those categorías are eligible.

For team_composition slots, the slot-level filter is honoured
in addition to each team_role's category list; the effective
allow set is the intersection. In practice admins should pick
ONE level, not both, but the schema allows either.

Revision ID: 0048_slot_categories
Revises: 0047_weeks_per_position
Create Date: 2026-05-21
"""

import sqlalchemy as sa
from alembic import op


revision = "0048_slot_categories"
down_revision = "0047_weeks_per_position"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "slot_categories",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
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
            "slot_id", "category_id", name="uq_slot_categories_slot_category"
        ),
    )
    op.execute("ALTER TABLE slot_categories ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE slot_categories FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY slot_categories_tenant_isolation ON slot_categories
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON slot_categories TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE slot_categories_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.drop_table("slot_categories")
