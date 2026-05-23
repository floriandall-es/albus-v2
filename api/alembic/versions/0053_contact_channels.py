"""Per-membership opt-in contact channels for the hospital directory.

Sprint 28 / directory slice 1. The directory already lists members
across departments; this migration adds the contact methods we
surface on their cards:

- `persons.phone_e164` — single phone per person (cross-tenant).
  E.164 format ("+34..."). Used by both the `tel:` and `wa.me`
  link generators on directory cards. Nullable: most people
  haven't entered one yet.

- `memberships.share_phone`, `share_email`, `share_whatsapp` —
  per-employment opt-in (default FALSE) so a clinician can
  surface different channels at different tenants. Email reuses
  the existing `persons.email` field; the flag governs visibility,
  not the data.

Directory privacy contract:
  - The MEMBERSHIP listing itself defaults to visible
    (directory_visible TRUE, migration 0052).
  - Contact CHANNELS default invisible — surfacing phone is a
    bigger leap than appearing in a list. Each person opts in
    explicitly per channel.

Revision ID: 0053_contact_channels
Revises: 0052_directory_visible
Create Date: 2026-05-23
"""

import sqlalchemy as sa
from alembic import op


revision = "0053_contact_channels"
down_revision = "0052_directory_visible"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.add_column(
        "persons",
        sa.Column("phone_e164", sa.String(20), nullable=True),
    )
    # Soft format check — E.164 starts with + and 7-15 digits.
    # NULL bypasses the check.
    op.execute(
        "ALTER TABLE persons ADD CONSTRAINT ck_persons_phone_e164 "
        "CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\\+[0-9]{7,15}$')"
    )
    op.add_column(
        "memberships",
        sa.Column(
            "share_phone",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "memberships",
        sa.Column(
            "share_email",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    op.add_column(
        "memberships",
        sa.Column(
            "share_whatsapp",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )
    # Extend the directory SECURITY DEFINER function to also return
    # contact info + the share_* flags. The route filters fields by
    # flag before returning to the client; no field is exposed
    # unless its corresponding share flag is true.
    #
    # DROP + CREATE because Postgres can't change a function's
    # return type via CREATE OR REPLACE.
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
            person_phone_e164 text,
            membership_id integer,
            tenant_id integer,
            tenant_name text,
            tenant_slug text,
            category_id integer,
            category_name text,
            group_id integer,
            group_name text,
            roles text[],
            share_phone boolean,
            share_email boolean,
            share_whatsapp boolean
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT
                p.id, p.name, p.first_name, p.last_name, p.avatar_url,
                p.email, p.phone_e164,
                m.id, t.id, t.name, t.slug,
                c.id, c.name,
                g.id, g.name,
                m.roles,
                m.share_phone, m.share_email, m.share_whatsapp
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
    # Restore the v0052 function signature.
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
    op.drop_column("memberships", "share_whatsapp")
    op.drop_column("memberships", "share_email")
    op.drop_column("memberships", "share_phone")
    op.execute(
        "ALTER TABLE persons DROP CONSTRAINT IF EXISTS ck_persons_phone_e164"
    )
    op.drop_column("persons", "phone_e164")
