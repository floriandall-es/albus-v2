# albus-v2

Multi-tenant SaaS surgical scheduler for hospitals. **Sprint 1**: foundation only — auth, tenants, persons, memberships, departments, role types. Scheduling logic lands in Sprint 3.

## Architecture

- **Shared Postgres, shared schema, `tenant_id` on every tenant-scoped row.** No per-tenant database, no per-tenant schema.
- **Postgres Row-Level Security is the safety net.** Every tenant-scoped table has `ROW LEVEL SECURITY` enabled with `FORCE` and a policy `USING (tenant_id = current_setting('app.tenant_id')::int)`. Even the table owner cannot bypass it.
- **Subdomain-per-tenant** in production: `acme.__DOMAIN__` resolves Acme's UI. The frontend reads the subdomain client-side; **the backend reads tenant context from the JWT**, never from the Host header — that's the secure source of truth.
- **Identity = platform-wide `Person` + per-tenant `Membership`** (Slack model). One person can belong to many tenants. Never a direct FK from `persons` to `tenants`.
- **Auth**: JWT carrying `{person_id, tenant_id, roles[]}`. The FastAPI auth dependency decodes the token, verifies the membership, and runs `SET LOCAL app.tenant_id = <id>` on the request's transaction *before* any tenant query. Without that `SET`, RLS denies everything — the policy uses `current_setting('app.tenant_id', true)` which returns NULL when unset.

```
┌──────────┐    JWT (Authorization: Bearer …)
│  Browser │ ───────────────────────────────────┐
└──────────┘                                    │
     │                                          ▼
     │ subdomain {tenant}.__DOMAIN__   ┌────────────────┐
     ▼                                  │  FastAPI deps  │ decode JWT
┌─────────────┐                         │  set_tenant()  │ SET LOCAL app.tenant_id
│   Next.js   │                         └────────┬───────┘
└─────────────┘                                  │
                                                  ▼
                                      ┌──────────────────────┐
                                      │ Postgres + RLS        │
                                      │ memberships, depts,   │
                                      │ role_types  (RLS ON)  │
                                      │ tenants, persons      │
                                      │ (no RLS)              │
                                      └──────────────────────┘
```

## Tables (Sprint 1)

| Table | RLS | Notes |
|---|---|---|
| `tenants` | no | platform table |
| `persons` | no | platform-wide identity |
| `memberships` | yes | links person ↔ tenant + roles |
| `departments` | yes | tenant-scoped |
| `role_types` | yes | tenant-scoped, `defaults_jsonb` for later sprints |

Out of scope for Sprint 1: shifts, schedules, swaps, availability, holidays, constraints. Those land in Sprint 3.

## Run locally

Prereqs: Docker Desktop (Compose v2).

```bash
cp .env.example .env
docker compose up --build
```

- API: http://localhost:8000 (`/api/health`, `/docs`)
- Web: http://localhost:3000

End-to-end smoke test:

```bash
# Sign up
curl -s localhost:8000/api/signup -H 'Content-Type: application/json' -d '{
  "tenant_name":"General","tenant_slug":"general",
  "person_name":"Alice","email":"a@x.com","password":"supersecret1"
}' | jq

# Or via the UI: visit http://localhost:3000 → /signup
```

## Tests

```bash
docker compose exec api pytest
```

Three suites:
- `test_signup_login.py` — signup → login → /me end-to-end.
- `test_tenant_isolation.py` — two tenants, asserts RLS blocks cross-tenant reads (raw SQL probes, not just app code).
- `test_rls_guard.py` — introspects `pg_class` / `pg_policies` and fails CI if any table with a `tenant_id` column is missing RLS or a policy. Don't weaken this test.

Frontend typecheck:

```bash
cd web && npm install && npm run typecheck
```

## Deploy

You run all deploys yourself. CI runs tests; CI does not touch the VPS. See **[infra/RUNBOOK.md](infra/RUNBOOK.md)** for:

- One-time VPS bootstrap (`infra/bootstrap.sh`)
- First deploy + routine deploy
- Backup + restore drill (run the drill before you trust the backup)
- Common troubleshooting
- The `__DOMAIN__` replacement checklist

## Repo layout

```
api/             FastAPI + SQLAlchemy 2.0 + Alembic
  app/
    core/        config, security (JWT, bcrypt)
    db/          engine, session, set_tenant()
    models/      tenant, person, membership, department, role_type
    routes/      auth, me, health, deps (auth dependency)
    schemas/     Pydantic request/response models
  alembic/       migrations (0001 = initial + RLS policies)
  tests/         pytest — see above

web/             Next.js 14 (app router) + Tailwind + react-query
  src/
    app/         /, /login, /signup, /me
    lib/         api client, tenant slug helper
    components/  QueryProvider

infra/
  docker-compose.prod.yml
  Caddyfile               # auto-TLS for *.__DOMAIN__
  bootstrap.sh            # idempotent VPS setup
  RUNBOOK.md              # ops cheat sheet

docker-compose.yml        # local dev (api + web + postgres)
.github/workflows/ci.yml  # pytest + tsc, no deploy job
```
