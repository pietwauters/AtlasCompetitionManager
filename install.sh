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
  python3 \
  p7zip-full \
  avahi-daemon \
  openssl \
  curl \
  lsof

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
# 3b. Optionally set this machine's hostname to "openpiste" — CLAUDE.md's TLS/OPP2
#     design assumes devices reach this server as openpiste.local via mDNS
#     (avahi-daemon, installed in step 1, advertises <hostname>.local
#     automatically). Delegates to scripts/set-hostname.sh (asks first, backs up
#     the original — see that script for the idempotency/backup details) rather
#     than duplicating that logic here. Skipped if not an interactive terminal
#     (e.g. install.sh piped from curl) — run scripts/set-hostname.sh manually
#     afterward in that case.
# ---------------------------------------------------------------------------
if [[ -t 0 ]]; then
  bash "$APP_DIR/scripts/set-hostname.sh"
else
  echo "==> Skipping hostname prompt (not an interactive terminal)"
  echo "    Run ./scripts/set-hostname.sh later if you want this machine to be"
  echo "    reachable as openpiste.local."
fi

# ---------------------------------------------------------------------------
# 3c. Optionally provision Mosquitto's base listeners + chrony as a local NTP
#     server on this machine — see scripts/provision-broker.sh for the full
#     reasoning (asks first per listener/package, idempotent, backs up before
#     editing). Same "skip if not interactive" handling as the hostname step.
# ---------------------------------------------------------------------------
if [[ -t 0 ]]; then
  bash "$APP_DIR/scripts/provision-broker.sh"
else
  echo "==> Skipping broker/NTP prompts (not an interactive terminal)"
  echo "    Run ./scripts/provision-broker.sh later if this machine should host"
  echo "    the MQTT broker and/or a local NTP server."
fi

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

# ---------------------------------------------------------------------------
# 9. Scoresheet MQTT credential pool (first install only — skipped if any exist)
# ---------------------------------------------------------------------------
echo "==> Provisioning scoresheet MQTT credential pool"
POOL_RESULT=$(sudo -u "$APP_USER" node -e "
  require('./db/migrator').migrate();
  const Pairing = require('./services/pairing');
  const stats = Pairing.poolStats();
  if (stats.total > 0) { console.log('SKIP'); process.exit(0); }
  const created = Pairing.createPoolBatch(10);
  console.log('CREATED:' + created.length);
" 2>&1)

if echo "$POOL_RESULT" | grep -q "^SKIP"; then
  echo "    Credential pool already provisioned, skipping."
elif echo "$POOL_RESULT" | grep -q "^CREATED:"; then
  N=$(echo "$POOL_RESULT" | grep "^CREATED:" | cut -d: -f2)
  echo "    Created $N scoresheet MQTT credential(s) in Atlas's own database."
else
  echo "    Warning: could not provision credential pool: $POOL_RESULT"
fi

# ---------------------------------------------------------------------------
# 10. CMS's own Tier A client certificate (Atlas authenticates to the broker
#     itself instead of connecting anonymously — see
#     services/provisioning.js's issueCmsCertificate). Skipped if one already
#     exists so re-running install.sh (e.g. an upgrade) doesn't needlessly
#     reissue/supersede it. Needs the local CA (generate-tls-cert.sh) to
#     already exist — same prerequisite as the HTTPS listener, so an install
#     that's never generated TLS material at all just gets a printed
#     next-step instead of failing.
# ---------------------------------------------------------------------------
echo "==> Provisioning Atlas's own broker client certificate"
if [[ -f "$APP_DIR/data/tls/software-client.crt" ]]; then
  echo "    CMS client certificate already provisioned, skipping."
elif [[ -f "$APP_DIR/data/tls/ca.key" && -f "$APP_DIR/data/tls/ca.crt" ]]; then
  CMS_CERT_RESULT=$(sudo -u "$APP_USER" node -e "
    const Provisioning = require('./services/provisioning');
    const { serial } = Provisioning.issueCmsCertificate();
    console.log('ISSUED:' + serial);
  " 2>&1)
  if echo "$CMS_CERT_RESULT" | grep -q "^ISSUED:"; then
    echo "    Issued (serial $(echo "$CMS_CERT_RESULT" | cut -d: -f2)) — Atlas will use it"
    echo "    automatically on next start, once it's pushed to the broker below."
  else
    echo "    Warning: could not issue CMS client certificate: $CMS_CERT_RESULT"
  fi
else
  echo "    No local CA yet — run ./scripts/generate-tls-cert.sh, then re-run this"
  echo "    step manually: ./scripts/provision-cms-client-cert.sh"
fi

# Pushing these to Mosquitto only makes sense if the broker is on this same
# host — see scripts/install-broker-cert.sh for the separate-hardware case,
# same reasoning applies here. Re-run is safe: the sync script fully
# regenerates the ACL/passwd files from Atlas's DB each time (this also picks
# up the CMS certificate above, since it reads tier_a_certificates
# generically — no separate call needed for it).
if command -v mosquitto &>/dev/null; then
  echo "==> Pushing scoresheet credentials to the local Mosquitto broker"
  bash "$APP_DIR/scripts/sync-mosquitto-scoresheet-acl.sh"
  echo ""
  echo "  Note: this pushed ACL/password entries, but does NOT itself make listener"
  echo "  8883 require or check TLS client certificates (require_certificate,"
  echo "  use_identity_as_username, crlfile) — that's a separate, more invasive"
  echo "  listener config change (full mosquitto restart, not just a reload), left as"
  echo "  a deliberate manual step rather than silently flipped on every install:"
  echo "    ./scripts/sync-mosquitto-tier-a.sh"
  echo "  Until that's run, any Tier A certificate (including the CMS's own, above)"
  echo "  is issued and ACL-scoped but not yet enforced/usable at the broker."
else
  echo ""
  echo "  !! Mosquitto not found on this host — scoresheet MQTT credentials and any"
  echo "     CMS/Tier A certificate were generated in Atlas's own database but not"
  echo "     pushed to any broker yet. Once your broker is reachable (locally or on"
  echo "     separate hardware, per scripts/install-broker-cert.sh), run:"
  echo "       ./scripts/sync-mosquitto-scoresheet-acl.sh"
  echo "       ./scripts/sync-mosquitto-tier-a.sh"
  echo ""
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
