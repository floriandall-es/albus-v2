"""Shift swap offers + responses.

A team member can offer one of their published assignments for coverage.
Other members respond as either "cover" (take the shift) or "swap"
(offer one of their own assignments in exchange). The asker accepts or
declines each response; acceptance reassigns assignments atomically.

Revision ID: 0019_shift_swaps
Revises: 0018_schedule_solver_used
Create Date: 2026-05-07
"""

import sqlalchemy as sa
from alembic import op

revision = "0019_shift_swaps"
down_revision = "0018_schedule_solver_used"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "shift_swap_offers",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "assignment_id",
            sa.Integer(),
            sa.ForeignKey("assignments.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "requested_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "closed_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.CheckConstraint(
            "status IN ('open','fulfilled','cancelled')",
            name="ck_swap_offer_status",
        ),
    )
    op.create_index(
        "ix_swap_offers_assignment", "shift_swap_offers", ["assignment_id"]
    )
    # Only one OPEN offer per assignment.
    op.create_index(
        "uq_swap_offers_open_assignment",
        "shift_swap_offers",
        ["assignment_id"],
        unique=True,
        postgresql_where=sa.text("status = 'open'"),
    )

    op.create_table(
        "shift_swap_responses",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "offer_id",
            sa.Integer(),
            sa.ForeignKey("shift_swap_offers.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "responder_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("kind", sa.String(length=16), nullable=False),
        sa.Column(
            "swap_assignment_id",
            sa.Integer(),
            sa.ForeignKey("assignments.id", ondelete="CASCADE"),
            nullable=True,
        ),
        sa.Column("status", sa.String(length=16), nullable=False),
        sa.Column("notes", sa.Text(), nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "decided_at", sa.DateTime(timezone=True), nullable=True
        ),
        sa.CheckConstraint(
            "kind IN ('cover','swap')", name="ck_swap_response_kind"
        ),
        sa.CheckConstraint(
            "status IN ('pending','accepted','declined','withdrawn')",
            name="ck_swap_response_status",
        ),
        sa.CheckConstraint(
            "(kind = 'swap' AND swap_assignment_id IS NOT NULL) OR "
            "(kind = 'cover' AND swap_assignment_id IS NULL)",
            name="ck_swap_response_kind_assignment",
        ),
    )
    op.create_index(
        "ix_swap_responses_offer", "shift_swap_responses", ["offer_id"]
    )

    # RLS + FORCE on both tables, same pattern as the rest of the schema.
    for tbl in ("shift_swap_offers", "shift_swap_responses"):
        op.execute(f"ALTER TABLE {tbl} ENABLE ROW LEVEL SECURITY")
        op.execute(f"ALTER TABLE {tbl} FORCE ROW LEVEL SECURITY")
        op.execute(
            f"CREATE POLICY tenant_isolation ON {tbl} "
            f"USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int) "
            f"WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)"
        )
        op.execute(f"GRANT SELECT, INSERT, UPDATE, DELETE ON {tbl} TO albus_app")
        op.execute(
            f"GRANT USAGE, SELECT ON SEQUENCE {tbl}_id_seq TO albus_app"
        )


def downgrade() -> None:
    op.drop_table("shift_swap_responses")
    op.drop_index("uq_swap_offers_open_assignment", table_name="shift_swap_offers")
    op.drop_table("shift_swap_offers")
