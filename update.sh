#!/usr/bin/env bash
# update.sh — AtlasCompetitionManager
#
# PURPOSE: Pull latest code, update dependencies, run migrations, restart.
# Safe to run at any time; migrations are idempotent.
#
# Usage:
#   bash update.sh        Code-only update (no sudo needed): git pull, npm ci,
#                          migrate, restart. Fast path for routine updates.
#
#   sudo bash update.sh   Also re-syncs everything install.sh would set up on a
#                          fresh box: system packages, hostname/broker prompts,
#                          the scoresheet credential pool, and the CMS's own
#                          broker certificate. Use this if the box was installed
#                          (or last updated) before a newer provisioning step
#                          landed — see CLAUDE.md's dated feature notes.
#                          Idempotent: every step here skips cleanly if already
#                          done, so it's safe to always use the sudo form.
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${SUDO_USER:-$USER}"
IS_ROOT=false
if [[ $EUID -eq 0 ]]; then IS_ROOT=true; fi

# Runs a command as APP_USER when invoked via sudo, so files stay owned by the
# real app user instead of root (git pull, npm ci, node, pm2). No-op wrapper
# when not running as root — identical to calling the command directly.
run_as_app_user() {
  if $IS_ROOT; then
    sudo -u "$APP_USER" "$@"
  else
    "$@"
  fi
}

echo "==> Updating AtlasCompetitionManager"
echo "    App dir : $APP_DIR"
echo "    Mode    : $($IS_ROOT && echo 'full (sudo) — packages + provisioning refresh' || echo 'code-only (no sudo)')"
cd "$APP_DIR"

# ---------------------------------------------------------------------------
# 1. Pull latest code
#
#    Self-heal (sudo only): boxes originally set up with `sudo git clone`
#    (rather than cloning as APP_USER) can have .git objects/refs left
#    root-owned from that initial clone, even after later commands started
#    running as APP_USER — git pull then fails with "insufficient permission
#    for adding an object to repository database .git/objects". Confirmed on
#    a real deployment: dozens of objects/refs from the original clone were
#    still root:root while newer ones were atlas:atlas. Reclaim before
#    pulling, same idea as the node_modules self-heal below.
# ---------------------------------------------------------------------------
echo "==> Pulling latest code"
if $IS_ROOT && [[ -d "$APP_DIR/.git" ]]; then
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR/.git"
fi
run_as_app_user git pull

# ---------------------------------------------------------------------------
# 1b. System packages (sudo only) — mirrors install.sh's package list so a box
#     that's only ever run update.sh doesn't fall behind on new dependencies
#     (e.g. p7zip-full for the failover bundle, avahi-daemon for mDNS).
# ---------------------------------------------------------------------------
if $IS_ROOT; then
  echo "==> Updating system packages"
  apt-get update -y
  apt-get install -y \
    git \
    nodejs \
    npm \
    sqlite3 \
    build-essential \
    python3 \
    p7zip-full \
    avahi-daemon \
    openssl \
    curl \
    lsof
fi

# ---------------------------------------------------------------------------
# 2. Update Node dependencies (only if package-lock.json changed)
#
#    Self-heal (sudo only): older install.sh ran the initial `npm ci` as
#    root instead of APP_USER, leaving node_modules root-owned on boxes
#    installed before that was fixed — which then makes a plain, non-root
#    `npm ci` fail with EACCES. Reclaim ownership before installing.
# ---------------------------------------------------------------------------
echo "==> Updating Node.js dependencies"
if $IS_ROOT && [[ -d "$APP_DIR/node_modules" ]]; then
  chown -R "$APP_USER":"$APP_USER" "$APP_DIR/node_modules"
fi
run_as_app_user npm ci --omit=dev

# ---------------------------------------------------------------------------
# 2b. Hostname + broker/NTP provisioning (sudo only, interactive only) — same
#     scripts install.sh delegates to, same "skip if not a terminal" handling.
#     Both ask first and are no-ops if already provisioned.
# ---------------------------------------------------------------------------
if $IS_ROOT; then
  if [[ -t 0 ]]; then
    bash "$APP_DIR/scripts/set-hostname.sh"
    bash "$APP_DIR/scripts/provision-broker.sh"
  else
    echo "==> Skipping hostname/broker prompts (not an interactive terminal)"
    echo "    Run ./scripts/set-hostname.sh and ./scripts/provision-broker.sh"
    echo "    manually later if this box needs them."
  fi
fi

# ---------------------------------------------------------------------------
# 3. Run database migrations (idempotent — safe to re-run)
# ---------------------------------------------------------------------------
echo "==> Running database migrations"
run_as_app_user node -e "require('./db/migrator').migrate(); console.log('    DB ready.');"

# ---------------------------------------------------------------------------
# 3b. Scoresheet MQTT credential pool + CMS broker certificate (sudo only) —
#     same idempotent scripts install.sh uses (scripts/seed-credential-pool.js,
#     scripts/issue-cms-certificate.js); both skip cleanly if already
#     provisioned. Then push to Mosquitto if it's on this host.
# ---------------------------------------------------------------------------
if $IS_ROOT; then
  echo "==> Provisioning scoresheet MQTT credential pool"
  run_as_app_user node "$APP_DIR/scripts/seed-credential-pool.js" 2>&1 | sed 's/^/    /'

  echo "==> Provisioning Atlas's own broker client certificate"
  run_as_app_user node "$APP_DIR/scripts/issue-cms-certificate.js" 2>&1 | sed 's/^/    /'

  if command -v mosquitto &>/dev/null; then
    echo "==> Pushing credentials/certificates to the local Mosquitto broker"
    bash "$APP_DIR/scripts/sync-mosquitto-scoresheet-acl.sh"
  else
    echo "    Mosquitto not found on this host — run scripts/sync-mosquitto-scoresheet-acl.sh"
    echo "    manually on the broker host once it's reachable."
  fi
fi

# ---------------------------------------------------------------------------
# 4. Restart the app
# ---------------------------------------------------------------------------
echo "==> Restarting Atlas"
if command -v pm2 &>/dev/null && run_as_app_user pm2 list | grep -q "atlas"; then
  run_as_app_user pm2 restart atlas
  run_as_app_user pm2 save
  echo "    Restarted via PM2"
else
  echo "    PM2 not running — start manually: pm2 start server.js --name atlas"
fi

# ---------------------------------------------------------------------------
# 5. Summary
# ---------------------------------------------------------------------------
COMMIT=$(git log -1 --format="%h %s")
echo ""
echo "========================================================"
echo " AtlasCompetitionManager updated"
echo " Version : $COMMIT"
echo " Access  : http://$(hostname -I | awk '{print $1}'):3000"
echo " Status  : pm2 status"
echo " Logs    : pm2 logs atlas"
if ! $IS_ROOT; then
echo ""
echo " Ran code-only update. Re-run as 'sudo bash update.sh' to also refresh"
echo " system packages and provisioning (hostname/broker/credentials/certs)."
fi
echo "========================================================"
