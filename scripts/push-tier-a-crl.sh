#!/usr/bin/env bash
# push-tier-a-crl.sh — the privileged tail of Tier A CRL sync, split out of
# sync-mosquitto-tier-a.sh (2026-08-24) so it can be granted passwordless sudo on
# its own without also elevating the unprivileged CRL-regeneration step.
#
# Split rationale: sync-mosquitto-tier-a.sh's first two steps
# (Provisioning.pruneExpiredRevocations/refreshCrl) write data/tls/ca.crl as
# whatever user runs them — normally the same unprivileged user the Atlas server
# itself runs as. If a browser-triggered "refresh CRL" button ran that whole
# script under `sudo`, those two steps would run as root too and leave
# data/tls/ca.crl (and the ca-db/ index it's derived from) root-owned, breaking
# every future non-sudo write by the Atlas process. This script never touches
# data/tls/ for writing — only reads ca.crl to copy it into /etc/mosquitto/certs
# — so it's safe to grant NOPASSWD sudo on the whole file: services/provisioning.js
# calls Provisioning.refreshCrl() in-process (correct ownership) *before* invoking
# this script for the privileged remainder.
#
# Expects data/tls/ca.crl to already exist and be current — run
# Provisioning.refreshCrl() (or the still-unprivileged first half of
# sync-mosquitto-tier-a.sh) immediately before this, not after.
#
# Usage: ./scripts/push-tier-a-crl.sh
# (Runs fine plain — each privileged line below prompts for a password as
# needed, same as before the split. Runs fine under `sudo` too — root re-running
# `sudo` for its own commands is a no-op via pam_rootok, so no behavior change
# either way.)

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLS_DIR="$DIR/data/tls"
MOSQ_CONF="/etc/mosquitto/mosquitto.conf"
MOSQ_CERTS="/etc/mosquitto/certs"

if [[ ! -f "$TLS_DIR/ca.crl" ]]; then
  echo "Missing $TLS_DIR/ca.crl — run Provisioning.refreshCrl() (or sync-mosquitto-tier-a.sh) first." >&2
  exit 1
fi

echo "Pushing CRL to $MOSQ_CERTS (needs sudo)..."
sudo install -o root -g mosquitto -m 640 "$TLS_DIR/ca.crl" "$MOSQ_CERTS/ca.crl"

echo "Backing up $MOSQ_CONF..."
sudo cp -a "$MOSQ_CONF" "$MOSQ_CONF.bak-tier-a-$(date +%Y%m%d%H%M%S)"

echo "Updating listener 8883's config (require_certificate, use_identity_as_username, crlfile)..."
# mosquitto.conf is root:root 644 — readable directly, but writing needs sudo. Edit a
# user-writable copy, then push it back into place.
TMP_CONF=$(mktemp)
cp "$MOSQ_CONF" "$TMP_CONF"

python3 - "$TMP_CONF" "$MOSQ_CERTS/ca.crl" <<'PYEOF'
import sys

conf_path, crl_path = sys.argv[1], sys.argv[2]
with open(conf_path) as f:
    lines = f.readlines()

KEYS = ("require_certificate", "use_identity_as_username", "crlfile")

def replacement(key):
    if key == "require_certificate":
        return "require_certificate true\n"
    if key == "use_identity_as_username":
        return "use_identity_as_username true\n"
    return f"crlfile {crl_path}\n"

out = []
in_8883 = False
touched = {k: False for k in KEYS}

def flush_missing():
    for key, present in touched.items():
        if not present:
            out.append(replacement(key))

for line in lines:
    stripped = line.strip()

    if stripped.startswith("listener "):
        if in_8883:
            flush_missing()
        in_8883 = (stripped == "listener 8883")
        touched = {k: False for k in KEYS}
        out.append(line)
        continue

    matched_key = next((k for k in KEYS if in_8883 and stripped.startswith(k)), None)
    if matched_key:
        out.append(replacement(matched_key))
        touched[matched_key] = True
        continue

    out.append(line)

if in_8883:
    flush_missing()

with open(conf_path, "w") as f:
    f.writelines(out)

print("Listener 8883 config updated.")
PYEOF

sudo install -o root -g root -m 644 "$TMP_CONF" "$MOSQ_CONF"
rm -f "$TMP_CONF"

echo "Restarting mosquitto..."
sudo systemctl restart mosquitto

echo ""
echo "Done. Verify with:"
echo "  sudo grep -A7 'listener 8883' $MOSQ_CONF"
