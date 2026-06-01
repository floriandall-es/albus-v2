"""CI guard: any table with a tenant_id column MUST have RLS enabled and a policy.

If a future migration adds a new tenant-scoped table without RLS, this test
fails and blocks the PR. Do not weaken this test.

A small, explicit allowlist exempts tables that carry `tenant_id` only as
attribution and are never read through a per-tenant request — they are
written/read exclusively by system paths (cross-tenant background workers,
the unauthenticated Stripe webhook, signed-token endpoints) that run OUTSIDE
any tenant RLS context. Forcing RLS on them would break those flows (there's
no `app.tenant_id` set to satisfy the policy) without closing any real leak.
Each entry below was reviewed individually; add to it only with the same
scrutiny (and never to silence a genuinely tenant-scoped, request-read table)."""
from sqlalchemy import create_engine, text

from app.core.config import settings

# table -> reason it is safe without RLS (kept for the audit trail).
_RLS_EXEMPT: dict[str, str] = {
    # Idempotency ledger for the meeting-reminder worker. Written across
    # all tenants by the worker via AdminSessionLocal; never read in a
    # tenant-scoped request.
    "meeting_reminders_sent": "worker-only idempotency ledger (AdminSessionLocal)",
    # Idempotency ledger for billing emails. Written by the daily worker
    # AND the unauthenticated Stripe webhook, both without a tenant GUC;
    # never read in a tenant-scoped request.
    "billing_emails_sent": "worker/webhook-only idempotency ledger",
    # Admin-promotion requests: every request-path read explicitly filters
    # by tenant_id (see routes/admin_promotion.py), and the accept/decline
    # path is authorized by a signed token, not tenant context. Adding RLS
    # would break the tokenized (tenant-less) accept/decline flow.
    "admin_promotion_requests": "explicit tenant filters + signed-token accept flow",
}


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
        # Drop the reviewed system-accessed exceptions (see _RLS_EXEMPT).
        tenant_tables -= set(_RLS_EXEMPT)

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
