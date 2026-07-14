#!/usr/bin/env bash
# install-broker-cert.sh — install Atlas's local CA + server certificate into
# Mosquitto's TLS listeners (8883, 9002), so the broker and the CMS share one
# trust root instead of two separate ones.
#
# Run this on whichever machine actually runs the broker. If that's the same
# machine as Atlas, data/tls/ is already right here. If the broker runs on
# separate hardware, copy data/tls/{ca.crt,server.crt,server.key} there first
# (scp, USB, whatever's practical), then run this script on that machine —
# it doesn't care which case it's in.
#
# Usage:
#   ./scripts/install-broker-cert.sh
#
# Expects data/tls/{ca.crt,server.crt,server.key} to already exist — generated
# by ./scripts/generate-tls-cert.sh.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLS_DIR="$DIR/data/tls"
MOSQ_CERTS="/etc/mosquitto/certs"

for f in ca.crt server.crt server.key; do
  if [[ ! -f "$TLS_DIR/$f" ]]; then
    echo "Missing $TLS_DIR/$f" >&2
    echo "Run ./scripts/generate-tls-cert.sh first (here, or on whichever" >&2
    echo "machine generated it, then copy data/tls/ to this machine)." >&2
    exit 1
  fi
done

echo "Installing certificate into $MOSQ_CERTS (needs sudo)..."
sudo install -o root -g mosquitto -m 640 "$TLS_DIR/ca.crt"     "$MOSQ_CERTS/ca.crt"
sudo install -o root -g mosquitto -m 640 "$TLS_DIR/server.crt" "$MOSQ_CERTS/server.crt"
sudo install -o root -g mosquitto -m 640 "$TLS_DIR/server.key" "$MOSQ_CERTS/server.key"

echo "Restarting mosquitto..."
sudo systemctl restart mosquitto

echo ""
echo "Done. Verify the broker is now presenting Atlas's CA:"
echo "  echo | openssl s_client -connect localhost:9002 -servername openpiste.local 2>/dev/null | openssl x509 -noout -issuer"
echo "Expected issuer: CN = Atlas Local CA"
