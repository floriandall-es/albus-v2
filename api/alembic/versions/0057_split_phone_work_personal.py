"""Split persons.phone_e164 into work_phone + personal_phone.

User feedback: jefes de servicio don't think in E.164 ("+34 …") and
many of them have two phones — a corporate line (extension, switch‑
board, on‑call number) and a personal cell. WhatsApp should only be
offered for the personal one (sharing your work line on WhatsApp is
inappropriate, and the switchboard number isn't a WhatsApp account
anyway).

Schema changes:
  - persons.work_phone (String(50), free format, nullable)
  - persons.personal_phone (String(50), free format, nullable)
      Copy the existing phone_e164 value into personal_phone — most
      people who entered something so far meant their cell.
  - DROP persons.phone_e164 + its E.164 check constraint
  - memberships.share_phone RENAME → share_personal_phone
  - memberships.share_work_phone (boolean, default FALSE)
  - share_whatsapp stays — semantics now "expose personal_phone as
    a WhatsApp link". The route layer enforces "WhatsApp implies
    personal_phone is set".

The SECURITY DEFINER `list_hospital_directory` function gets a new
shape: two phone columns + the new share_work_phone flag instead of
the single phone_e164.

Revision ID: 0057_split_phone_work_personal
Revises: 0056_dm_email_fallback
Create Date: 2026-05-24
"""

import sqlalchemy as sa
from alembic import op


revision = "0057_split_phone_work_personal"
down_revision = "0056_dm_email_fallback"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # 1. New columns. work_phone and personal_phone are free text up
    #    to 50 chars — generous enough for "+34 (96) 197 25 00 ext.
    #    1234" style entries that the E.164 check would have rejected.
    op.add_column(
        "persons",
        sa.Column("work_phone", sa.String(50), nullable=True),
    )
    op.add_column(
        "persons",
        sa.Column("personal_phone", sa.String(50), nullable=True),
    )

    # 2. Carry existing data forward. The single phone_e164 maps
    #    semantically to "personal" — until now it was the phone
    #    WhatsApp linked to, which is the personal cell by
    #    convention.
    op.execute(
        "UPDATE persons SET personal_phone = phone_e164 "
        "WHERE phone_e164 IS NOT NULL"
    )

    # 3. Drop the old column + its E.164 check constraint.
    op.execute(
        "ALTER TABLE persons DROP CONSTRAINT IF EXISTS ck_persons_phone_e164"
    )
    op.drop_column("persons", "phone_e164")

    # 4. Membership flags: rename share_phone → share_personal_phone
    #    so the naming matches the new column. Add share_work_phone.
    op.alter_column(
        "memberships",
        "share_phone",
        new_column_name="share_personal_phone",
    )
    op.add_column(
        "memberships",
        sa.Column(
            "share_work_phone",
            sa.Boolean(),
            nullable=False,
            server_default=sa.text("false"),
        ),
    )

    # 5. Refresh the SECURITY DEFINER function to return both phones
    #    + the new share flag. DROP + CREATE because the return type
    #    changes (CREATE OR REPLACE doesn't allow that).
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


def downgrade() -> None:
    # Restore the v0053 function signature first so callers don't
    # hit a missing column mid-rollback.
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
    op.drop_column("memberships", "share_work_phone")
    op.alter_column(
        "memberships",
        "share_personal_phone",
        new_column_name="share_phone",
    )
    op.add_column(
        "persons",
        sa.Column("phone_e164", sa.String(20), nullable=True),
    )
    op.execute(
        "UPDATE persons SET phone_e164 = personal_phone "
        "WHERE personal_phone IS NOT NULL AND personal_phone ~ '^\\+[0-9]{7,15}$'"
    )
    op.execute(
        "ALTER TABLE persons ADD CONSTRAINT ck_persons_phone_e164 "
        "CHECK (phone_e164 IS NULL OR phone_e164 ~ '^\\+[0-9]{7,15}$')"
    )
    op.drop_column("persons", "personal_phone")
    op.drop_column("persons", "work_phone")
