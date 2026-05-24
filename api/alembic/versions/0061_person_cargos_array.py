"""Promote persons.cargo (single text) → persons.cargos (text[]).

A clinician routinely wears more than one hat — "Adjunto" AND
"Tutor de Residentes", "Adjunto" AND "Coordinador de Trasplantes",
"Jefe de Servicio" AND "Profesor Asociado". The single-string
cargo introduced in 0060 forced them to pick one or stuff a list
into one cell. Promote to a Postgres text[] so the UI can offer a
proper multi-select.

Data carries forward: any non-empty cargo becomes ARRAY[cargo];
null/empty becomes the empty array (which is also the column's
default for new rows). The 0060 column itself is then dropped.

The SECURITY DEFINER `list_hospital_directory` function gains a
`person_cargos text[]` column in place of `person_cargo text`.
Same DROP + CREATE pattern as the previous shape changes — the
return type changes so CREATE OR REPLACE can't handle it.

Revision ID: 0061_person_cargos_array
Revises: 0060_person_cargo
Create Date: 2026-05-24
"""

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects import postgresql


revision = "0061_person_cargos_array"
down_revision = "0060_person_cargo"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. New text[] column. NOT NULL with empty-array default so the
    #    backend can rely on always getting a list (no None ↔ [] dance).
    op.add_column(
        "persons",
        sa.Column(
            "cargos",
            postgresql.ARRAY(sa.String(120)),
            nullable=False,
            server_default=sa.text("ARRAY[]::text[]"),
        ),
    )
    # 2. Carry the single cargo into the array when set.
    op.execute(
        "UPDATE persons "
        "SET cargos = ARRAY[cargo] "
        "WHERE cargo IS NOT NULL AND cargo <> ''"
    )
    # 3. Drop the old column.
    op.drop_column("persons", "cargo")

    # 4. Refresh the directory function with the new column.
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
            person_cargos text[],
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
                p.email, p.work_phone, p.personal_phone, p.cargos,
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
    # Restore the v0060 function signature first.
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
    op.add_column(
        "persons",
        sa.Column("cargo", sa.String(120), nullable=True),
    )
    # Take the first element of cargos, if any, into the legacy column.
    op.execute(
        "UPDATE persons SET cargo = cargos[1] "
        "WHERE array_length(cargos, 1) >= 1"
    )
    op.drop_column("persons", "cargos")
