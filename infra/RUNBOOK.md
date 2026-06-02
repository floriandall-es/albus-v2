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

**If you changed the Caddyfile** (e.g. the chat realtime SSE deploy added an `encode` exclusion for `/api/realtime/stream`), reload Caddy so the new config takes effect:

```bash
docker compose -f infra/docker-compose.prod.yml exec caddy caddy reload --config /etc/caddy/Caddyfile
# or, if the container doesn't pick it up: restart just caddy
docker compose -f infra/docker-compose.prod.yml restart caddy
```

---

## 3a. Chat realtime (SSE)

Chat pushes new messages / read-receipts / deletions over Server-Sent
Events (`GET /api/realtime/stream`) instead of polling. Operational notes:

- **Single worker only.** The fan-out broker (`app/services/realtime.py`)
  is **in-process** — it reaches only SSE connections held by the same
  uvicorn process. The prod API runs one worker (see `api/Dockerfile`),
  so this is correct today. ⚠️ **Do NOT add `--workers N` / a second API
  replica without first moving the broker to Postgres LISTEN/NOTIFY (or
  Redis).** With multiple workers, a message sent on worker A won't reach
  a subscriber on worker B and realtime silently half-breaks (the client
  still self-heals via its slow fallback poll, so it won't error — it'll
  just feel laggy and inconsistent).
- **Caddy must not compress the stream.** The Caddyfile excludes
  `/api/realtime/stream` from `encode` (gzip/zstd buffer the response,
  which stalls SSE). If you ever rewrite the proxy block, keep that
  exclusion.
- **Health check:** `curl -N https://api.trivu.net/api/realtime/stream?ticket=BOGUS`
  should return `401` immediately (invalid ticket). A valid stream emits
  a `: connected` line, then `: ping` every ~25s.

---

## 4. Postgres backup

`infra/backup.sh` (now a real, committed script) dumps Postgres (logical, gzip)
**and** the user-uploaded file volumes (avatars + voice notes), uploads both to
S3-compatible storage, prunes old local copies, and optionally pings a
dead-man's-switch. Manual one-shot if you ever need it:

```bash
TS=$(date -u +%Y%m%dT%H%M%SZ)
docker compose -f /srv/albus/repo/infra/docker-compose.prod.yml exec -T db \
  pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" | gzip > /srv/albus/backups/albus-db-${TS}.sql.gz
```

**Setup (do once):**

1. Fill these in `/srv/albus/.env` (S3-compatible: Backblaze B2 / R2 / Wasabi /
   DO Spaces / Hetzner):
   ```
   S3_BUCKET=albus-backups
   S3_ENDPOINT=https://s3.eu-central-003.backblazeb2.com   # your provider's EU endpoint
   S3_ACCESS_KEY=...
   S3_SECRET_KEY=...
   # optional tunables:
   BACKUP_RETENTION_DAYS=14        # local copies; off-box retention = bucket lifecycle
   BACKUP_PING_URL=https://hc-ping.com/<uuid>   # healthchecks.io dead-man's-switch
   ```
   Prefer an **EU** bucket region (hospital data). The off-box copy is the whole
   point — a backup on the same disk as the DB is not a backup.
2. Set a **lifecycle / retention rule on the bucket** (e.g. keep 30 days) — the
   script only prunes the *local* staging copies; S3 retention is the bucket's job.
3. Install the daily cron. **No-sudo (preferred — runs as `deploy`):**
   `crontab -e` and add:
   ```cron
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   14 3 * * * /srv/albus/repo/infra/backup.sh >> /srv/albus/backup.log 2>&1
   ```
   (Works because `deploy` is already in the `docker` group and can read
   `/srv/albus/.env`.) **With root**, equivalently `/etc/cron.d/albus-backup`:
   ```cron
   SHELL=/bin/bash
   PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
   14 3 * * * deploy /srv/albus/repo/infra/backup.sh >> /var/log/albus-backup.log 2>&1
   ```
4. Run it once by hand and confirm the objects land in the bucket:
   ```bash
   /srv/albus/repo/infra/backup.sh
   ```

Alert recipient: alerting on a *failed* run is best done with the
`BACKUP_PING_URL` dead-man's-switch (healthchecks.io free tier) — it pages you
when a run is **missed**, which a crashed cron can't do for itself.

---

## 5. Postgres restore drill + real restore

**An untested backup is not a backup. Run the drill now and monthly:**

```bash
/srv/albus/repo/infra/restore-drill.sh        # newest dump in /srv/albus/backups
# → spins a throwaway Postgres, restores, prints alembic_version + row
#   counts, tears down. Exit 0 = PASS. Touches nothing in prod.
```

To test the *off-box* copy specifically, pull the latest object from S3 first and
pass its path to the script.

**RPO / RTO (target):**
- **RPO ≤ 24h** — daily backup, so at most one day of writes lost. Tighten to
  hourly later if a hospital's tolerance is lower.
- **RTO ≤ 1h** — restore into the running DB container (below) is minutes;
  the hour absorbs diagnosis + a fresh-host rebuild if the VPS itself is gone.

**Real restore into prod (DESTRUCTIVE — read twice):**

```bash
cd /srv/albus/repo
docker compose -f infra/docker-compose.prod.yml stop api web
docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -c "DROP DATABASE $POSTGRES_DB WITH (FORCE);"
docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -c "CREATE DATABASE $POSTGRES_DB;"
gunzip -c /srv/albus/backups/albus-db-YYYYMMDDTHHMMSSZ.sql.gz | \
  docker compose -f infra/docker-compose.prod.yml exec -T db \
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB"
docker compose -f infra/docker-compose.prod.yml start api web
# Don't forget the files: extract albus-files-*.tar.gz back into
# /srv/albus/avatars and /srv/albus/voice-notes.
```

> **Fresh-host DR** (the VPS is gone, not just the DB): the dump GRANTs to the
> `albus_app` role, so on a brand-new server create that role *before* loading
> the dump (`CREATE ROLE albus_app LOGIN PASSWORD '…';`) — otherwise the GRANT
> lines error. On the existing prod DB the role already exists, so the steps
> above are enough. The drill script does this role pre-creation for you.

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

## 8. Billing (Stripe)

See `docs/billing-plan.md` for the model + pricing. This section
is operational — keys, payment-flow debugging, manual recovery.

### Keys + secrets

All four live in `/srv/albus/.env`. Restart `api` after rotating
any of them so the new value picks up.

```env
STRIPE_SECRET_KEY=sk_live_xxx          # Stripe Dashboard → Developers → API keys
STRIPE_WEBHOOK_SECRET=whsec_xxx        # Stripe Dashboard → Developers → Webhooks → our endpoint
STRIPE_PRICE_ADMIN=price_xxx           # Recurring price €29.90 / month
STRIPE_PRICE_MEMBER=price_xxx          # Recurring price €4.90 / month
```

Use the Stripe **test** keys against the dev VPS / staging branch
and **live** keys only on `main`. Mixing them confuses the
webhook signature check and breaks every subscription event.

### Test card numbers (test mode only)

- `4242 4242 4242 4242` — succeeds
- `4000 0000 0000 9995` — declined (insufficient funds)
- `4000 0025 0000 3155` — requires 3DS authentication
- `4000 0000 0000 0341` — succeeds at first, then disputes
- Any future expiry, any 3-digit CVC, any postal code

### Replaying a webhook locally

1. Find the `evt_xxx` ID in `stripe_events` for the event you
   want to replay, or hunt it down in the Stripe Dashboard
   (Developers → Events).
2. `stripe events resend evt_xxx --webhook-endpoint we_xxx`
   from a shell with the Stripe CLI logged in.
3. Idempotency: the handler short-circuits on a duplicate
   `event_id`. To force re-processing, first
   `DELETE FROM stripe_events WHERE event_id = 'evt_xxx';`.

### Manually grandfathering a tenant

If a customer needs to be marked "active, free" outside the
normal Stripe flow (alpha pilot exception, comp account, etc.):

```sql
-- Replace 123 with the tenant id.
UPDATE tenants
   SET subscription_status = 'active',
       trial_end_at        = '2099-12-31 00:00:00+00',
       billing_model       = 'team_pays'
 WHERE id = 123;

UPDATE persons p
   SET subscription_status = 'active',
       trial_end_at        = '2099-12-31 00:00:00+00'
  FROM memberships m
 WHERE m.person_id = p.id
   AND m.tenant_id = 123;
```

The `'2099-12-31 00:00:00+00'` sentinel is what migration 0081
uses for alpha pilots; reusing it keeps the data uniform and
makes future downgrades easier.

### Common failure modes

- **"402 — Tu suscripción no está activa"** on every write
  endpoint: the tenant lapsed (`unpaid` / `canceled`). Check
  `subscription_status` in the DB and `stripe_events` for the
  most recent `customer.subscription.updated` event. The admin
  fixes it themselves from `/admin/billing` → Customer Portal.

- **Webhook 400s with "Invalid signature"**: `STRIPE_WEBHOOK_SECRET`
  doesn't match the endpoint the event came from. Most common
  cause: pointing live webhooks at a dev VPS or vice versa.

- **"No hay cuenta de facturación todavía"** on the Portal
  button: the tenant/person has no `stripe_customer_id`. Either
  they're grandfathered (expected — button stays disabled), or
  the first subscription flow hasn't been kicked off yet.
