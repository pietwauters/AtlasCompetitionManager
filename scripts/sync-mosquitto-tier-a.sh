#!/usr/bin/env bash
# sync-mosquitto-tier-a.sh — the broker-listener half of Tier A provisioning
# (docs/level2.md §30.5), separate from scripts/sync-mosquitto-scoresheet-acl.sh
# because it edits a different file (mosquitto.conf's listener 8883 block) with no
# overlap/clobber risk between the two scripts.
#
# Does three things, all idempotent (safe to re-run):
#   1. Prunes revoked certificates whose own original validity period has already
#      passed — a revoked entry only needs to stay on the CRL until then anyway
#      (past that point the TLS handshake already rejects it for being expired,
#      CRL or not), so keeping it any longer is unbounded growth with no security
#      benefit. See docs/implementation-notes/mosquitto-security.md's
#      revocation-scaling note. This is the natural place for it, not a separate
#      script, since it's already the thing you re-run after every revocation.
#   2. One-time listener config on 8883 (TLS, already exists): flips
#      require_certificate false -> true, adds use_identity_as_username true (so a
#      cert's CN becomes the ACL username — see sync-mosquitto-scoresheet-acl.sh's
#      per-device "user <CN>" stanzas) and crlfile (so a revoked certificate is
#      rejected at the TLS handshake). 9001/9002 (Tier B/anonymous) are untouched —
#      Tier A is additive on its own already-existing listener, not a breaking change.
#   3. Pushes the current (now-pruned) data/tls/ca.crl to the broker. Run this
#      again any time after services/provisioning.js's revokeCertificate
#      regenerates the CRL — same "revoke is logical in Atlas's DB until this runs"
#      two-step shape as Tier B (see scripts/sync-mosquitto-scoresheet-acl.sh's own
#      revoke note).
#
# Usage:
#   ./scripts/sync-mosquitto-tier-a.sh
#
# Expects data/tls/ca.crt to exist (scripts/generate-tls-cert.sh) and, once at least
# one device has been provisioned, data/tls/ca.crl (services/provisioning.js creates
# it lazily on first issuance/revocation — an empty/no-revocations CRL is fine).

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLS_DIR="$DIR/data/tls"
MOSQ_CONF="/etc/mosquitto/mosquitto.conf"
MOSQ_CERTS="/etc/mosquitto/certs"

if [[ ! -f "$TLS_DIR/ca.crt" ]]; then
  echo "Missing $TLS_DIR/ca.crt — run ./scripts/generate-tls-cert.sh first." >&2
  exit 1
fi

echo "Pruning revoked certificates past their own expiry (Atlas-DB only, no sudo)..."
PRUNED=$(node -e "
  const Provisioning = require('$DIR/services/provisioning');
  const result = Provisioning.pruneExpiredRevocations();
  console.log(result.pruned);
")
echo "  Pruned $PRUNED entr$([ "$PRUNED" = 1 ] && echo y || echo ies) no longer needed on the CRL."

echo "Refreshing CRL Last/Next Update (Atlas-DB only, no sudo)..."
node -e "require('$DIR/services/provisioning').refreshCrl();"
# Unconditional, even if nothing was pruned above — the CRL's nextUpdate window
# only resets on regeneration. Running this script periodically is what's
# supposed to keep the deployed CRL from ever going stale; if regeneration only
# happened when there was something new to revoke, a quiet period would let the
# nextUpdate clock run out anyway. See CRL_VALIDITY_DAYS's comment in
# services/provisioning.js.

echo "Pushing CRL to $MOSQ_CERTS (needs sudo)..."
if [[ -f "$TLS_DIR/ca.crl" ]]; then
  sudo install -o root -g mosquitto -m 640 "$TLS_DIR/ca.crl" "$MOSQ_CERTS/ca.crl"
else
  echo "  No $TLS_DIR/ca.crl yet (no device provisioned/revoked so far) —"
  echo "  generating an empty one so crlfile has something valid to load."
  TMP_CRL_CONF=$(mktemp)
  TMP_CRL=$(mktemp)
  cat > "$TMP_CRL_CONF" <<EOF
[ca]
default_ca = tier_a_ca
[tier_a_ca]
database = /dev/null
certificate = $TLS_DIR/ca.crt
private_key = $TLS_DIR/ca.key
crlnumber = /dev/stdin
default_md = sha256
default_crl_days = 180
EOF
  echo "1000" | openssl ca -config "$TMP_CRL_CONF" -gencrl -out "$TMP_CRL"
  sudo install -o root -g mosquitto -m 640 "$TMP_CRL" "$MOSQ_CERTS/ca.crl"
  rm -f "$TMP_CRL_CONF" "$TMP_CRL"
fi

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
echo "A connection without a valid, unrevoked certificate should now be refused on 8883:"
echo "  openssl s_client -connect localhost:8883 -CAfile $TLS_DIR/ca.crt </dev/null"
