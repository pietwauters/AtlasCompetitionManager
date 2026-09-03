#!/usr/bin/env bash
# atlas-firstboot.sh — TEMPLATE. Not run from this repo checkout directly.
#
# scripts/prepare-pi-firstboot.sh writes a copy of this file onto a freshly
# flashed Raspberry Pi's root filesystem (substituting __TARGET_USER__ for the
# real username), alongside a systemd unit that runs it once on first real
# boot, as root. See docs/pi-image-quickstart.md for the full flow.
#
# Provisions the complete stack unattended: the Atlas app itself (install.sh),
# the MQTT broker + local NTP server (provision-broker.sh), and the full Tier A
# mTLS authentication chain (local CA, broker TLS listeners, Atlas's own client
# certificate, ACL sync, CRL enforcement) — everything a real competition
# deployment needs, not just the app.
#
# Privilege separation matters here and is deliberate per step, not uniform:
# anything that writes into data/tls/ or the app's own database must run as
# TARGET_USER (the same user Atlas itself runs as, per install.sh's own
# chown of $APP_DIR/data) — running those steps as root would leave those
# files root-owned and break every future non-root write by the running Atlas
# process, exactly the failure mode CLAUDE.md documents for the admin.html CRL
# button. Steps that only touch system paths (/etc/mosquitto, apt, systemctl)
# run directly as root, since this whole script already IS root (no sudoers
# grant needed anywhere here — that's only a concern for a *browser-triggered*
# privileged action, not a systemd unit that's root by construction).
#
# Not idempotent by design: this only ever runs once (the systemd unit
# disables itself on success, see the end of this script). If it fails
# partway, don't re-run it blindly from here — every step it calls
# (install.sh, provision-broker.sh, etc.) is independently safe to re-run by
# hand over SSH once you've found and fixed whatever broke; that's the whole
# point of logging each step's output separately below.

set -euo pipefail
exec > >(tee -a /var/log/atlas-firstboot.log) 2>&1

echo "=== Atlas first-boot provisioning started: $(date) ==="

TARGET_USER="__TARGET_USER__"
REPO_URL="https://github.com/pietwauters/AtlasCompetitionManager.git"

# rpi-imager's own OS-customization first-run step creates TARGET_USER earlier
# in boot than this unit runs (After=network-online.target), but wait briefly
# rather than fail instantly if that ordering ever doesn't hold in practice.
for _ in $(seq 1 30); do
  id "$TARGET_USER" &>/dev/null && break
  sleep 2
done
if ! id "$TARGET_USER" &>/dev/null; then
  echo "!! User $TARGET_USER still doesn't exist after 60s — aborting." >&2
  exit 1
fi

TARGET_HOME=$(eval echo "~$TARGET_USER")
APP_DIR="$TARGET_HOME/AtlasCompetitionManager"

echo "==> Installing git"
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y git

echo "==> Cloning $REPO_URL"
sudo -u "$TARGET_USER" git clone "$REPO_URL" "$APP_DIR"
cd "$APP_DIR"

echo "==> Running install.sh (app, packages, DB, PM2/systemd service, admin account)"
SUDO_USER="$TARGET_USER" bash install.sh

# install.sh's own hostname step only runs interactively ([[ -t 0 ]]) — always
# false here (a systemd unit has no tty) — so it's skipped there by design.
# Set it explicitly instead: rpi-imager's OS Customisation would normally have
# done this, but that dialog is confirmed broken on the current default OS
# release (see docs/pi-image-quickstart.md), so nothing else in this flow sets
# it. TLS certs are hardcoded to openpiste.local regardless of the live
# hostname (generate-tls-cert.sh), so ordering relative to that step doesn't
# matter — this only needs to run before "done" is printed at the end.
echo "==> Setting hostname to openpiste"
bash scripts/set-hostname.sh --yes

echo "==> Provisioning MQTT broker + local NTP server"
bash scripts/provision-broker.sh --yes

echo "==> Generating local CA + server TLS certificate"
sudo -u "$TARGET_USER" bash scripts/generate-tls-cert.sh

echo "==> Installing the TLS certificate into the broker (listeners 8883/9002)"
bash scripts/install-broker-cert.sh

echo "==> Issuing Atlas's own Tier A client certificate"
sudo -u "$TARGET_USER" bash scripts/provision-cms-client-cert.sh

echo "==> Syncing broker ACLs (Tier B credential pool + Tier A devices)"
bash scripts/sync-mosquitto-scoresheet-acl.sh

echo "==> Refreshing the Tier A CRL (unprivileged half — correct data/tls/ ownership)"
sudo -u "$TARGET_USER" node -e "
  const Provisioning = require('$APP_DIR/services/provisioning');
  Provisioning.pruneExpiredRevocations();
  Provisioning.refreshCrl();
"

echo "==> Pushing the CRL and enforcing Tier A certificates on listener 8883"
bash scripts/push-tier-a-crl.sh

echo "==> Restarting Atlas so it picks up its new mTLS client certificate"
# install.sh's own `loginctl enable-linger` (added 2026-09-03) is the real fix
# for the PM2 daemon dying between install.sh's PM2 setup and here — but fall
# back to a fresh start rather than fail the whole run if `restart` still
# can't find it for any other reason (belt-and-braces, not a substitute for
# the actual fix).
sudo -u "$TARGET_USER" pm2 restart atlas \
  || sudo -u "$TARGET_USER" pm2 start "$APP_DIR/server.js" --name atlas --cwd "$APP_DIR"
sudo -u "$TARGET_USER" pm2 save

touch /opt/.atlas-firstboot-done
systemctl disable atlas-firstboot.service || true

echo "=== Atlas first-boot provisioning finished: $(date) ==="
echo "Browse to https://openpiste.local:3001 (or http:// port 3001 before this device"
echo "has trusted the CA — see /install-cert.html)."
echo "Admin PIN was printed above by install.sh — search this log for 'ADMIN CREDENTIALS'"
echo "if you missed it: sudo grep -A5 'ADMIN CREDENTIALS' /var/log/atlas-firstboot.log"
