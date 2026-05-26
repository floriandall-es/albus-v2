"""Phase C.2 — cross-equipo person list for meeting invitee picker.

Companion to migration 0071's two SECURITY DEFINER functions.
The meeting create / edit modal needs to surface persons from
sibling equipos in the same Servicio so an organizer can invite
them cross-tenant (e.g. a Comité de Trasplante hosted by
adjuntos can pull residentes into the audience).

list_servicio_persons(servicio_id, caller_tenant_id)
  Returns one row per active, opted-in Person across every
  approved Equipo in the Servicio:
    - person_id / name / first_name / last_name / avatar_url
    - tenant_id / tenant_name (which equipo they belong to)
    - category_name (e.g. 'Residente', 'Adjunto')
    - is_caller_tenant (so the UI can group own-equipo separately)

  Filters out:
    - pending-approval equipos (their data shouldn't bleed before
      approval, same rule as list_servicio_timeline)
    - disabled memberships (m.disabled_at IS NOT NULL)
    - pendiente persons (p.hashed_password IS NULL — no real
      account yet, can't realistically be invited)

  Sorted: caller's own equipo first (so the picker shows
  "my team" before siblings), then by tenant name, then by
  last name.

EXECUTE granted to albus_app only — same boilerplate as
list_servicio_equipos / list_servicio_timeline (0071) and
list_hospital_directory (0053).

Revision ID: 0072_list_servicio_persons
Revises: 0071_servicio_cross_tenant_reads
Create Date: 2026-05-26
"""

from alembic import op


revision = "0072_list_servicio_persons"
down_revision = "0071_servicio_cross_tenant_reads"
branch_labels = None
depends_on = None


def upgrade() -> None:
    op.execute(
        "DROP FUNCTION IF EXISTS list_servicio_persons(integer, integer);"
    )
    op.execute(
        """
        CREATE OR REPLACE FUNCTION list_servicio_persons(
            p_servicio_id integer,
            p_caller_tenant_id integer
        )
        RETURNS TABLE(
            person_id integer,
            person_name text,
            person_first_name text,
            person_last_name text,
            person_avatar_url text,
            tenant_id integer,
            tenant_name text,
            category_name text,
            is_caller_tenant boolean
        )
        LANGUAGE sql
        SECURITY DEFINER
        SET search_path = public, pg_temp
        AS $$
            SELECT
                p.id, p.name, p.first_name, p.last_name, p.avatar_url,
                t.id, t.name,
                c.name,
                (t.id = p_caller_tenant_id) AS is_caller_tenant
            FROM persons p
            JOIN memberships m ON m.person_id = p.id
            JOIN tenants t ON t.id = m.tenant_id
            LEFT JOIN categories c ON c.id = m.category_id
            WHERE t.servicio_id = p_servicio_id
              AND t.approval_state = 'approved'
              AND m.disabled_at IS NULL
              AND p.hashed_password IS NOT NULL
            ORDER BY
                (t.id = p_caller_tenant_id) DESC,
                t.name,
                COALESCE(p.last_name, p.name),
                p.id
        $$;
        """
    )
    op.execute(
        "REVOKE ALL ON FUNCTION list_servicio_persons(integer, integer) FROM PUBLIC;"
    )
    op.execute(
        "GRANT EXECUTE ON FUNCTION list_servicio_persons(integer, integer) TO albus_app;"
    )


def downgrade() -> None:
    op.execute(
        "DROP FUNCTION IF EXISTS list_servicio_persons(integer, integer);"
    )
