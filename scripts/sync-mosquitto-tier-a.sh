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
#
# 2026-08-24: step 2/3's privileged commands (CRL push, conf rewrite, restart) moved
# to scripts/push-tier-a-crl.sh, called at the end of this script — split out so the
# CMS's own admin.html "Refresh CRL now" button can grant passwordless sudo on just
# that privileged tail without also elevating step 1's unprivileged CRL regeneration
# (which must keep running as the same unprivileged user that owns data/tls/, or a
# sudo'd whole-script run would leave those files root-owned — see
# services/provisioning.js's pushCrlToBroker() and push-tier-a-crl.sh's own header).
# No behavior change for this script's own plain/manual invocation.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TLS_DIR="$DIR/data/tls"

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

"$DIR/scripts/push-tier-a-crl.sh"

echo "A connection without a valid, unrevoked certificate should now be refused on 8883:"
echo "  openssl s_client -connect localhost:8883 -CAfile $TLS_DIR/ca.crt </dev/null"
