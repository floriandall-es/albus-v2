"""Per-tenant incident log.

Captures out-of-the-ordinary events the admin wants on the record:
last-minute illness call-offs, swap arguments, equipment issues
that affected staffing, anything they'd otherwise write on a
post-it. Pure text log; no structured linkage to persons/slots/
assignments for v1 — the body field is freeform.

Columns:
  - occurred_at: date the incident happened (admin can backdate)
  - title: short summary (255 chars)
  - body: long-form details, nullable
  - created_by_membership_id: audit trail; FK to memberships
    rather than persons since the audit is "which admin of this
    tenant wrote it" and we want it scoped to the tenant boundary

RLS + grants follow the same pattern as every other tenant-scoped
table in this schema.

Revision ID: 0034_incidents
Revises: 0033_drop_equity_group_key
Create Date: 2026-05-19
"""

import sqlalchemy as sa
from alembic import op

revision = "0034_incidents"
down_revision = "0033_drop_equity_group_key"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "incidents",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("occurred_at", sa.Date(), nullable=False, index=True),
        sa.Column("title", sa.String(length=255), nullable=False),
        sa.Column("body", sa.Text(), nullable=True),
        sa.Column(
            "created_by_membership_id",
            sa.Integer,
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.Column(
            "updated_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )

    # RLS + app-role grants — matches the boilerplate every other
    # tenant-scoped table uses (see migration 0002 for the pattern).
    op.execute("ALTER TABLE incidents ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE incidents FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY incidents_tenant_isolation ON incidents
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON incidents TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE incidents_id_seq TO albus_app"
    )


def downgrade() -> None:
    op.drop_table("incidents")
