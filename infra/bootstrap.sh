#!/usr/bin/env bash
# albus-v2 VPS bootstrap. Read top-to-bottom before running.
# Idempotent: safe to re-run. Does NOT clone the repo (you do that manually).
#
# Tested on Ubuntu 22.04 / Debian 12. Run as root or with sudo.

set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-deploy}"
APP_ROOT="${APP_ROOT:-/srv/albus}"
REPO_DIR="${REPO_DIR:-${APP_ROOT}/repo}"

echo "==> albus-v2 bootstrap"
echo "    deploy user : ${DEPLOY_USER}"
echo "    app root    : ${APP_ROOT}"
echo "    repo dir    : ${REPO_DIR}"

if [[ "$EUID" -ne 0 ]]; then
  echo "Run as root (sudo)." >&2
  exit 1
fi

# 1. Base packages
echo "==> Installing base packages"
apt-get update -y
apt-get install -y \
  ca-certificates curl gnupg lsb-release ufw git fail2ban \
  postgresql-client unattended-upgrades

# 2. Docker (official repo)
if ! command -v docker >/dev/null 2>&1; then
  echo "==> Installing Docker"
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/$(. /etc/os-release; echo "$ID")/gpg \
    | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
  chmod a+r /etc/apt/keyrings/docker.gpg
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
https://download.docker.com/linux/$(. /etc/os-release; echo "$ID") $(lsb_release -cs) stable" \
    > /etc/apt/sources.list.d/docker.list
  apt-get update -y
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
  systemctl enable --now docker
else
  echo "==> Docker already installed"
fi

# 3. Deploy user
if ! id "${DEPLOY_USER}" >/dev/null 2>&1; then
  echo "==> Creating user ${DEPLOY_USER}"
  adduser --disabled-password --gecos "" "${DEPLOY_USER}"
fi
usermod -aG docker "${DEPLOY_USER}"

# 4. Directories
echo "==> Creating directories under ${APP_ROOT}"
mkdir -p "${APP_ROOT}"/{db,caddy/data,caddy/config,backups,avatars,voice-notes}
chown -R "${DEPLOY_USER}:${DEPLOY_USER}" "${APP_ROOT}"
chmod 750 "${APP_ROOT}"

# 5. Env template
if [[ ! -f "${APP_ROOT}/.env" ]]; then
  echo "==> Writing env template at ${APP_ROOT}/.env (REVIEW AND FILL IN BEFORE DEPLOY)"
  cat > "${APP_ROOT}/.env" <<'ENV'
POSTGRES_USER=albus
POSTGRES_PASSWORD=CHANGE_ME
POSTGRES_DB=albus
JWT_SECRET=CHANGE_ME
S3_BUCKET=
S3_ENDPOINT=
S3_ACCESS_KEY=
S3_SECRET_KEY=
ENV
  chown "${DEPLOY_USER}:${DEPLOY_USER}" "${APP_ROOT}/.env"
  chmod 600 "${APP_ROOT}/.env"
fi

# 6. Firewall
echo "==> Configuring UFW"
ufw allow OpenSSH || true
ufw allow 80/tcp || true
ufw allow 443/tcp || true
ufw --force enable

# 7. Unattended upgrades
echo "==> Enabling unattended-upgrades"
dpkg-reconfigure -f noninteractive unattended-upgrades

cat <<DONE

==> bootstrap complete

Next steps (as ${DEPLOY_USER}):
  sudo -iu ${DEPLOY_USER}
  cd ${APP_ROOT}
  git clone git@github.com:floriandall-es/albus-v2.git ${REPO_DIR}
  vi ${APP_ROOT}/.env             # fill in real secrets (POSTGRES_PASSWORD, JWT_SECRET, SMTP_*)
  cd ${REPO_DIR}
  docker compose --env-file ${APP_ROOT}/.env -f infra/docker-compose.prod.yml up -d --build

See infra/RUNBOOK.md for the full deploy / backup / restore / troubleshooting guide.
DONE
