"""Phase C.1 — meetings + audience visible across sibling tenants.

The equipos redesign moves the residentes into their own peer
tenant. Their `MeetingAudiencePerson` rows on meetings like
"Comité de Tumores Torácicos" / "Comité de Trasplante" still
point at their person_id, but those meeting rows live in the
adjuntos tenant. Today's strict tenant_id RLS on meetings would
hide them from the residentes' view the instant Phase B runs.

This migration relaxes the **SELECT** side of RLS so a caller
sees a meeting (and their own audience row) when EITHER:

  1. tenant_id matches the caller's current tenant context, OR
  2. they're personally in the meeting's person audience.

WITH CHECK stays strict (`tenant_id = current_setting(...)`),
so cross-tenant **writes** remain blocked at the database
layer. Route-layer admin checks need to be tightened too
(admin power must apply only within the caller's own tenant
when writing); that's a Python-side change in this same
sprint, not a migration concern.

To support clause (2) the request layer now also sets
`app.person_id` alongside `app.tenant_id` at request start
(see app/db/session.py + app/routes/deps.py in the same
commit). The RLS expression uses `current_setting(..., true)`
so unset = NULL = no match, keeping the policy safe even if
some old request path forgets to set it.

`meeting_audience_groups` is deliberately NOT relaxed —
groups don't cross tenants by design (each group belongs to
one tenant) so cross-tenant group audience makes no sense.
After Phase B those rows for the migrated residentes group
become orphans, which Phase E will clean up.

Revision ID: 0070_meetings_cross_servicio_visibility
Revises: 0069_equipos_servicio_schema
Create Date: 2026-05-26
"""

from alembic import op


revision = "0070_meetings_cross_servicio_visibility"
down_revision = "0069_equipos_servicio_schema"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # ------------------------------------------------------------
    # meetings — allow cross-tenant SELECT via person audience.
    # WITH CHECK stays strict so no write can land in another
    # tenant's territory.
    # ------------------------------------------------------------
    op.execute("DROP POLICY IF EXISTS meetings_tenant_isolation ON meetings;")
    op.execute(
        """
        CREATE POLICY meetings_tenant_isolation ON meetings
        USING (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
            OR EXISTS (
                SELECT 1
                FROM meeting_audience_persons map
                WHERE map.meeting_id = meetings.id
                  AND map.person_id = NULLIF(current_setting('app.person_id', true), '')::int
            )
        )
        WITH CHECK (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
        )
        """
    )

    # ------------------------------------------------------------
    # meeting_audience_persons — allow caller to see their own
    # audience rows even when the meeting lives in another tenant.
    # This is what makes the cross-tenant subquery
    #   db.query(MeetingAudiencePerson.meeting_id).filter(person_id=me)
    # return the audience entries that are in the adjuntos tenant.
    # ------------------------------------------------------------
    op.execute(
        "DROP POLICY IF EXISTS meeting_audience_persons_tenant_isolation "
        "ON meeting_audience_persons;"
    )
    op.execute(
        """
        CREATE POLICY meeting_audience_persons_tenant_isolation
        ON meeting_audience_persons
        USING (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
            OR person_id = NULLIF(current_setting('app.person_id', true), '')::int
        )
        WITH CHECK (
            tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int
        )
        """
    )

    # ------------------------------------------------------------
    # meeting_audience_groups — intentionally NOT relaxed. Groups
    # don't cross tenants, so cross-tenant group audience is
    # meaningless. Phase E cleans up the now-orphan rows.
    # ------------------------------------------------------------


def downgrade() -> None:
    op.execute("DROP POLICY IF EXISTS meetings_tenant_isolation ON meetings;")
    op.execute(
        """
        CREATE POLICY meetings_tenant_isolation ON meetings
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )

    op.execute(
        "DROP POLICY IF EXISTS meeting_audience_persons_tenant_isolation "
        "ON meeting_audience_persons;"
    )
    op.execute(
        """
        CREATE POLICY meeting_audience_persons_tenant_isolation
        ON meeting_audience_persons
        USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
        """
    )
