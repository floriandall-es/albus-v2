"""Optional admin approval / veto step for shift swaps.

Adds `tenants.swap_requires_admin_approval` as an opt-in flag.
When ON, a requester clicking "Aceptar" on a response no longer
applies the swap immediately — the offer moves to a new
`pending_admin` state, an admin reviews it, and only on admin
approve does the assignment swap (and the requester's monthly
quota charge) actually happen. Admin veto can either kill the
whole offer (`vetoed`) or just reject this one response
(`open` again so another colleague can step in).

Schema:
  - tenants.swap_requires_admin_approval bool NOT NULL DEFAULT false.
    Reading the flag at *accept* time means an open offer raised
    before a toggle still uses whatever policy is live when the
    requester decides — simpler than freezing the policy at offer
    creation.
  - shift_swap_offers gets three audit columns
    (admin_decided_at, admin_decided_by_membership_id,
    admin_decision_notes) and two new status values
    (`pending_admin`, `vetoed`) — added by replacing the existing
    CHECK constraint.
  - shift_swap_responses gets a new `pending_admin` status value
    (same CHECK swap), so a response that's been picked by the
    requester but is waiting for the admin is unambiguous in the
    DB without an extra join.

Revision ID: 0084_swap_admin_approval
Revises: 0083_bloqueo_reviewer
Create Date: 2026-05-28
"""

import sqlalchemy as sa
from alembic import op


revision = "0084_swap_admin_approval"
down_revision = "0083_bloqueo_reviewer"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # Tenant flag — defaults to false so every existing tenant keeps
    # the legacy "requester decision is final" behaviour. Admins
    # opt in via the toggle on /admin/swaps.
    op.add_column(
        "tenants",
        sa.Column(
            "swap_requires_admin_approval",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    # Audit columns on the offer. Populated only on the admin
    # approve/veto path; null on offers that fulfilled or cancelled
    # through the legacy direct path.
    op.add_column(
        "shift_swap_offers",
        sa.Column(
            "admin_decided_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.add_column(
        "shift_swap_offers",
        sa.Column(
            "admin_decided_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    op.add_column(
        "shift_swap_offers",
        sa.Column(
            "admin_decision_notes",
            sa.Text(),
            nullable=True,
        ),
    )

    # Expand the offer status CHECK to include the two new states.
    # Drop+recreate is the only portable way to widen a CHECK in
    # postgres.
    op.drop_constraint(
        "ck_swap_offer_status", "shift_swap_offers", type_="check"
    )
    op.create_check_constraint(
        "ck_swap_offer_status",
        "shift_swap_offers",
        "status IN ('open','pending_admin','fulfilled','cancelled','vetoed')",
    )

    # Same drill on the response status enum.
    op.drop_constraint(
        "ck_swap_response_status", "shift_swap_responses", type_="check"
    )
    op.create_check_constraint(
        "ck_swap_response_status",
        "shift_swap_responses",
        "status IN ('pending','pending_admin','accepted','declined','withdrawn')",
    )

    # Partial index so the admin pendientes count and the "Cambios
    # por aprobar" list can scan only the rows that actually need
    # attention. Tiny by definition (queue of awaiting-decision
    # offers, almost never more than a handful at a time).
    op.create_index(
        "ix_swap_offers_pending_admin",
        "shift_swap_offers",
        ["tenant_id"],
        postgresql_where=sa.text("status = 'pending_admin'"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_swap_offers_pending_admin",
        table_name="shift_swap_offers",
    )
    op.drop_constraint(
        "ck_swap_response_status", "shift_swap_responses", type_="check"
    )
    op.create_check_constraint(
        "ck_swap_response_status",
        "shift_swap_responses",
        "status IN ('pending','accepted','declined','withdrawn')",
    )
    op.drop_constraint(
        "ck_swap_offer_status", "shift_swap_offers", type_="check"
    )
    op.create_check_constraint(
        "ck_swap_offer_status",
        "shift_swap_offers",
        "status IN ('open','fulfilled','cancelled')",
    )
    op.drop_column("shift_swap_offers", "admin_decision_notes")
    op.drop_column("shift_swap_offers", "admin_decided_by_membership_id")
    op.drop_column("shift_swap_offers", "admin_decided_at")
    op.drop_column("tenants", "swap_requires_admin_approval")
