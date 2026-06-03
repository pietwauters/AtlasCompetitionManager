#!/usr/bin/env bash
# install.sh — AtlasCompetitionManager
#
# PURPOSE: Full deployment script for a fresh Raspberry Pi (or any Debian/Ubuntu Linux).
# Run as root or with sudo: sudo bash install.sh
#
# Prerequisites: git clone the repo first, then run this script from inside it.
#
# This script is the living record of every manual step required.
# Update it whenever a new dependency or setup step is added.
#
# Usage:
#   sudo bash install.sh
#
set -euo pipefail

APP_NAME="AtlasCompetitionManager"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_USER="${SUDO_USER:-$USER}"

echo "==> Installing $APP_NAME"
echo "    App dir : $APP_DIR"
echo "    App user: $APP_USER"

# ---------------------------------------------------------------------------
# 1. System packages
# ---------------------------------------------------------------------------
echo "==> Installing system packages"
apt-get update -y
apt-get install -y \
  git \
  nodejs \
  npm \
  sqlite3 \
  build-essential \
  python3

# Check Node.js version (18+ required)
NODE_VERSION=$(node -e "console.log(parseInt(process.versions.node.split('.')[0]))")
if (( NODE_VERSION < 18 )); then
  echo "==> Node.js 18+ required. Installing via NodeSource..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
  apt-get install -y nodejs
fi

echo "    node: $(node --version)"
echo "    npm : $(npm --version)"

# ---------------------------------------------------------------------------
# 2. Install Node dependencies
# ---------------------------------------------------------------------------
echo "==> Installing Node.js dependencies"
cd "$APP_DIR"
npm ci --omit=dev

# ---------------------------------------------------------------------------
# 3. Create runtime data directory
# ---------------------------------------------------------------------------
echo "==> Creating data directory"
mkdir -p "$APP_DIR/data"
chown "$APP_USER":"$APP_USER" "$APP_DIR/data"

# ---------------------------------------------------------------------------
# 4. Initialise / migrate database (idempotent — safe to re-run)
# ---------------------------------------------------------------------------
echo "==> Initialising database"
sudo -u "$APP_USER" node -e "require('./db/migrator').migrate(); console.log('    DB ready.');" 2>&1

# ---------------------------------------------------------------------------
# 5. Create .env file from template if it does not already exist
# ---------------------------------------------------------------------------
echo "==> Checking .env"
if [ ! -f "$APP_DIR/.env" ]; then
  cat > "$APP_DIR/.env" << 'EOF'
# Atlas Competition Manager — environment variables
# Copy this file to .env and fill in the values.

PORT=3000

# Required in production. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=change-me-before-going-to-production
EOF
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  echo "    Created .env — set SESSION_SECRET before going to production"
else
  echo "    .env already exists, skipping"
fi

# ---------------------------------------------------------------------------
# 6. Install PM2 globally (process manager)
# ---------------------------------------------------------------------------
echo "==> Installing PM2"
if ! command -v pm2 &>/dev/null; then
  npm install -g pm2
fi

# ---------------------------------------------------------------------------
# 7. Set up systemd service via PM2
# ---------------------------------------------------------------------------
echo "==> Configuring PM2 startup for user $APP_USER"
HOME_DIR="$(eval echo ~"${APP_USER}")"
sudo mkdir -p "$HOME_DIR/.pm2"
sudo chown -R "$APP_USER":"$APP_USER" "$HOME_DIR/.pm2"

sudo -u "$APP_USER" pm2 start "$APP_DIR/server.js" \
  --name atlas \
  --cwd "$APP_DIR" \
  -- 2>/dev/null || true

sudo -u "$APP_USER" pm2 save
sudo pm2 startup systemd -u "$APP_USER" --hp "$HOME_DIR"

echo ""
echo "========================================================"
echo " $APP_NAME installed successfully!"
echo " Access it at: http://$(hostname -I | awk '{print $1}'):3000"
echo " Status : sudo -u $APP_USER pm2 status"
echo " Logs   : sudo -u $APP_USER pm2 logs atlas"
echo "========================================================"
