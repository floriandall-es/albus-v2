"""sprint 16: person_memberships SECURITY DEFINER function

Login no longer takes a tenant_slug — the user enters only email + password.
The server then needs to enumerate ALL memberships for that person across
ALL tenants, so it can either issue a JWT directly (single membership) or
return a tenant picker (multiple memberships).

The `memberships` table is RLS-scoped on `app.tenant_id`. The runtime role
`albus_app` is NOBYPASSRLS, so a normal SELECT returns rows only for the
current tenant context — useless when we don't know the tenant yet.

Workaround: add a SECURITY DEFINER function owned by the migrations role
(which is the table owner, exempt from FORCE ROW LEVEL SECURITY because it
runs the policy USING clause as itself — but as table owner with BYPASSRLS,
the rows are visible). The function returns (tenant_id, membership_id,
roles, tenant_slug, tenant_name) for a given person_id. Granting EXECUTE to
albus_app lets the auth route call it without elevating the rest of the
session.

Revision ID: 0016_person_memberships_fn
Revises: 0015_team_rotations
Create Date: 2026-05-05
"""

from alembic import op


revision = "0016_person_memberships_fn"
down_revision = "0015_team_rotations"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_person_memberships(p_person_id integer)
        RETURNS TABLE(
            membership_id integer,
            tenant_id integer,
            tenant_slug text,
            tenant_name text,
            roles text[]
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT m.id, t.id, t.slug, t.name, m.roles
            FROM memberships m
            JOIN tenants t ON t.id = m.tenant_id
            WHERE m.person_id = p_person_id
            ORDER BY t.name ASC, t.id ASC
        $$;
        """
    )
    op.execute("REVOKE ALL ON FUNCTION list_person_memberships(integer) FROM PUBLIC;")
    op.execute("GRANT EXECUTE ON FUNCTION list_person_memberships(integer) TO albus_app;")


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS list_person_memberships(integer);")
