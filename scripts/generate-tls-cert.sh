#!/usr/bin/env bash
# generate-tls-cert.sh — generate a local CA + server certificate for Atlas's
# HTTPS listener, bound to openpiste.local (mDNS) rather than an IP address,
# so it stays valid no matter what subnet/IP a venue's DHCP hands out.
#
# Usage:
#   ./scripts/generate-tls-cert.sh             # reuse the existing CA if there is one
#                                               #   (default — see below), reissue the leaf
#   ./scripts/generate-tls-cert.sh --rotate-ca # start a fresh CA (invalidates every
#                                               #   device that already trusted the old one)
#
# Defaulting to reuse, not rotation: every device that installs the CA root
# has to redo that one-time OS-level install/trust dance (no way to script
# around it — see docs/e-scoresheet-standalone-design.md §4.4) whenever the
# root changes. Rotating on every competition means paying that cost every
# single event, for every device, which is real friction on a competition
# day — not just a one-off. Reuse the same root across as many competitions
# as this installation runs; rotate deliberately (suspected key compromise,
# a new season, handing the installation to someone else) via --rotate-ca.
#
# Output (gitignored, under data/tls/):
#   ca.key, ca.crt          — the root CA. ca.crt is what gets installed/trusted
#                             on a paired device; ca.key never leaves this machine.
#   server.key, server.crt  — Atlas's HTTPS leaf certificate, signed by the CA.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLS_DIR="$DIR/data/tls"
mkdir -p "$TLS_DIR"

DAYS_CA=825
DAYS_LEAF=825

if [[ "${1:-}" != "--rotate-ca" && -f "$TLS_DIR/ca.key" && -f "$TLS_DIR/ca.crt" ]]; then
  echo "Reusing existing CA at $TLS_DIR/ca.{key,crt} (use --rotate-ca to start fresh)"
else
  echo "Generating a fresh local CA..."
  openssl req -x509 -new -nodes \
    -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
    -keyout "$TLS_DIR/ca.key" -out "$TLS_DIR/ca.crt" \
    -days "$DAYS_CA" \
    -subj "/O=OpenPiste/CN=Atlas Local CA" \
    -addext "basicConstraints=critical,CA:true" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 600 "$TLS_DIR/ca.key"
fi

echo "Issuing server certificate for openpiste.local..."
openssl req -new -nodes \
  -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 \
  -keyout "$TLS_DIR/server.key" -out "$TLS_DIR/server.csr" \
  -subj "/O=OpenPiste/CN=openpiste.local"

cat > "$TLS_DIR/server.ext" <<EOF
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:openpiste.local,DNS:localhost,IP:127.0.0.1
EOF

openssl x509 -req \
  -in "$TLS_DIR/server.csr" \
  -CA "$TLS_DIR/ca.crt" -CAkey "$TLS_DIR/ca.key" -CAcreateserial \
  -out "$TLS_DIR/server.crt" -days "$DAYS_LEAF" \
  -extfile "$TLS_DIR/server.ext"

rm -f "$TLS_DIR/server.csr" "$TLS_DIR/server.ext"
chmod 600 "$TLS_DIR/server.key"

echo ""
echo "Done. Files in $TLS_DIR:"
ls "$TLS_DIR"
echo ""
echo "Restart the server to pick it up: node server.js"
echo "To trust this CA on a device (removes the browser warning), install: $TLS_DIR/ca.crt"
echo "(new device onboarding page: http://openpiste.local:\${PORT:-3001}/install-cert.html)"
echo ""
echo "If you just rotated the CA (--rotate-ca), also re-run"
echo "./scripts/install-broker-cert.sh so the broker's certificate matches again —"
echo "otherwise it'll still be presenting a leaf signed by the old, now-replaced root."
