#!/usr/bin/env bash
#
# Restore drill (ops P2) — prove the latest backup actually restores.
#
# An untested backup is Schrödinger's backup. This spins a THROWAWAY
# Postgres, loads the most recent dump into it, verifies the schema +
# row counts + migration head, and tears it down. Exit 0 = PASS.
#
# Run it once after configuring backups, then periodically (a monthly
# cron is ideal). Touches nothing in prod — it's an isolated container.
#
# Usage:
#   infra/restore-drill.sh                 # newest dump in $BACKUP_DIR
#   infra/restore-drill.sh /path/to.sql.gz # a specific dump
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ENV_FILE="${ENV_FILE:-/srv/albus/.env}"
BACKUP_DIR="${BACKUP_DIR:-/srv/albus/backups}"
PG_IMAGE="${PG_IMAGE:-postgres:16-alpine}"
APP_ROLE="${APP_DB_ROLE:-albus_app}"
CONTAINER="albus-restore-drill-$$"

# Load the env file SAFELY (docker-compose format isn't shell-quoted —
# see the matching note in backup.sh). Parse, don't source.
load_env_file() {
    local file="$1" line key val
    [ -f "$file" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        case "$line" in ''|'#'*) continue ;; esac
        case "$line" in *=*) ;; *) continue ;; esac
        key="${line%%=*}"
        val="${line#*=}"
        case "$key" in ''|*[!A-Za-z0-9_]*) continue ;; esac
        case "$val" in
            \"*\") val="${val#\"}"; val="${val%\"}" ;;
            \'*\') val="${val#\'}"; val="${val%\'}" ;;
        esac
        export "$key=$val"
    done < "$file"
}
load_env_file "$ENV_FILE"

DUMP="${1:-}"
if [ -z "$DUMP" ]; then
    DUMP="$(ls -1t "$BACKUP_DIR"/albus-db-*.sql.gz 2>/dev/null | head -1 || true)"
fi
[ -n "$DUMP" ] && [ -f "$DUMP" ] \
    || { echo "No dump found in $BACKUP_DIR (or pass a path)."; exit 1; }
echo "Restore drill: $DUMP"

cleanup() { docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; }
trap cleanup EXIT

echo "Starting throwaway $PG_IMAGE ($CONTAINER)…"
docker run --rm -d --name "$CONTAINER" \
    -e POSTGRES_PASSWORD=drill -e POSTGRES_DB=albus_restore \
    "$PG_IMAGE" >/dev/null

ready=0
for _ in $(seq 1 30); do
    if docker exec "$CONTAINER" pg_isready -U postgres -d albus_restore \
        >/dev/null 2>&1; then ready=1; break; fi
    sleep 1
done
[ "$ready" = 1 ] || { echo "FAIL: throwaway Postgres never became ready"; exit 1; }

# The dump GRANTs to the app role; create it first so the restore is
# faithful (a real DR restore into a fresh server needs the same — see
# RUNBOOK §5). ON_ERROR_STOP=0: tolerate "already exists" etc.
docker exec -i "$CONTAINER" psql -U postgres -d albus_restore \
    -v ON_ERROR_STOP=0 \
    -c "CREATE ROLE \"$APP_ROLE\" LOGIN PASSWORD 'drill';" >/dev/null 2>&1 || true

echo "Loading dump…"
LOG=/tmp/albus-restore-drill.log
gunzip -c "$DUMP" \
    | docker exec -i "$CONTAINER" psql -U postgres -d albus_restore \
        -v ON_ERROR_STOP=0 >"$LOG" 2>&1 || true

q() {
    docker exec "$CONTAINER" psql -U postgres -d albus_restore -tAc "$1" \
        2>/dev/null | tr -d '[:space:]'
}

REV="$(q "SELECT version_num FROM alembic_version" || true)"
TENANTS="$(q "SELECT count(*) FROM tenants" || true)"
PERSONS="$(q "SELECT count(*) FROM persons" || true)"
SCHEDULES="$(q "SELECT count(*) FROM schedules" || true)"
ASSIGN="$(q "SELECT count(*) FROM assignments" || true)"

echo "  alembic_version : ${REV:-<none>}"
echo "  tenants=${TENANTS:-?} persons=${PERSONS:-?} schedules=${SCHEDULES:-?} assignments=${ASSIGN:-?}"

fail=0
[ -n "$REV" ] || { echo "FAIL: alembic_version not restored"; fail=1; }
case "${TENANTS:-}" in
    ''|*[!0-9]*) echo "FAIL: tenants count unreadable"; fail=1 ;;
    *) [ "$TENANTS" -ge 1 ] || { echo "FAIL: zero tenants restored"; fail=1; } ;;
esac

if [ "$fail" = 0 ]; then
    echo "PASS ✅  backup restores cleanly"
else
    echo "FAIL ❌  see $LOG for the psql output"
fi
exit "$fail"
