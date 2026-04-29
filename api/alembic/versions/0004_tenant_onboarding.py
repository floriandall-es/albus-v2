"""sprint 3: tenant onboarding completion timestamp

Adds tenants.onboarding_completed_at — null means the wizard hasn't been
finished, non-null means the admin clicked "Terminar configuración" or
manually skipped. Used by the frontend to redirect new admins into the
wizard right after signup.

Revision ID: 0004_tenant_onboarding
Revises: 0003_invitations
Create Date: 2026-04-28

"""
from alembic import op
import sqlalchemy as sa

revision = "0004_tenant_onboarding"
down_revision = "0003_invitations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "tenants",
        sa.Column("onboarding_completed_at", sa.DateTime(timezone=True), nullable=True),
    )


def downgrade() -> None:
    op.drop_column("tenants", "onboarding_completed_at")
