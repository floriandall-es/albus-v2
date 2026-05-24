"""Per-person `cargo` — free-text job title for the directory.

Distinct from `memberships.category_id` (Adjunto / Residente R3 /
Becario / …), which the scheduler uses to decide who can cover
which slot. Cargo is purely presentational — what the directory
card surfaces to other hospital staff:

  - categoría → "Adjunto" / "R3"  (scheduling concept)
  - cargo     → "Jefe de Servicio" / "Coordinadora de Trasplantes"
                  / "Profesor Asociado" (job title)

Person-scoped (not membership) for v1 — most users have one
hospital and one title, so a per-membership column would just
introduce surface area without solving a real problem. Promote
to per-membership when a real multi-tenant user shows up with a
different title at each.

The SECURITY DEFINER `list_hospital_directory` function gains a
`person_cargo` column. DROP + CREATE because the return type
changes (CREATE OR REPLACE can't change signatures).

Revision ID: 0060_person_cargo
Revises: 0059_grant_directory_favorites
Create Date: 2026-05-24
"""

import sqlalchemy as sa
from alembic import op


revision = "0060_person_cargo"
down_revision = "0059_grant_directory_favorites"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column("cargo", sa.String(120), nullable=True),
    )
    # Refresh the directory function. Tracks the v0057 shape and
    # adds person_cargo in the natural slot (right after the avatar
    # / email / phones).
    op.execute("DROP FUNCTION IF EXISTS list_hospital_directory(integer);")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_hospital_directory(p_hospital_id integer)
        RETURNS TABLE(
            person_id integer,
            person_name text,
            person_first_name text,
            person_last_name text,
            person_avatar_url text,
            person_email text,
            person_work_phone text,
            person_personal_phone text,
            person_cargo text,
            membership_id integer,
            tenant_id integer,
            tenant_name text,
            tenant_slug text,
            category_id integer,
            category_name text,
            group_id integer,
            group_name text,
            roles text[],
            share_work_phone boolean,
            share_personal_phone boolean,
            share_email boolean,
            share_whatsapp boolean
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT
                p.id, p.name, p.first_name, p.last_name, p.avatar_url,
                p.email, p.work_phone, p.personal_phone, p.cargo,
                m.id, t.id, t.name, t.slug,
                c.id, c.name,
                g.id, g.name,
                m.roles,
                m.share_work_phone, m.share_personal_phone,
                m.share_email, m.share_whatsapp
            FROM memberships m
            JOIN tenants t ON t.id = m.tenant_id
            JOIN persons p ON p.id = m.person_id
            LEFT JOIN categories c ON c.id = m.category_id
            LEFT JOIN groups g ON g.id = m.group_id
            WHERE t.hospital_id = p_hospital_id
              AND m.disabled_at IS NULL
              AND m.directory_visible = TRUE
              AND p.hashed_password IS NOT NULL
            ORDER BY
                COALESCE(c.name, '~'),
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
    # Restore the v0057 function signature (the pre-cargo shape).
    op.execute("DROP FUNCTION IF EXISTS list_hospital_directory(integer);")
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_hospital_directory(p_hospital_id integer)
        RETURNS TABLE(
            person_id integer,
            person_name text,
            person_first_name text,
            person_last_name text,
            person_avatar_url text,
            person_email text,
            person_work_phone text,
            person_personal_phone text,
            membership_id integer,
            tenant_id integer,
            tenant_name text,
            tenant_slug text,
            category_id integer,
            category_name text,
            group_id integer,
            group_name text,
            roles text[],
            share_work_phone boolean,
            share_personal_phone boolean,
            share_email boolean,
            share_whatsapp boolean
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT
                p.id, p.name, p.first_name, p.last_name, p.avatar_url,
                p.email, p.work_phone, p.personal_phone,
                m.id, t.id, t.name, t.slug,
                c.id, c.name,
                g.id, g.name,
                m.roles,
                m.share_work_phone, m.share_personal_phone,
                m.share_email, m.share_whatsapp
            FROM memberships m
            JOIN tenants t ON t.id = m.tenant_id
            JOIN persons p ON p.id = m.person_id
            LEFT JOIN categories c ON c.id = m.category_id
            LEFT JOIN groups g ON g.id = m.group_id
            WHERE t.hospital_id = p_hospital_id
              AND m.disabled_at IS NULL
              AND m.directory_visible = TRUE
              AND p.hashed_password IS NOT NULL
            ORDER BY
                COALESCE(c.name, '~'),
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
    op.drop_column("persons", "cargo")
