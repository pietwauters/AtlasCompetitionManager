#!/usr/bin/env bash
# update.sh — AtlasCompetitionManager
#
# PURPOSE: Pull latest code, update dependencies, run migrations, restart.
# Safe to run at any time; migrations are idempotent.
#
# Usage (no sudo needed):
#   bash update.sh
#
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${SUDO_USER:-$USER}"

echo "==> Updating AtlasCompetitionManager"
echo "    App dir : $APP_DIR"
cd "$APP_DIR"

# ---------------------------------------------------------------------------
# 1. Pull latest code
# ---------------------------------------------------------------------------
echo "==> Pulling latest code"
git pull

# ---------------------------------------------------------------------------
# 2. Update Node dependencies (only if package-lock.json changed)
# ---------------------------------------------------------------------------
echo "==> Updating Node.js dependencies"
npm ci --omit=dev

# ---------------------------------------------------------------------------
# 3. Run database migrations (idempotent — safe to re-run)
# ---------------------------------------------------------------------------
echo "==> Running database migrations"
node -e "require('./db/migrator').migrate(); console.log('    DB ready.');"

# ---------------------------------------------------------------------------
# 4. Restart the app
# ---------------------------------------------------------------------------
echo "==> Restarting Atlas"
if command -v pm2 &>/dev/null && pm2 list | grep -q "atlas"; then
  pm2 restart atlas
  pm2 save
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
echo "========================================================"
