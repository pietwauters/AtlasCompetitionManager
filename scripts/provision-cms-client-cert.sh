#!/usr/bin/env bash
# provision-cms-client-cert.sh — issue Atlas's own Tier A client certificate
# (docs/level2.md §30.5), so the CMS itself authenticates to the broker via mTLS
# instead of connecting anonymously.
#
# Why this matters: today lib/opp2Transport.js connects anonymously and relies on
# the backward-compat anonymous `topic write openpiste/+/software/#` ACL grant —
# which also means any other anonymous client on the network can spoof software/*
# messages the apparatus is spec-required to trust unconditionally (e.g.
# software/clock's running:false invariant). Unlike every other Tier A device, the
# CMS doesn't need the ticket/MQTT request-response exchange at all: it already
# holds the CA's own private key locally (data/tls/ca.key), so keypair generation,
# CSR, and signing all happen in one local step here.
#
# What this script does NOT do: it does not remove the anonymous software/#
# fallback, and it does not touch the broker at all. That's deliberate — this is
# additive only:
#   1. This script issues the cert (data/tls/software-client.{key,crt}) and records
#      it in tier_a_certificates (role=software, device_id=cms).
#   2. Restart Atlas (`node server.js`) — lib/opp2Transport.js detects the new
#      cert files automatically and switches to mTLS on 8883. If listener 8883
#      doesn't yet require a client certificate (./scripts/sync-mosquitto-tier-a.sh
#      hasn't been run), the broker will simply also accept it as any other TLS
#      client — no functional change until step 3.
#   3. Run ./scripts/sync-mosquitto-scoresheet-acl.sh to push the new
#      `user software-cms` ACL stanza, and ./scripts/sync-mosquitto-tier-a.sh if
#      listener 8883 doesn't already require a client certificate.
#   4. Once you've confirmed Atlas reconnects cleanly over mTLS (check the server
#      log for "(mTLS, cert CN software-cms)"), you can choose to remove the
#      anonymous `topic write openpiste/+/software/#` line from
#      sync-mosquitto-scoresheet-acl.sh's generated block to close the spoofing
#      gap — a separate, deliberate step, not done automatically here or by any
#      other script, since it changes what already-anonymous installs can do.
#
# Usage:
#   ./scripts/provision-cms-client-cert.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ ! -f "$DIR/data/tls/ca.key" || ! -f "$DIR/data/tls/ca.crt" ]]; then
  echo "Missing $DIR/data/tls/ca.{key,crt} — run ./scripts/generate-tls-cert.sh first." >&2
  exit 1
fi

echo "Issuing Atlas's own Tier A client certificate (CN=software-cms)..."
node -e "
  const Provisioning = require('$DIR/services/provisioning');
  const { serial } = Provisioning.issueCmsCertificate();
  console.log('  Issued, serial ' + serial + '.');
  console.log('  Written to $DIR/data/tls/software-client.{key,crt}.');
"

echo ""
echo "Done. Next steps:"
echo "  1. Restart Atlas (node server.js) — it will pick up the new certificate"
echo "     automatically and connect via mTLS on 8883."
echo "  2. ./scripts/sync-mosquitto-scoresheet-acl.sh — pushes the 'user software-cms'"
echo "     ACL stanza so the broker actually grants it software/# write access."
echo "  3. If listener 8883 doesn't yet require a client certificate, also run"
echo "     ./scripts/sync-mosquitto-tier-a.sh."
echo "  4. Verify the server log shows '(mTLS, cert CN software-cms)' on connect."
