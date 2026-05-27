# albus-v2 Operations Runbook

Every command here is meant to be copy-pasted by you on the VPS. **No CI workflow deploys for you** — by design.

Domain: **trivu.net** (path-based tenancy — no wildcard subdomains).

---

## 0. DNS

Two A records pointing at the Hetzner VPS IPv4:

| Name | Type | Value |
|---|---|---|
| `trivu.net` (apex) | A | `<VPS_IP>` |
| `api.trivu.net` | A | `<VPS_IP>` |

Optional but nice: matching AAAA records for the IPv6.

**No wildcard, no `*.trivu.net`** — tenants share a single hostname; the JWT carries tenant context after login.

---

## 1. One-time bootstrap (fresh VPS)

Read `infra/bootstrap.sh` top-to-bottom first. Then on a fresh Ubuntu 22.04 / Debian 12 VPS:

```bash
# As root
curl -fsSL https://raw.githubusercontent.com/floriandall-es/albus-v2/main/infra/bootstrap.sh -o /tmp/bootstrap.sh
less /tmp/bootstrap.sh   # review
bash /tmp/bootstrap.sh

# Switch to deploy user
sudo -iu deploy
cd /srv/albus
git clone git@github.com:floriandall-es/albus-v2.git repo
cd repo

# Fill in secrets
vi /srv/albus/.env
# Required:
#   POSTGRES_PASSWORD  (long random)
#   POSTGRES_USER, POSTGRES_DB (defaults: albus / albus)
#   JWT_SECRET         (openssl rand -hex 48)
#   SMTP_*             (Resend / Mailgun / Brevo creds)
#   EMAIL_ENABLED      (true once SMTP works)
```

The deploy user must have an SSH key authorized on the `floriandall-es/albus-v2` repo (read-only deploy key recommended).

---

## 2. First deploy

```bash
cd /srv/albus/repo
docker compose --env-file /srv/albus/.env -f infra/docker-compose.prod.yml up -d --build

# Watch the API come up and run migrations
docker compose -f infra/docker-compose.prod.yml logs -f api

# Once you see "Uvicorn running on http://0.0.0.0:8000", verify:
curl -sf https://api.trivu.net/api/health
# {"status":"ok"}

# Sign up the first tenant
curl -s https://api.trivu.net/api/signup \
  -H 'Content-Type: application/json' \
  -d '{"tenant_name":"Test","tenant_slug":"test","person_name":"Admin","email":"admin@example.com","password":"supersecret1"}'

# Then visit https://trivu.net in a browser, log in with email + password
# + tenant_slug "test".
```

Caddy auto-issues + renews Let's Encrypt certs for `trivu.net` and `api.trivu.net` on first request. Tail Caddy logs once if you want confirmation:

```bash
docker compose -f infra/docker-compose.prod.yml logs caddy | grep -i certificate
```

---

## 3. Routine deploy

### 0. Before you start (run on your local Mac, not the VPS)

Confirm every local commit has been pushed to GitHub. A partial push lands a half-applied feature batch on the VPS — e.g. models drop a symbol but the route that imports it stays behind, and the API container crashes at import time.

```bash
git log @{u}..HEAD --oneline   # must be empty before you ssh to the VPS
```

If anything prints, `git push` first. Only then proceed to the VPS steps below.

```bash
cd /srv/albus/repo
git pull --ff-only
docker compose --env-file /srv/albus/.env -f infra/docker-compose.prod.yml up -d --build
docker compose -f infra/docker-compose.prod.yml logs --tail=100 api
```

Migrations run automatically as part of the API container's CMD (`alembic upgrade head` before `uvicorn`). If a migration fails, the container exits — fix the migration, push, redeploy.

---

## 4. Postgres backup

Manual one-shot dump:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f /srv/albus/repo/infra/docker-compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > /srv/albus/backups/albus-${TS}.sql.gz
```

Daily cron + S3-compatible upload (DigitalOcean Spaces / Backblaze B2 / R2 / Wasabi). Edit `/etc/cron.d/albus-backup` as root:

```cron
# /etc/cron.d/albus-backup — runs daily at 03:14 UTC
SHELL=/bin/bash
PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
14 3 * * * deploy /srv/albus/repo/infra/backup.sh >> /var/log/albus-backup.log 2>&1
```

Create `/srv/albus/repo/infra/backup.sh` only if you actually configure S3. Until then, run the manual dump above and store off-box yourself.

> **Placeholder credentials** — fill these in `/srv/albus/.env`:
> `S3_BUCKET`, `S3_ENDPOINT`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`.

---

## 5. Postgres restore drill

**You must run this drill before you trust your backups.** Do it now:

```bash
# Pick the most recent backup
LATEST=$(ls -1t /srv/albus/backups/*.sql.gz | head -1)
echo "Restoring from $LATEST"

# Spin up an isolated test container (does NOT touch prod db)
docker run --rm -d --name albus-restore-test \
  -e POSTGRES_PASSWORD=test -e POSTGRES_DB=albus_restore \
  -p 55432:5432 postgres:16-alpine
sleep 5

gunzip -c "$LATEST" | docker exec -i albus-restore-test \
  psql -U postgres -d albus_restore

# Smoke-check
docker exec albus-restore-test \
  psql -U postgres -d albus_restore -c "SELECT count(*) FROM tenants;"

docker stop albus-restore-test
```

For a real restore into prod (DESTRUCTIVE — read twice):

```bash
cd /srv/albus/repo
docker compose -f infra/docker-compose.prod.yml stop api web
docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -c "DROP DATABASE $POSTGRES_DB WITH (FORCE);"
docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -c "CREATE DATABASE $POSTGRES_DB;"
gunzip -c /srv/albus/backups/albus-YYYYMMDDTHHMMSSZ.sql.gz | \
  docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker compose -f infra/docker-compose.prod.yml start api web
```

---

## 6. Troubleshooting

```bash
# All logs
docker compose -f infra/docker-compose.prod.yml logs --tail=200 -f

# Just one service
docker compose -f infra/docker-compose.prod.yml logs --tail=200 -f api
docker compose -f infra/docker-compose.prod.yml logs --tail=200 -f web
docker compose -f infra/docker-compose.prod.yml logs --tail=200 -f caddy
docker compose -f infra/docker-compose.prod.yml logs --tail=200 -f db

# Restart a single service
docker compose -f infra/docker-compose.prod.yml restart api

# DB shell
docker compose -f infra/docker-compose.prod.yml exec db \
  psql -U "$POSTGRES_USER" "$POSTGRES_DB"

# Check RLS is on (paste into psql)
\d+ memberships
SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
WHERE relname IN ('memberships','departments','role_types');

# Inspect a token (locally)
echo $TOKEN | cut -d. -f2 | base64 -d 2>/dev/null

# Force-rebuild without cache (e.g. after dependency change)
docker compose -f infra/docker-compose.prod.yml build --no-cache api
docker compose -f infra/docker-compose.prod.yml up -d api

# Disk pressure
docker system df
docker system prune -f --volumes  # only if you know what you're keeping
```

### "Tenant lookup works but /me returns empty lists"
Means RLS is on but `SET LOCAL app.tenant_id` didn't run. Check `app/routes/deps.py` — every protected endpoint must depend on `get_current_context`.

### "RLS blocks me even as the table owner"
Tables are created with `FORCE ROW LEVEL SECURITY` — the owner is **not** exempt. Set `app.tenant_id` in your psql session:
```sql
SET app.tenant_id = '1';
SELECT * FROM departments;
```

---

## 7. Rolling back a bad deploy

```bash
cd /srv/albus/repo
git log --oneline -10              # find last good SHA
git checkout <good-sha>
docker compose --env-file /srv/albus/.env -f infra/docker-compose.prod.yml up -d --build
# When done investigating:
git checkout main
```

If the rollback also requires a DB schema downgrade:
```bash
docker compose -f infra/docker-compose.prod.yml exec api alembic downgrade -1
```
