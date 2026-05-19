"""Enable RLS + grant app role permissions on slot_allowed_persons.

Migration 0030 created `slot_allowed_persons` but I forgot the
two boilerplate steps every tenant-scoped table needs:
  - ENABLE / FORCE ROW LEVEL SECURITY + the tenant_isolation policy,
  - GRANT SELECT/INSERT/UPDATE/DELETE to the `albus_app` runtime role
    + GRANT USAGE/SELECT on the id sequence.

Without those, queries from the FastAPI runtime hit "permission
denied for table slot_allowed_persons" and the app crashes on the
first request that touches it — which is what bricked login after
the 0030 deploy.

This migration is idempotent: it uses IF NOT EXISTS / CREATE POLICY
guards so re-applying it is a no-op.

Revision ID: 0031_slot_allowed_persons_rls
Revises: 0030_collapse_eligibility
Create Date: 2026-05-19
"""

from alembic import op

revision = "0031_slot_allowed_persons_rls"
down_revision = "0030_collapse_eligibility"
branch_labels = None
depends_on = None


def upgrade() -> None:
    # RLS — match the policy shape every other tenant-scoped table
    # in this app uses (see migration 0002 / 0007 / etc.). Same
    # `app.tenant_id` GUC, same FORCE so even the table owner gets
    # filtered (superusers still bypass).
    op.execute("ALTER TABLE slot_allowed_persons ENABLE ROW LEVEL SECURITY")
    op.execute("ALTER TABLE slot_allowed_persons FORCE ROW LEVEL SECURITY")
    op.execute(
        """
        DO $$
        BEGIN
            IF NOT EXISTS (
                SELECT 1 FROM pg_policies
                WHERE schemaname = 'public'
                  AND tablename = 'slot_allowed_persons'
                  AND policyname = 'slot_allowed_persons_tenant_isolation'
            ) THEN
                CREATE POLICY slot_allowed_persons_tenant_isolation
                ON slot_allowed_persons
                USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int)
                WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::int);
            END IF;
        END
        $$
        """
    )

    # Runtime role grants. `albus_app` is the NOBYPASSRLS role the
    # FastAPI process connects as; without these grants every query
    # 500s with "permission denied".
    op.execute(
        "GRANT SELECT, INSERT, UPDATE, DELETE ON slot_allowed_persons TO albus_app"
    )
    op.execute(
        "GRANT USAGE, SELECT ON SEQUENCE slot_allowed_persons_id_seq TO albus_app"
    )


def downgrade() -> None:
    # Revoking is harmless — if we ever needed to roll back we'd
    # rather leave the grants in place than risk locking the app out.
    op.execute(
        "DROP POLICY IF EXISTS slot_allowed_persons_tenant_isolation ON slot_allowed_persons"
    )
    op.execute("ALTER TABLE slot_allowed_persons DISABLE ROW LEVEL SECURITY")
