"""Phase E: drop the vestigial Groups machinery.

After Phase B migrated the residentes sub-equipo to a peer Tenant
under the same Servicio, nothing in the product reaches into the
Groups data model any more. This migration tears it all out:

  - schedule_group_publications  (per-group publication flag)
  - meeting_audience_groups      (per-group meeting invite)
  - slots.group_id               + uq_slots_group_name partial idx
  - memberships.group_id
  - groups                       (the table itself)
  - 'lead' role values stripped from memberships.roles arrays

Two SECURITY DEFINER functions referenced groups columns and need
to be redefined without them:

  - list_hospital_directory(hospital_id)   — returned group_id +
    group_name as part of the cross-tenant directory row. Both
    columns are dropped from the return type; the route reads them
    via positional column name, so the route is being patched in
    the same commit.
  - list_hospital_guardias_today(hospital_id, today) — joined
    schedule_group_publications to gate group-slot guardias on the
    sub-equipo's publication state. Group slots no longer exist;
    the WHERE clause simplifies to "main schedule is published".

Per-row data preservation:
  - slots.group_id NOT NULL rows: there shouldn't be any (Phase B
    migrated all such slots to a peer tenant). But if any survived
    in non-customer tenants, dropping the column drops them
    silently — losing only an FK reference; the slot row itself
    stays. Acceptable: the leftover sub-equipo slot is unreachable
    from any UI anyway.
  - memberships.group_id: same — column drop loses the FK only,
    memberships survive.
  - 'lead' role: only ever lived on memberships.roles. Phase B
    merged lead → admin where the lead also had a clinical
    membership, and a follow-up pass dropped the role-only shared
    logins. There should be zero rows with 'lead' left; we strip
    defensively in case any survived.

tenants.servicio_id stays nullable. A follow-up (E.1) will flip
it to NOT NULL after operator data cleanup confirms every tenant
is either linked to a Servicio or has been culled. Demo tenant
id=1 currently has NULL hospital_id + NULL servicio_id; that's
the canonical "needs cleanup" case.

Revision ID: 0073_drop_groups_machinery
Revises: 0072_list_servicio_persons
Create Date: 2026-05-26
"""

import sqlalchemy as sa
from alembic import op


revision = "0073_drop_groups_machinery"
down_revision = "0072_list_servicio_persons"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------
    # 1. Redefine SECURITY DEFINER functions BEFORE dropping the
    #    columns they reference — otherwise the column drops would
    #    fail with "cannot drop column referenced by view/function".
    # ------------------------------------------------------------

    # list_hospital_directory — drop group_id + group_name columns.
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
                m.roles,
                m.share_work_phone, m.share_personal_phone,
                m.share_email, m.share_whatsapp
            FROM memberships m
            JOIN tenants t ON t.id = m.tenant_id
            JOIN persons p ON p.id = m.person_id
            LEFT JOIN categories c ON c.id = m.category_id
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

    # list_hospital_guardias_today — drop the schedule_group_publications
    # join; only main-team published schedules surface guardias now.
    op.execute(
        "DROP FUNCTION IF EXISTS list_hospital_guardias_today(integer, date);"
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_hospital_guardias_today(
            p_hospital_id integer,
            p_today date
        )
        RETURNS TABLE(person_id integer, slot_name text)
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT DISTINCT ON (a.person_id)
                a.person_id, s.name AS slot_name
            FROM assignments a
            JOIN slots s ON s.id = a.slot_id
            JOIN schedules sch ON sch.id = a.schedule_id
            JOIN tenants t ON t.id = sch.tenant_id
            WHERE t.hospital_id = p_hospital_id
              AND a.date = p_today
              AND a.person_id IS NOT NULL
              AND lower(s.name) LIKE 'guardia%'
              AND sch.status = 'published'
            ORDER BY a.person_id, a.id
        $$;
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION list_hospital_guardias_today(integer, date) FROM PUBLIC;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION list_hospital_guardias_today(integer, date) TO albus_app;"
    )

    # ------------------------------------------------------------
    # 2. Drop satellite tables that depend on groups (FKs first).
    # ------------------------------------------------------------
    op.execute("DROP TABLE IF EXISTS schedule_group_publications CASCADE;")
    op.execute("DROP TABLE IF EXISTS meeting_audience_groups CASCADE;")

    # ------------------------------------------------------------
    # 3. Drop the group_id columns + the partial unique index that
    #    discriminated main-team vs group slots.
    # ------------------------------------------------------------
    op.execute("DROP INDEX IF EXISTS uq_slots_group_name;")
    op.execute("DROP INDEX IF EXISTS uq_slots_main_team_name;")
    op.execute("DROP INDEX IF EXISTS ix_slots_group_id;")
    op.execute("DROP INDEX IF EXISTS ix_memberships_group_id;")

    op.drop_column("slots", "group_id")
    op.drop_column("memberships", "group_id")

    # Restore the simpler (tenant_id, name) unique constraint that
    # 0044 had partial-indexed away. Now that there are no group
    # slots, slot names are once again unique within a tenant.
    op.create_unique_constraint(
        "uq_slots_tenant_name", "slots", ["tenant_id", "name"]
    )

    # ------------------------------------------------------------
    # 4. Strip 'lead' role from any memberships.roles arrays. This
    #    should be a no-op given Phase B's merge sweep, but it's
    #    defensive — a stray 'lead' would otherwise survive the
    #    role-check guards we just deleted.
    # ------------------------------------------------------------
    op.execute(
        """
        UPDATE memberships
        SET roles = array_remove(roles, 'lead')
        WHERE 'lead' = ANY(roles)
        """
    )

    # ------------------------------------------------------------
    # 5. Finally drop the groups table itself.
    # ------------------------------------------------------------
    op.execute("DROP TABLE IF EXISTS groups CASCADE;")


def downgrade() -> None:
    # Phase E is one-way. Bringing groups back would require
    # restoring data from the pre-deploy backup (see infra/RUNBOOK.md
    # §5 restore drill). The function signatures are the only thing
    # we can plausibly reverse — restore the 0061/0062 definitions
    # so a partial rollback isn't completely silent.

    # Recreate groups table empty (best-effort skeleton).
    op.create_table(
        "groups",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column("name", sa.String(length=255), nullable=False),
        sa.Column(
            "lead_membership_id",
            sa.Integer,
            sa.ForeignKey("memberships.id", ondelete="SET NULL"),
            nullable=True,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint("tenant_id", "name", name="uq_groups_tenant_name"),
    )
    op.execute("ALTER TABLE groups ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE groups FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        CREATE POLICY groups_tenant_isolation ON groups
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
    op.execute("GRANT SELECT, INSERT, UPDATE, DELETE ON groups TO albus_app")
    op.execute("GRANT USAGE, SELECT ON SEQUENCE groups_id_seq TO albus_app")

    op.add_column(
        "memberships",
        sa.Column(
            "group_id",
            sa.Integer,
            sa.ForeignKey("groups.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
    )
    op.add_column(
        "slots",
        sa.Column(
            "group_id",
            sa.Integer,
            sa.ForeignKey("groups.id", ondelete="SET NULL"),
            nullable=True,
            index=True,
        ),
    )

    # Restore the 0044 partial indexes (drop the simple unique first).
    op.drop_constraint("uq_slots_tenant_name", "slots", type_="unique")
    op.create_index(
        "uq_slots_main_team_name",
        "slots",
        ["tenant_id", "name"],
        unique=True,
        postgresql_where=sa.text("group_id IS NULL"),
    )
    op.create_index(
        "uq_slots_group_name",
        "slots",
        ["tenant_id", "group_id", "name"],
        unique=True,
        postgresql_where=sa.text("group_id IS NOT NULL"),
    )

    # schedule_group_publications (skeleton — empty).
    op.create_table(
        "schedule_group_publications",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "schedule_id",
            sa.Integer,
            sa.ForeignKey("schedules.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "group_id",
            sa.Integer,
            sa.ForeignKey("groups.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "published_at",
            sa.DateTime(timezone=True),
            server_default=sa.func.now(),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "schedule_id", "group_id", name="uq_sched_group_publication"
        ),
    )

    # meeting_audience_groups (skeleton — empty).
    op.create_table(
        "meeting_audience_groups",
        sa.Column("id", sa.Integer, primary_key=True),
        sa.Column(
            "tenant_id",
            sa.Integer,
            sa.ForeignKey("tenants.id", ondelete="CASCADE"),
            nullable=False,
            index=True,
        ),
        sa.Column(
            "meeting_id",
            sa.Integer,
            sa.ForeignKey("meetings.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.Column(
            "group_id",
            sa.Integer,
            sa.ForeignKey("groups.id", ondelete="CASCADE"),
            nullable=False,
        ),
        sa.UniqueConstraint(
            "meeting_id", "group_id", name="uq_meeting_audience_group"
        ),
    )

    # Restore the 0061 directory function (with group_id/group_name).
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

    # Restore the 0062 guardias function (with sgp join).
    op.execute(
        "DROP FUNCTION IF EXISTS list_hospital_guardias_today(integer, date);"
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_hospital_guardias_today(
            p_hospital_id integer,
            p_today date
        )
        RETURNS TABLE(person_id integer, slot_name text)
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT DISTINCT ON (a.person_id)
                a.person_id, s.name AS slot_name
            FROM assignments a
            JOIN slots s ON s.id = a.slot_id
            JOIN schedules sch ON sch.id = a.schedule_id
            JOIN tenants t ON t.id = sch.tenant_id
            LEFT JOIN schedule_group_publications sgp
                ON sgp.schedule_id = sch.id
               AND sgp.group_id = s.group_id
            WHERE t.hospital_id = p_hospital_id
              AND a.date = p_today
              AND a.person_id IS NOT NULL
              AND lower(s.name) LIKE 'guardia%'
              AND (
                  (s.group_id IS NULL AND sch.status = 'published')
                  OR
                  (s.group_id IS NOT NULL AND sgp.id IS NOT NULL)
              )
            ORDER BY a.person_id, a.id
        $$;
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION list_hospital_guardias_today(integer, date) FROM PUBLIC;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION list_hospital_guardias_today(integer, date) TO albus_app;"
    )
