"""Per-membership opt-out from the hospital directory.

Sprint 28 / hospital directory (slice 0). Adds a boolean to
memberships so a clinician can hide themselves from the
cross-tenant hospital directory while remaining a normal
member of their own department.

Default = TRUE (visible). Aligns with the product decision to
ship the directory as opt-out rather than opt-in: opt-in
directories empty out and die. Privacy-conscious individuals
can toggle this off on their settings page.

The flag lives on Membership (not on Person) because visibility
is per-employment: a clinician who's primary at Hospital La Fe
and consults at another tenant elsewhere can choose to be
visible in La Fe's directory but not the other.

Revision ID: 0052_directory_visible
Revises: 0051_hospitals
Create Date: 2026-05-23
"""

import sqlalchemy as sa
from alembic import op


revision = "0052_directory_visible"
down_revision = "0051_hospitals"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "memberships",
        sa.Column(
            "directory_visible",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("true"),
        ),
    )
    # SECURITY DEFINER function for the cross-tenant directory query.
    # `memberships` is FORCE RLS scoped per-tenant; the directory
    # spans every tenant of the caller's hospital. Same pattern as
    # `list_person_memberships` (migration 0016): owned by the
    # migrations role (table owner, BYPASSRLS) so the SELECT sees
    # every row regardless of the session's app.tenant_id setting.
    # albus_app gets EXECUTE only — the function body is the gate.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_hospital_directory(p_hospital_id integer)
        RETURNS TABLE(
            person_id integer,
            person_name text,
            person_first_name text,
            person_last_name text,
            person_avatar_url text,
            membership_id integer,
            tenant_id integer,
            tenant_name text,
            tenant_slug text,
            category_id integer,
            category_name text,
            group_id integer,
            group_name text,
            roles text[]
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT
                p.id, p.name, p.first_name, p.last_name, p.avatar_url,
                m.id, t.id, t.name, t.slug,
                c.id, c.name,
                g.id, g.name,
                m.roles
            FROM memberships m
            JOIN tenants t ON t.id = m.tenant_id
            JOIN persons p ON p.id = m.person_id
            LEFT JOIN categories c ON c.id = m.category_id
            LEFT JOIN groups g ON g.id = m.group_id
            WHERE t.hospital_id = p_hospital_id
              AND m.disabled_at IS NULL
              AND m.directory_visible = TRUE
              -- Hide pendientes (invited, never activated). They
              -- don't have a working contact path yet and aren't
              -- meaningful directory entries.
              AND p.hashed_password IS NOT NULL
            ORDER BY
                COALESCE(c.name, '~'),     -- group by categoría, null last
                COALESCE(p.last_name, p.name),
                p.id
        $$;
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION list_hospital_directory(integer) FROM PUBLIC;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION list_hospital_directory(integer) TO albus_app;"
    )


def downgrade() -> None:
    op.execute("DROP FUNCTION IF EXISTS list_hospital_directory(integer);")
    op.drop_column("memberships", "directory_visible")
