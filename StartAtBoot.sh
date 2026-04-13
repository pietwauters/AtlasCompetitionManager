#!/usr/bin/env bash
# StartAtBoot.sh — AtlasCompetitionManager
# Configures PM2 to start the app automatically at system boot.
# Mirror of the mqtt-web pattern.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${SUDO_USER:-$USER}"
HOME_DIR="$(eval echo ~"${APP_USER}")"

echo "App dir : $APP_DIR"
echo "App user: $APP_USER"

cd "$APP_DIR"

if ! command -v node &>/dev/null; then
  echo "Error: Node.js is not installed. Run install.sh first."
  exit 1
fi

if ! command -v pm2 &>/dev/null; then
  echo "Installing pm2 globally..."
  sudo npm install -g pm2
fi

sudo mkdir -p "$HOME_DIR/.pm2"
sudo chown -R "$APP_USER":"$APP_USER" "$HOME_DIR/.pm2"

echo "Starting atlas under PM2 as user $APP_USER..."
sudo -u "$APP_USER" pm2 start server.js --name atlas --cwd "$APP_DIR"

echo "Saving PM2 process list..."
sudo -u "$APP_USER" pm2 save

echo "Configuring PM2 to start on boot..."
sudo pm2 startup systemd -u "$APP_USER" --hp "$HOME_DIR"

echo ""
echo "Done. Check status: sudo -u $APP_USER pm2 status"
echo "View logs        : sudo -u $APP_USER pm2 logs atlas"
