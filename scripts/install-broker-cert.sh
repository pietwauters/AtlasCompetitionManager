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
MOSQ_CONF="/etc/mosquitto/mosquitto.conf"
MOSQ_CONF_D="/etc/mosquitto/conf.d"

for f in ca.crt server.crt server.key; do
  if [[ ! -f "$TLS_DIR/$f" ]]; then
    echo "Missing $TLS_DIR/$f" >&2
    echo "Run ./scripts/generate-tls-cert.sh first (here, or on whichever" >&2
    echo "machine generated it, then copy data/tls/ to this machine)." >&2
    exit 1
  fi
done

# Create the TLS listener stanzas (8883 mTLS-capable, 9002 wss) if they don't exist
# yet — a genuinely fresh Mosquitto install only has the plain listeners from
# scripts/provision-broker.sh (1883/9001). require_certificate stays false here;
# scripts/sync-mosquitto-tier-a.sh is what later flips it to true, once at least
# one Tier A certificate actually exists, by editing this same block. Idempotent —
# checks conf.d too, so it won't duplicate or fight an already-configured broker
# (like this project's own real deployment, which already has both).
has_listener() {
  grep -rhq "^listener $1\b" "$MOSQ_CONF" "$MOSQ_CONF_D"/*.conf 2>/dev/null
}
if ! has_listener 8883 || ! has_listener 9002; then
  STAMP=$(date +%Y%m%d%H%M%S)
  echo "Adding missing TLS listener stanza(s) to $MOSQ_CONF (backup: .bak-cert-$STAMP)..."
  sudo cp -a "$MOSQ_CONF" "$MOSQ_CONF.bak-cert-$STAMP"
  TMP=$(mktemp)
  sudo cp "$MOSQ_CONF" "$TMP"
  {
    if ! has_listener 8883; then
      echo ""
      echo "# Added by scripts/install-broker-cert.sh — mTLS-capable MQTT."
      echo "# require_certificate stays false until scripts/sync-mosquitto-tier-a.sh"
      echo "# flips it (once a Tier A certificate actually exists)."
      echo "listener 8883"
      echo "allow_anonymous true"
      echo "require_certificate false"
      echo "cafile $MOSQ_CERTS/ca.crt"
      echo "certfile $MOSQ_CERTS/server.crt"
      echo "keyfile $MOSQ_CERTS/server.key"
    fi
    if ! has_listener 9002; then
      echo ""
      echo "# Added by scripts/install-broker-cert.sh — wss, for browser clients"
      echo "# (the e-scoresheet PWA)."
      echo "listener 9002"
      echo "protocol websockets"
      echo "allow_anonymous true"
      echo "cafile $MOSQ_CERTS/ca.crt"
      echo "certfile $MOSQ_CERTS/server.crt"
      echo "keyfile $MOSQ_CERTS/server.key"
    fi
  } | sudo tee -a "$TMP" >/dev/null
  sudo install -o root -g root -m 644 "$TMP" "$MOSQ_CONF"
  rm -f "$TMP"
fi

# Normalize cafile/certfile/keyfile inside each TLS listener's own stanza to the
# canonical $MOSQ_CERTS paths below — not just skip listeners that already existed.
# A listener created fresh above already has the right paths, so this is a no-op for
# it; but a listener inherited from something other than this project (e.g. a prior
# mqtt-web setup) can reference a completely different cert path (found in practice:
# listener 9002 pointing at /etc/mosquitto/certs-web/server.cert), and installing new
# cert bytes at $MOSQ_CERTS/server.crt is silently pointless if nothing reads it from
# there. Rewrites only cafile/certfile/keyfile lines within a listener's own block
# (up to the next `listener` line or EOF) — every other directive (protocol,
# allow_anonymous, tls_version, require_certificate, ...) is left untouched. Portable
# awk (no GNU-only \y) since Raspberry Pi OS's default `awk` is mawk, not gawk.
normalize_listener_certs() {
  local port="$1" file
  file=$(grep -rl "^listener $port\b" "$MOSQ_CONF" "$MOSQ_CONF_D"/*.conf 2>/dev/null | head -1) || true
  if [[ -z "$file" ]]; then return 0; fi
  local tmp
  tmp=$(mktemp)
  awk -v port="$port" -v cafile="$MOSQ_CERTS/ca.crt" -v certfile="$MOSQ_CERTS/server.crt" -v keyfile="$MOSQ_CERTS/server.key" '
    BEGIN { in_block=0; had_cafile=0; had_certfile=0; had_keyfile=0 }
    function flush_missing() {
      if (!had_cafile)   print "cafile " cafile
      if (!had_certfile) print "certfile " certfile
      if (!had_keyfile)  print "keyfile " keyfile
    }
    {
      if ($0 ~ ("^listener " port "($|[ \t])")) {
        in_block = 1
        had_cafile = 0; had_certfile = 0; had_keyfile = 0
        print $0
        next
      }
      if (in_block && $0 ~ /^listener /) {
        flush_missing()
        in_block = 0
        print $0
        next
      }
      if (in_block && $0 ~ /^cafile /)   { print "cafile " cafile;     had_cafile = 1;   next }
      if (in_block && $0 ~ /^certfile /) { print "certfile " certfile; had_certfile = 1; next }
      if (in_block && $0 ~ /^keyfile /)  { print "keyfile " keyfile;   had_keyfile = 1;  next }
      print $0
    }
    END { if (in_block) flush_missing() }
  ' "$file" > "$tmp"
  if ! diff -q "$file" "$tmp" >/dev/null 2>&1; then
    STAMP=$(date +%Y%m%d%H%M%S)
    echo "Normalizing listener $port's cert paths in $file (backup: .bak-cert-$STAMP)..."
    sudo cp -a "$file" "$file.bak-cert-$STAMP"
    sudo install -o root -g root -m 644 "$tmp" "$file"
  fi
  rm -f "$tmp"
}
normalize_listener_certs 8883
normalize_listener_certs 9002

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
