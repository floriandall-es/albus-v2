"""Hotfix: grant albus_app access to admin_promotion_requests.

0087 created `admin_promotion_requests` but never granted the runtime
role (`albus_app`) any privileges on it. The table sat unused until a
members_pay tenant opened the promotions panel, at which point
`GET /api/admin-promotions` 500s with:

    psycopg2.errors.InsufficientPrivilege:
    permission denied for table admin_promotion_requests

Same class of miss as 0058 → 0059 (and the reason 0089's comment nags
about granting in the create migration). Pure grant hotfix.

This table is intentionally NOT RLS-scoped — it's on the
`test_rls_guard` allowlist because authorisation is enforced by
explicit `tenant_id` filters in the routes plus the signed
accept/decline token — so no policy is needed here, only the grants.

Revision ID: 0094_grant_admin_promotion_requests
Revises: 0093_voice_notes
Create Date: 2026-06-02
"""

from alembic import op


revision = "0094_grant_admin_promotion_requests"
down_revision = "0093_voice_notes"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON admin_promotion_requests "
        "TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE admin_promotion_requests_id_seq "
        "TO albus_app"
    )


def downgrade() -> None:
    op.execute(
        "REVOKE SELECT, INSERT, UPDATE, DELETE ON admin_promotion_requests "
        "FROM albus_app"
    )
    op.execute(
        "REVOKE USAGE, SELECT ON SEQUENCE admin_promotion_requests_id_seq "
        "FROM albus_app"
    )
