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

# Port to listen on. Default 3001 to avoid conflict with mqtt-web (3000).
# Change if another service already uses this port.
PORT=3001

# Required in production. Generate with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
SESSION_SECRET=change-me-before-going-to-production
EOF
  chown "$APP_USER":"$APP_USER" "$APP_DIR/.env"
  echo "    Created .env — set SESSION_SECRET before going to production"
else
  echo "    .env already exists, skipping"
fi

# ---------------------------------------------------------------------------
# 5b. Check the chosen port is not already in use
# ---------------------------------------------------------------------------
APP_PORT=$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d ' ' || echo 3001)
if ss -tlnp 2>/dev/null | grep -q ":${APP_PORT} " || \
   lsof -iTCP:"${APP_PORT}" -sTCP:LISTEN -t 2>/dev/null | grep -q .; then
  echo ""
  echo "  !! WARNING: port ${APP_PORT} is already in use on this machine."
  echo "     Edit $APP_DIR/.env and change PORT= before starting Atlas,"
  echo "     then run: pm2 restart atlas"
  echo ""
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

# ---------------------------------------------------------------------------
# 8. Bootstrap admin account (only on first install — skipped if users exist)
# ---------------------------------------------------------------------------
echo "==> Bootstrapping admin account"
ADMIN_RESULT=$(sudo -u "$APP_USER" node -e "
  require('./db/migrator').migrate();
  const db = require('./db');
  const existing = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (existing > 0) { console.log('SKIP'); process.exit(0); }
  const User = require('./services/users');
  const { user, plainPin } = User.create({ username: 'admin', role: 'admin' });
  console.log('PIN:' + plainPin);
" 2>&1)

if echo "$ADMIN_RESULT" | grep -q "^SKIP"; then
  echo "    Admin account already exists, skipping."
elif echo "$ADMIN_RESULT" | grep -q "^PIN:"; then
  ADMIN_PIN=$(echo "$ADMIN_RESULT" | grep "^PIN:" | cut -d: -f2)
  echo ""
  echo "  ┌─────────────────────────────────────────────┐"
  echo "  │          ADMIN CREDENTIALS — SAVE NOW       │"
  echo "  │                                             │"
  echo "  │  Username : admin                           │"
  echo "  │  PIN      : $ADMIN_PIN                          │"
  echo "  │                                             │"
  echo "  │  You will be forced to change this PIN      │"
  echo "  │  on first login. It will NOT be shown again.│"
  echo "  └─────────────────────────────────────────────┘"
  echo ""
else
  echo "    Warning: could not create admin account: $ADMIN_RESULT"
fi

APP_PORT=$(grep -E '^PORT=' "$APP_DIR/.env" | cut -d= -f2 | tr -d ' ' || echo 3001)
echo ""
echo "========================================================"
echo " $APP_NAME installed successfully!"
echo " Access it at: http://$(hostname -I | awk '{print $1}'):${APP_PORT}"
echo " Login     : http://$(hostname -I | awk '{print $1}'):${APP_PORT}/login.html"
echo " Status : sudo -u $APP_USER pm2 status"
echo " Logs   : sudo -u $APP_USER pm2 logs atlas"
echo "========================================================"
