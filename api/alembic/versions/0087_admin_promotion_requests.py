"""Admin promotion consent flow (members_pay).

Under members_pay, promoting a member to admin raises the price the
member pays Stripe (from price_member to price_admin). We can't
silently change someone's recurring charge — they have to consent.
This table tracks the "X wants to promote Y to admin" handshake:
admin creates a request → email goes to Y with accept / decline
links → on accept we grant the role AND swap the Stripe item.

Under team_pays the tenant card pays, so there's no consent issue
and the existing direct toggle still works. The routes that use
this table are guarded to members_pay only.

Schema:
  - status enum: 'pending', 'accepted', 'declined', 'cancelled',
    'expired'. The latter two are housekeeping for the admin UI
    (cancel before decision, expire after the TTL).
  - decided_at: stamped on accept/decline/cancel/expire so the
    admin's "pending promotions" panel can show "Cancelado el…".
  - Partial unique index on target_membership_id where status =
    'pending': at most one open promotion per member, so two
    admins can't race-create duplicate emails.

Revision ID: 0087_admin_promotion_requests
Revises: 0086_bloqueo_routing_centralised_default
Create Date: 2026-05-29
"""

import sqlalchemy as sa
from alembic import op


revision = "0087_admin_promotion_requests"
down_revision = "0086_bloqueo_routing_centralised_default"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "admin_promotion_requests",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "target_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "requested_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "status",
            sa.String(length=16),
            nullable=False,
            server_default=sa.text("'pending'"),
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column(
            "expires_at",
            sa.DateTime(timezone=True),
            nullable=False,
        ),
        sa.Column(
            "decided_at",
            sa.DateTime(timezone=True),
            nullable=True,
        ),
    )
    op.create_check_constraint(
        "ck_admin_promotion_status",
        "admin_promotion_requests",
        "status IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')",
    )
    # At most one open promotion per member — prevents duplicate
    # emails if two admins both click promote on the same member.
    op.create_index(
        "uq_admin_promotion_pending_per_membership",
        "admin_promotion_requests",
        ["target_membership_id"],
        unique=True,
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_index(
        "uq_admin_promotion_pending_per_membership",
        table_name="admin_promotion_requests",
    )
    op.drop_constraint(
        "ck_admin_promotion_status",
        "admin_promotion_requests",
        type_="check",
    )
    op.drop_table("admin_promotion_requests")
