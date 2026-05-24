"""SECURITY DEFINER function: who's on guardia today in this hospital?

The directorio del hospital wants to surface a "Guardia" pill next
to each person who's currently on a guardia-named slot today, so
that scanning the directory tells you not just who exists but
who's actually on duty right now. The query has to:

  - Cross tenant boundaries (assignments has FORCE RLS) — hence
    SECURITY DEFINER, same pattern as `list_hospital_directory`.
  - Match "guardia" loosely. We use lower(slot.name) LIKE
    'guardia%' so "Guardia presencial", "Guardia localizada",
    "Guardia Quirúrgica", … all qualify without requiring a
    schema-level flag. If a hospital ever names their on-call
    slot differently, we'd promote this to a per-slot flag.
  - Respect the same publication-state rules the schedule
    serializer applies — drafts must not leak through this side
    channel. Main-team slots show when schedule.status='published';
    group slots show when a ScheduleGroupPublication row exists
    for that (schedule, group).
  - Collapse duplicates: a person might have two guardia
    assignments on one day (day + night) — DISTINCT ON keeps
    one row per person, deterministically by assignment id.

Revision ID: 0062_hospital_guardias_today
Revises: 0061_person_cargos_array
Create Date: 2026-05-24
"""

from alembic import op


revision = "0062_hospital_guardias_today"
down_revision = "0061_person_cargos_array"
branch_labels = None
depends_on = None


def upgrade() -> None:
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
                  -- Main-team slot: visible when the parent
                  -- schedule is published.
                  (s.group_id IS NULL AND sch.status = 'published')
                  OR
                  -- Group slot: visible when the group's lead has
                  -- published for this schedule.
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


def downgrade() -> None:
    op.execute(
        "DROP FUNCTION IF EXISTS list_hospital_guardias_today(integer, date);"
    )
