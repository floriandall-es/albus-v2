"""Phase C.2 — SECURITY DEFINER functions for cross-equipo reads.

The Servicio timeline page needs to read slots + assignments
across every Equipo in the same Servicio, while RLS is still
locked to the caller's own tenant_id. Two surgical functions
bypass RLS for those reads and embed the share-policy filter
inside the query so the route layer doesn't have to.

Pattern matches `list_hospital_directory` from sprint 116 —
SECURITY DEFINER, search_path locked to `public, pg_temp`,
EXECUTE granted to `albus_app` only.

list_servicio_equipos(p_servicio_id integer)
  Returns one row per Tenant in the Servicio: id, name, slug,
  share_policy, approval_state. The caller's UI uses this to
  render the equipo list + show each one's policy state. No
  audience filter — everyone authenticated can read the
  membership of their Servicio. (Tenants in approval_state =
  'pending' are returned too; the UI hides them visually but
  the admin who'd approve them needs to see them.)

list_servicio_timeline(p_servicio_id, p_caller_tenant_id, p_from, p_to)
  Returns one row per visible assignment in the date range.
  Visibility rules per Equipo:
    - the caller's OWN tenant: ALWAYS shows everything (no
      policy filter applies to self)
    - other tenants in the servicio with share_policy='full':
      every assignment
    - share_policy='selected': only assignments whose slot has
      shared_with_servicio=true
    - share_policy='none': nothing
  Only PUBLISHED schedules are surfaced; drafts stay private to
  the owning equipo. Approval-pending equipos are excluded
  entirely (their data shouldn't bleed before approval).

  The flat row contains everything the planning grid needs to
  render: date, equipo (tenant_id + name), slot (id + name +
  color + times), person (id + name + last_name), schedule id
  (for deep-linking). Joining + grouping is done client-side.

Revision ID: 0071_servicio_cross_tenant_reads
Revises: 0070_meetings_cross_servicio_visibility
Create Date: 2026-05-26
"""

from alembic import op


revision = "0071_servicio_cross_tenant_reads"
down_revision = "0070_meetings_cross_servicio_visibility"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ---------------------------------------------------------------
    # list_servicio_equipos
    # ---------------------------------------------------------------
    op.execute(
        "DROP FUNCTION IF EXISTS list_servicio_equipos(integer);"
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_servicio_equipos(p_servicio_id integer)
        RETURNS TABLE(
            tenant_id integer,
            tenant_name text,
            tenant_slug text,
            share_policy text,
            approval_state text,
            created_at timestamptz
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT
                t.id, t.name, t.slug,
                t.share_policy, t.approval_state, t.created_at
            FROM tenants t
            WHERE t.servicio_id = p_servicio_id
            ORDER BY t.id
        $$;
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION list_servicio_equipos(integer) FROM PUBLIC;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION list_servicio_equipos(integer) TO albus_app;"
    )

    # ---------------------------------------------------------------
    # list_servicio_timeline
    # ---------------------------------------------------------------
    op.execute(
        "DROP FUNCTION IF EXISTS list_servicio_timeline(integer, integer, date, date);"
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_servicio_timeline(
            p_servicio_id integer,
            p_caller_tenant_id integer,
            p_from date,
            p_to date
        )
        RETURNS TABLE(
            assignment_id integer,
            assignment_date date,
            tenant_id integer,
            tenant_name text,
            slot_id integer,
            slot_name text,
            slot_color text,
            slot_start_time time,
            slot_end_time time,
            person_id integer,
            person_name text,
            person_last_name text,
            schedule_id integer
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT
                a.id,
                a.date,
                t.id, t.name,
                s.id, s.name, s.color, s.start_time, s.end_time,
                p.id, p.name, p.last_name,
                a.schedule_id
            FROM assignments a
            JOIN tenants t ON t.id = a.tenant_id
            JOIN slots s ON s.id = a.slot_id
            JOIN schedules sch ON sch.id = a.schedule_id
            LEFT JOIN persons p ON p.id = a.person_id
            WHERE t.servicio_id = p_servicio_id
              AND t.approval_state = 'approved'
              AND a.date BETWEEN p_from AND p_to
              AND sch.status = 'published'
              AND (
                  -- caller's own tenant: always visible to self
                  t.id = p_caller_tenant_id
                  -- siblings sharing everything
                  OR t.share_policy = 'full'
                  -- siblings sharing selected slots
                  OR (t.share_policy = 'selected' AND s.shared_with_servicio = TRUE)
              )
            ORDER BY a.date, t.id, s.position, a.id
        $$;
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION list_servicio_timeline(integer, integer, date, date) FROM PUBLIC;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION list_servicio_timeline(integer, integer, date, date) TO albus_app;"
    )


def downgrade() -> None:
    op.execute(
        "DROP FUNCTION IF EXISTS list_servicio_timeline(integer, integer, date, date);"
    )
    op.execute(
        "DROP FUNCTION IF EXISTS list_servicio_equipos(integer);"
    )
