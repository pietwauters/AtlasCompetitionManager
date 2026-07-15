#!/usr/bin/env bash
# restore-failover-bundle.sh — take over from a failed primary server using a bundle
# from create-failover-bundle.sh. Run this ON THE STANDBY SERVER, which is assumed to
# already be fully provisioned (Atlas + Node + Mosquitto installed and configured with
# the same listener layout as the primary — 1883/8883/9001/9002) and just idle, per
# the "quick failover mid-competition" use case: there is no time for a from-scratch
# install.sh run during a live event.
#
# What this does, in order:
#   1. Extracts the bundle (prompts for the password used to create it).
#   2. Backs up this server's OWN current data/atlas.db and data/tls/ first (reversible
#      — if something's wrong, you can put them back) — same pattern as every other
#      sudo-gated config change in this project's scripts.
#   3. Stops Atlas (best-effort — fine if it wasn't running, e.g. a cold standby).
#   4. Overwrites data/atlas.db and data/tls/ with the bundle's contents.
#   5. If Mosquitto is on this same host, re-establishes broker trust/ACL/CRL from the
#      now-restored files: install-broker-cert.sh (push ca/server certs so the broker
#      presents exactly what already-paired devices already trust), then
#      sync-mosquitto-scoresheet-acl.sh and sync-mosquitto-tier-a.sh (regenerate
#      ACL/passwd/CRL from the restored DB — see create-failover-bundle.sh's header for
#      why these are regenerated rather than bundled directly).
#   6. Restarts Atlas.
#
# Usage:
#   ./scripts/restore-failover-bundle.sh <bundle.7z>
#
# Not handled here, deliberately out of scope: making devices actually find this
# server. If it advertises the same openpiste.local mDNS name as the primary (the
# usual setup — see CLAUDE.md's TLS section), already-paired devices should reconnect
# on their own once the primary is offline; if not, that's a network-layer step this
# script can't perform for you.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DATA_DIR="$DIR/data"
BUNDLE="${1:-}"

if [[ -z "$BUNDLE" || ! -f "$BUNDLE" ]]; then
  echo "Usage: $0 <bundle.7z>" >&2
  exit 1
fi

if ! command -v 7z &>/dev/null; then
  echo "7z not found — install it first: sudo apt-get install -y p7zip-full" >&2
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Extracting $BUNDLE (enter the password it was created with)..."
7z x -y "-o$TMPDIR" "$BUNDLE" >/dev/null

if [[ ! -f "$TMPDIR/atlas.db" || ! -f "$TMPDIR/tls/ca.key" ]]; then
  echo "Extracted bundle is missing atlas.db or tls/ca.key — not a valid bundle, or" >&2
  echo "wrong password. Nothing has been touched." >&2
  exit 1
fi

if [[ -f "$TMPDIR/manifest.txt" ]]; then
  echo ""
  echo "Bundle info:"
  sed 's/^/  /' "$TMPDIR/manifest.txt"
  echo ""
fi

read -r -p "This will overwrite this server's data/atlas.db and data/tls/. Continue? [y/N] " CONFIRM
if [[ "$CONFIRM" != "y" && "$CONFIRM" != "Y" ]]; then
  echo "Aborted — nothing was touched."
  exit 1
fi

STAMP=$(date +%Y%m%d%H%M%S)
if [[ -f "$DATA_DIR/atlas.db" ]]; then
  echo "Backing up this server's own current data/atlas.db -> atlas.db.bak-$STAMP"
  cp -a "$DATA_DIR/atlas.db" "$DATA_DIR/atlas.db.bak-$STAMP"
fi
if [[ -d "$DATA_DIR/tls" ]]; then
  echo "Backing up this server's own current data/tls/ -> tls.bak-$STAMP"
  cp -a "$DATA_DIR/tls" "$DATA_DIR/tls.bak-$STAMP"
fi

echo "Stopping Atlas (if running under pm2 here)..."
command -v pm2 &>/dev/null && pm2 stop atlas 2>/dev/null || true

echo "Installing restored data/atlas.db and data/tls/..."
rm -f "$DATA_DIR/atlas.db" "$DATA_DIR/atlas.db-wal" "$DATA_DIR/atlas.db-shm"
cp -a "$TMPDIR/atlas.db" "$DATA_DIR/atlas.db"
rm -rf "$DATA_DIR/tls"
cp -a "$TMPDIR/tls" "$DATA_DIR/tls"
chmod 600 "$DATA_DIR/tls/ca.key" "$DATA_DIR/tls/server.key" 2>/dev/null || true
chmod 600 "$DATA_DIR/tls/software-client.key" 2>/dev/null || true

if command -v mosquitto &>/dev/null; then
  echo ""
  echo "==> Re-establishing broker trust/ACL/CRL from the restored files"
  bash "$DIR/scripts/install-broker-cert.sh"
  bash "$DIR/scripts/sync-mosquitto-scoresheet-acl.sh"
  bash "$DIR/scripts/sync-mosquitto-tier-a.sh"
else
  echo ""
  echo "  !! Mosquitto not found on this host — if the broker runs on separate"
  echo "     hardware, copy data/tls/ there and run install-broker-cert.sh,"
  echo "     sync-mosquitto-scoresheet-acl.sh, and sync-mosquitto-tier-a.sh there too."
fi

echo ""
echo "Restarting Atlas..."
if command -v pm2 &>/dev/null; then
  pm2 restart atlas 2>/dev/null || pm2 start "$DIR/server.js" --name atlas
else
  echo "  pm2 not found — start Atlas manually: cd $DIR && node server.js"
fi

echo ""
echo "Done. This server is now carrying the restored competition state as of the"
echo "backup's creation time (see manifest above). Pre-restore data was kept at"
echo "data/atlas.db.bak-$STAMP and data/tls.bak-$STAMP in case anything looks wrong."
