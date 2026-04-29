"""sprint 3: invitations table

Token-based invite flow. token_hash stores a bcrypt hash of the raw token;
the raw token is only ever shown to the inviter (in the response + logs)
and to the invitee via the accept URL — it is never persisted.

Revision ID: 0003_invitations
Revises: 0002_domain_model
Create Date: 2026-04-28

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "0003_invitations"
down_revision = "0002_domain_model"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.create_table(
        "invitations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer(),
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column("email", sa.String(length=255), nullable=False),
        sa.Column("person_name", sa.String(length=255), nullable=False),
        sa.Column("token_hash", sa.String(length=255), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column(
            "created_by_membership_id",
            sa.Integer(),
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "category_id",
            sa.Integer(),
            sa.ForeignKey("categories.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "roles",
            postgresql.ARRAY(sa.String()),
            nullable=False,
            server_default="{}",
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
    )
    op.create_index("ix_invitations_tenant_id", "invitations", ["tenant_id"])
    op.create_index("ix_invitations_email", "invitations", ["email"])
    # Partial unique index: at most one *active* invitation per (tenant, email).
    # Re-inviting (after revoke or accept) is allowed.
    op.execute(
        """
        CREATE UNIQUE INDEX uq_invitations_active_per_tenant_email
        ON invitations (tenant_id, email)
        WHERE accepted_at IS NULL AND revoked_at IS NULL
        """
    )

    # RLS — same pattern as every other tenant-scoped table.
    op.execute("ALTER TABLE invitations ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE invitations FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY invitations_tenant_isolation ON invitations
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON invitations TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE invitations_id_seq TO albus_app")


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS invitations_tenant_isolation ON invitations")
    op.execute("ALTER TABLE invitations DISABLE ROW LEVEL SECURITY")
    op.execute("DROP INDEX IF EXISTS uq_invitations_active_per_tenant_email")
    op.drop_index("ix_invitations_email", table_name="invitations")
    op.drop_index("ix_invitations_tenant_id", table_name="invitations")
    op.drop_table("invitations")
