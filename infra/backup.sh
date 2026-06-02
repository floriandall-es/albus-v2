#!/usr/bin/env bash
#
# Daily off-box backup (ops P2).
#
# Dumps Postgres (logical, gzipped) + the user-uploaded file volumes
# (avatars, voice notes), uploads both to S3-compatible storage, and
# prunes old local copies. Referenced by /etc/cron.d/albus-backup
# (see RUNBOOK.md §4).
#
# Config is read from the prod env file (POSTGRES_*, S3_*). Paths and
# tunables are overridable via env so the script can be exercised
# against a dev stack. Fails loudly (non-zero exit) so the cron / a
# dead-man's-switch notices; on success it optionally pings
# BACKUP_PING_URL (healthchecks.io etc.) — that's what alerts you when
# a run is *missed*, which a failing job can't do for itself.
#
# Uses the dockerised AWS CLI (amazon/aws-cli) for the upload so the
# host needs no extra packages — Docker is already here.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMPOSE_FILE="${COMPOSE_FILE:-$REPO_DIR/infra/docker-compose.prod.yml}"
ENV_FILE="${ENV_FILE:-/srv/albus/.env}"
BACKUP_DIR="${BACKUP_DIR:-/srv/albus/backups}"
AVATARS_DIR="${AVATARS_DIR:-/srv/albus/avatars}"
VOICE_NOTES_DIR="${VOICE_NOTES_DIR:-/srv/albus/voice-notes}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-14}"
DB_SERVICE="${DB_SERVICE:-db}"

log() { echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] $*"; }
die() { log "ERROR: $*"; exit 1; }

# Load secrets/config SAFELY. The env file is in docker-compose
# env-file format (KEY=VALUE, values NOT shell-quoted), so `source`-ing
# it breaks on values containing shell metacharacters — e.g.
# SMTP_FROM=Trivu <noreply@trivu.net> (the `<` is a redirect). Parse
# line-by-line and assign literally instead.
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
: "${POSTGRES_USER:?POSTGRES_USER not set (env file: $ENV_FILE)}"
: "${POSTGRES_DB:?POSTGRES_DB not set (env file: $ENV_FILE)}"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
mkdir -p "$BACKUP_DIR"
DB_FILE="$BACKUP_DIR/albus-db-$TS.sql.gz"
FILES_FILE="$BACKUP_DIR/albus-files-$TS.tar.gz"

dc() { docker compose --env-file "$ENV_FILE" -f "$COMPOSE_FILE" "$@"; }

filesize() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1"; }

# --- 1. Postgres logical dump (plain SQL → gzip; matches the restore
#        path documented in RUNBOOK §5). `set -o pipefail` makes a
#        pg_dump failure fail the whole pipe.
log "pg_dump $POSTGRES_DB → $DB_FILE"
dc exec -T "$DB_SERVICE" pg_dump -U "$POSTGRES_USER" "$POSTGRES_DB" \
    | gzip -9 > "$DB_FILE"
gzip -t "$DB_FILE" || die "dump failed gzip integrity check"
SIZE="$(filesize "$DB_FILE")"
[ "${SIZE:-0}" -ge 1000 ] || die "dump suspiciously small (${SIZE} bytes) — aborting"
log "db dump OK (${SIZE} bytes)"

# --- 2. User-uploaded files (avatars + voice notes). Not in the DB,
#        so a DB-only backup would lose them.
FILE_PATHS=()
[ -d "$AVATARS_DIR" ] && FILE_PATHS+=("$AVATARS_DIR")
[ -d "$VOICE_NOTES_DIR" ] && FILE_PATHS+=("$VOICE_NOTES_DIR")
if [ "${#FILE_PATHS[@]}" -gt 0 ]; then
    log "tar files → $FILES_FILE"
    tar -czf "$FILES_FILE" "${FILE_PATHS[@]}"
else
    log "no file volumes present — skipping files archive"
    FILES_FILE=""
fi

# --- 3. Upload off-box (S3-compatible). Skipped if S3 isn't configured
#        — you still get a local copy, but DO configure it: a backup on
#        the same disk as the DB is not a backup.
if [ -n "${S3_BUCKET:-}" ]; then
    aws_s3() {
        local extra=()
        [ -n "${S3_ENDPOINT:-}" ] && extra=(--endpoint-url "$S3_ENDPOINT")
        # S3-compatible providers (Hetzner, Backblaze, R2…) still need a
        # region set or the CLI errors "You must specify a region".
        # S3_REGION matches the provider's location (Hetzner: fsn1/nbg1/
        # hel1); default us-east-1 is the harmless catch-all most accept.
        docker run --rm \
            -e AWS_ACCESS_KEY_ID="${S3_ACCESS_KEY:-}" \
            -e AWS_SECRET_ACCESS_KEY="${S3_SECRET_KEY:-}" \
            -e AWS_DEFAULT_REGION="${S3_REGION:-us-east-1}" \
            -v "$BACKUP_DIR:/backups:ro" \
            amazon/aws-cli "${extra[@]}" "$@"
    }
    log "upload → s3://$S3_BUCKET"
    aws_s3 s3 cp "/backups/$(basename "$DB_FILE")" \
        "s3://$S3_BUCKET/db/$(basename "$DB_FILE")"
    if [ -n "$FILES_FILE" ]; then
        aws_s3 s3 cp "/backups/$(basename "$FILES_FILE")" \
            "s3://$S3_BUCKET/files/$(basename "$FILES_FILE")"
    fi
    log "upload OK"
else
    log "S3_BUCKET unset — keeping LOCAL ONLY (configure S3 for real DR)"
fi

# --- 4. Prune old local copies. Off-box retention is the S3 bucket's
#        lifecycle policy (see RUNBOOK §4) — set that on the bucket.
log "pruning local backups older than ${RETENTION_DAYS}d"
find "$BACKUP_DIR" -maxdepth 1 -name 'albus-*.gz' -type f \
    -mtime +"$RETENTION_DAYS" -delete || true

# --- 5. Dead-man's-switch ping (success only).
if [ -n "${BACKUP_PING_URL:-}" ]; then
    curl -fsS -m 10 "$BACKUP_PING_URL" >/dev/null \
        && log "pinged monitor" || log "WARN: monitor ping failed"
fi

log "backup OK: $(basename "$DB_FILE")"
