# albus-v2 / Trivu — project context for Claude

## Production deploy command (CRITICAL)

The prod web app at https://trivu.net is **NOT** built from the
`docker-compose.yml` at the repo root. The root compose file is for
**local development only**. It builds a separate stack
(`repo-web-1`, `repo-api-1`) on the `repo_default` network — Caddy
never proxies to those containers, so building them changes
absolutely nothing in prod.

**The real prod deploy uses `infra/docker-compose.prod.yml`** with
the production env file. On the server (`trivu.net`, deploy user
`deploy`), the commands are:

```bash
cd /srv/albus/repo
git pull --ff-only
docker compose --env-file /srv/albus/.env -f infra/docker-compose.prod.yml build --no-cache api web
docker compose --env-file /srv/albus/.env -f infra/docker-compose.prod.yml up -d api web
```

Always pass **both** `--env-file /srv/albus/.env` and
`-f infra/docker-compose.prod.yml`. Forgetting either is the same
class of bug.

After this, the containers Caddy (`infra-caddy-1`) reverse-proxies
to are `infra-web-1` and `infra-api-1` on the `infra_default`
network. Confirm a deploy actually shipped by inspecting that
network:

```bash
docker ps --format '{{.Names}}' | grep infra-
docker compose --env-file /srv/albus/.env -f infra/docker-compose.prod.yml ps
```

Do **not** suggest:
- `docker compose build web` (no `-f`/`--env-file`)
- `cd /srv/albus && docker compose ...` (wrong path; repo lives at
  `/srv/albus/repo`)
- Rebuilding `repo-web-1` to fix a prod bug (wrong container,
  Caddy doesn't talk to it)

## Repo layout on the server

```
/srv/albus/.env            ← prod env vars (NEXT_PUBLIC_*, secrets, …)
/srv/albus/repo/           ← git checkout
/srv/albus/repo/infra/docker-compose.prod.yml   ← actual prod compose
/srv/albus/repo/docker-compose.yml              ← local dev only
/srv/albus/avatars/        ← host-mounted volume for uploaded photos
```

## Stack overview

- Frontend: Next.js 14 (app router, standalone output), Tailwind,
  @tanstack/react-query, lucide-react icons.
- Backend: FastAPI + SQLAlchemy 2.0 + Postgres 16 + OR-Tools
  CP-SAT.
- Multi-tenant via path-based routing + Postgres RLS (FORCE).
- Reverse proxy: Caddy 2 (`infra-caddy-1`) auto-issuing
  Let's Encrypt certs for `trivu.net` and `api.trivu.net`.
- SMTP via Resend (port 587 STARTTLS).
- Caddyfile lives inside the `infra-caddy-1` container at
  `/etc/caddy/Caddyfile`; the simple form is just
  `reverse_proxy web:3000` (resolved on `infra_default`).

## Why this matters

Multiple times in past sessions I (Claude) have:
1. Assumed `docker-compose.yml` at the repo root is the prod file.
2. Told the user to run `docker compose build --no-cache web`.
3. Watched the bundle never reach Caddy because it built the wrong
   stack.

Each round of this wastes hours. **Always start any prod deploy
suggestion from the four-line block above.** When in doubt, ask
the user "what's your deploy command?" before suggesting any
build.

## Other gotchas worth remembering

- `NEXT_PUBLIC_*` env vars are baked at **build** time, not runtime.
  They must be passed as `args:` (not `environment:`) under the
  `web` service. The `--env-file /srv/albus/.env` flag makes
  variables from that file available as compose interpolations,
  which is how `NEXT_PUBLIC_API_BASE_URL=https://trivu.net` ends
  up in the bundle.
- BuildKit's layer cache accumulates indefinitely (saw 68 GB on
  prod once). `docker builder prune -af` periodically; or schedule
  a weekly cron with `--filter until=168h`.
- Avatars live in a host volume at `/srv/albus/avatars` mounted
  into the api container at `/srv/avatars`. Ownership should be
  `deploy:deploy`; if Docker auto-creates it as root, fix with
  `sudo chown -R deploy:deploy /srv/albus/avatars`.
- Don't run destructive Postgres operations without explicit user
  confirmation, even if "obviously" needed for a fix.

## Working style — DO NOT nudge to stop

Florian decides when a session is over. Never suggest taking a
break, getting lunch, calling it shipped, stopping for the day,
or otherwise winding down. Do not editorialise about how much
has been done or imply "you're tired" / "you've earned a rest" /
"that's enough for one session." Treat every session as 24/7
available — keep delivering work until he explicitly says stop.

When a chunk of work finishes, the right response is "what's
next?" or a short summary plus a concrete suggested next action
— never a "you should rest now" beat.
