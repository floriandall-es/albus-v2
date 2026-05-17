"""Indexed token lookup for invitations + RLS policy for public scan.

Replaces the cross-tenant superuser scan with an O(1) indexed
lookup on an HMAC of the raw token. Two changes that together
remove the need to open a migrations-role connection at request
time:

1. New `token_lookup` column = HMAC-SHA256(settings.invitation_
   lookup_secret, raw_token). Computed at invitation creation
   time, indexed for direct lookup.

2. New RLS policy that allows reading an invitation row when the
   session variable `app.invitation_lookup` equals the row's
   `token_lookup`. The public endpoint sets the variable to the
   HMAC of the user-supplied raw token; RLS then returns at most
   one row per request. No more cross-tenant table scan, no more
   migrations-role bypass.

The existing tenant-scoped RLS policy stays untouched — admins
in the dashboard continue to see only their tenant's invitations
via the normal `app.tenant_id` channel.

We invalidate any pre-migration pending invitations (the user
confirmed there are none in production, but this keeps dev /
staging databases tidy and lets us add the NOT NULL constraint).

Revision ID: 0027_invitation_token_lookup
Revises: 0026_freqcap_role_filter
Create Date: 2026-05-17
"""

import sqlalchemy as sa
from alembic import op

revision = "0027_invitation_token_lookup"
down_revision = "0026_freqcap_role_filter"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. Add the column nullable so we can backfill.
    op.add_column(
        "invitations",
        sa.Column("token_lookup", sa.String(length=64), nullable=True),
    )
    # 2. Invalidate pre-existing pending invitations — they can't be
    #    accepted via the new lookup path (their lookup hash is unknown,
    #    we never stored the raw token). User confirmed no real prod
    #    invitations exist; this keeps the migration idempotent on
    #    dev/staging.
    op.execute(
        "UPDATE invitations SET revoked_at = NOW() "
        "WHERE revoked_at IS NULL AND accepted_at IS NULL"
    )
    # 3. Backfill the column with a per-row synthetic value so the
    #    upcoming NOT NULL + unique constraint is satisfied. These
    #    values match no possible new token, so the rows are
    #    inaccessible via the public endpoint — which is exactly
    #    what we want for old/invalid invitations.
    op.execute(
        "UPDATE invitations "
        "SET token_lookup = 'legacy_' || id::text "
        "WHERE token_lookup IS NULL"
    )
    # 4. Make it required.
    op.alter_column("invitations", "token_lookup", nullable=False)
    # 5. Unique + indexed for the public lookup path.
    op.create_index(
        "uq_invitations_token_lookup",
        "invitations",
        ["token_lookup"],
        unique=True,
    )
    # 6. RLS policy: allow SELECT when the request has set
    #    app.invitation_lookup (via SET LOCAL) to a value matching
    #    this row's token_lookup. The tenant-scoped policy from the
    #    initial RLS migration still applies for the dashboard side
    #    (admins reading their own tenant's invitations); Postgres
    #    OR-combines policies, so each policy independently grants
    #    access.
    op.execute(
        "CREATE POLICY rls_invitations_public_lookup ON invitations "
        "FOR SELECT "
        "USING ("
        "  current_setting('app.invitation_lookup', true) IS NOT NULL "
        "  AND current_setting('app.invitation_lookup', true) <> '' "
        "  AND token_lookup = current_setting('app.invitation_lookup', true)"
        ")"
    )


def downgrade() -> None:
    op.execute(
        "DROP POLICY IF EXISTS rls_invitations_public_lookup ON invitations"
    )
    op.drop_index("uq_invitations_token_lookup", table_name="invitations")
    op.drop_column("invitations", "token_lookup")
