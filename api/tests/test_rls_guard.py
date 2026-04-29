"""CI guard: any table with a tenant_id column MUST have RLS enabled and a policy.

If a future migration adds a new tenant-scoped table without RLS, this test
fails and blocks the PR. Do not weaken this test."""
from sqlalchemy import create_engine, text

from app.core.config import settings


def test_every_tenant_scoped_table_has_rls():
    engine = create_engine(settings.database_url, future=True)
    with engine.connect() as conn:
        # All public tables that contain a tenant_id column.
        rows = conn.execute(text("""
            SELECT c.table_name
            FROM information_schema.columns c
            JOIN information_schema.tables t
              ON t.table_name = c.table_name AND t.table_schema = c.table_schema
            WHERE c.table_schema = 'public'
              AND c.column_name = 'tenant_id'
              AND t.table_type = 'BASE TABLE'
        """)).all()
        tenant_tables = {r.table_name for r in rows}
        assert tenant_tables, "Expected at least one tenant-scoped table"

        # rowsecurity flag
        rls_rows = conn.execute(text("""
            SELECT relname, relrowsecurity, relforcerowsecurity
            FROM pg_class
            WHERE relkind = 'r' AND relname = ANY(:names)
        """), {"names": list(tenant_tables)}).all()
        rls_map = {r.relname: (r.relrowsecurity, r.relforcerowsecurity) for r in rls_rows}

        # policies
        pol_rows = conn.execute(text("""
            SELECT tablename, policyname FROM pg_policies WHERE schemaname = 'public'
        """)).all()
        policy_map: dict[str, list[str]] = {}
        for r in pol_rows:
            policy_map.setdefault(r.tablename, []).append(r.policyname)

        problems: list[str] = []
        for t in sorted(tenant_tables):
            enabled, forced = rls_map.get(t, (False, False))
            if not enabled:
                problems.append(f"{t}: RLS NOT ENABLED")
            if not forced:
                problems.append(f"{t}: RLS not FORCED (table owner can bypass)")
            if not policy_map.get(t):
                problems.append(f"{t}: no policies defined")

        assert not problems, "RLS guard failed:\n  " + "\n  ".join(problems)

    engine.dispose()
