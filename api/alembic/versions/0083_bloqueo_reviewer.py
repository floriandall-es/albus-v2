"""Cross-servicio bloqueo reviewer routing.

Adds `reviewer_membership_id` to availability_blocks so a member
can pick exactly which admin (across any approved equipo in the
same servicio) should review their pending bloqueo. When set,
ONLY that admin can approve/deny — the request locks to them.
When NULL, the legacy behaviour applies: any admin in the
block's own tenant can review (backward-compatible for every row
that pre-dates this feature).

The chosen reviewer can live in a different tenant than the
requester — see app/routes/availability.py for the
SECURITY-DEFINER-free cross-tenant access path (AdminSessionLocal
bounded by `reviewer_membership_id == :mid` for the write side,
and a servicio-wide UNION on the read side).

Revision ID: 0083_bloqueo_reviewer
Revises: 0082_billing_emails_sent
Create Date: 2026-05-28
"""

import sqlalchemy as sa
from alembic import op


revision = "0083_bloqueo_reviewer"
down_revision = "0082_billing_emails_sent"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "availability_blocks",
        sa.Column(
            "reviewer_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
    )
    # Index lets the chosen admin's pendientes panel fetch every
    # bloqueo assigned to them across the entire servicio in one
    # query (vs scanning availability_blocks tenant by tenant).
    op.create_index(
        "ix_availability_blocks_reviewer",
        "availability_blocks",
        ["reviewer_membership_id"],
        postgresql_where=sa.text("reviewer_membership_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index(
        "ix_availability_blocks_reviewer",
        table_name="availability_blocks",
    )
    op.drop_column("availability_blocks", "reviewer_membership_id")
