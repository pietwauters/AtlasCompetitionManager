#!/usr/bin/env bash
# DontStartAtBoot.sh — AtlasCompetitionManager
# Removes PM2 auto-start configuration for this app.
# Mirror of the mqtt-web pattern.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${SUDO_USER:-$USER}"

echo "Disabling AtlasCompetitionManager startup for user: $APP_USER"

if command -v pm2 &>/dev/null; then
  echo "Stopping pm2-managed app (if running)..."
  sudo -u "$APP_USER" pm2 delete atlas || true
  sudo -u "$APP_USER" pm2 save || true
fi

PM2_UNIT="pm2-$APP_USER.service"
if sudo systemctl list-unit-files --type=service 2>/dev/null | grep -q "^${PM2_UNIT}"; then
  echo "Removing systemd unit $PM2_UNIT..."
  sudo systemctl stop    "$PM2_UNIT" || true
  sudo systemctl disable "$PM2_UNIT" || true
  sudo rm -f "/etc/systemd/system/$PM2_UNIT"
  sudo systemctl daemon-reload || true
fi

echo ""
echo "Startup disabled for AtlasCompetitionManager."
echo "You can still run manually: cd $APP_DIR && node server.js"
