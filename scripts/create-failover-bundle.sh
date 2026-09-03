#!/usr/bin/env bash
# create-failover-bundle.sh — bundle everything a standby server needs to take over
# mid-competition if this one fails: the competition database and the entire local
# TLS trust root.
#
# Deliberately does NOT bundle Mosquitto's own acl.conf/passwd/mosquitto.conf — those
# are fully regenerable from data/atlas.db + data/tls/ via the scripts this project
# already has (sync-mosquitto-scoresheet-acl.sh, sync-mosquitto-tier-a.sh,
# install-broker-cert.sh), and restore-failover-bundle.sh calls them for exactly that
# reason. Snapshotting Mosquitto's config as a *second*, independently-captured thing
# risks it silently drifting from the DB it's derived from; regenerating avoids that
# by construction.
#
# What's in the bundle:
#   atlas.db   — a live, consistent snapshot via `sqlite3 .backup` (safe to run while
#                the server is up; does not lock out writers the way a raw `cp` of a
#                WAL-mode database file could).
#   tls/       — the *entire* data/tls/ directory verbatim: ca.key, ca.crt, ca.crl,
#                server.key/crt, software-client.key/crt, and ca-db/ (OpenSSL's CA
#                bookkeeping — index.txt/serial/crlnumber). Copying this wholesale,
#                rather than reissuing certs on the standby, is what lets every
#                already-paired device (apparatus, e-scoresheets) keep trusting the
#                standby with zero re-pairing. ca-db/ specifically must come along too
#                — without it, certificate serial numbers and revocation history would
#                reset, which is wrong even though tier_a_certificates.revoked_at in
#                the DB still remembers the fact of each revocation.
#   manifest.txt — created_at/hostname/git commit, so restore-failover-bundle.sh (and
#                a human) can sanity-check which bundle they're about to restore.
#
# data/tls/ca.key is the trust root for the entire OPP2 ecosystem at this venue —
# anyone holding it can mint a valid certificate for anything. The archive is
# encrypted (AES-256, encrypted filenames too) for exactly that reason: treat this
# file with the same care as the key itself once it exists — don't email it, don't
# leave it on an unencrypted USB stick, delete it once the standby has it.
#
# Usage:
#   ./scripts/create-failover-bundle.sh [output-path.7z]
#   (defaults to ./atlas-failover-<timestamp>.7z in the current directory)
#
# You will be prompted twice for a password (entry + confirmation) — same password is
# needed on the other end for restore-failover-bundle.sh.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DB_PATH="$DIR/data/atlas.db"
TLS_DIR="$DIR/data/tls"
OUTPUT="${1:-atlas-failover-$(date +%Y%m%d-%H%M%S).7z}"

if ! command -v 7z &>/dev/null; then
  echo "7z not found — install it first: sudo apt-get install -y p7zip-full" >&2
  echo "(needed for AES-256 archive encryption — plain 'zip -e' uses a weak, easily" >&2
  echo "crackable cipher, not appropriate for a bundle containing a CA private key.)" >&2
  exit 1
fi

if ! command -v sqlite3 &>/dev/null; then
  echo "sqlite3 not found — install it first: sudo apt-get install -y sqlite3" >&2
  echo "(needed for the live '.backup' snapshot — install.sh no longer installs" >&2
  echo "this by default, since better-sqlite3 the npm package doesn't need it.)" >&2
  exit 1
fi

if [[ ! -f "$DB_PATH" ]]; then
  echo "Missing $DB_PATH — nothing to back up." >&2
  exit 1
fi
if [[ ! -f "$TLS_DIR/ca.key" ]]; then
  echo "Missing $TLS_DIR/ca.key — run ./scripts/generate-tls-cert.sh first." >&2
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

echo "Snapshotting data/atlas.db (live, consistent — safe while the server is running)..."
sqlite3 "$DB_PATH" ".backup '$TMPDIR/atlas.db'"

echo "Copying data/tls/ (CA + all issued certificates)..."
cp -a "$TLS_DIR" "$TMPDIR/tls"

cat > "$TMPDIR/manifest.txt" <<EOF
Atlas failover bundle
created_at: $(date -u +%Y-%m-%dT%H:%M:%SZ)
source_host: $(hostname)
git_commit: $(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo "unknown")
EOF

echo "Creating encrypted archive (AES-256, encrypted filenames) — you'll be asked for"
echo "a password twice; the standby will need the same password to restore it:"
7z a -p -mhe=on -mx=5 "$OUTPUT" "$TMPDIR"/atlas.db "$TMPDIR"/tls "$TMPDIR"/manifest.txt >/dev/null

echo ""
echo "Done: $OUTPUT"
echo ""
echo "Get this onto the standby server (scp, USB — whatever's practical during a live"
echo "competition), then on the standby run:"
echo "  ./scripts/restore-failover-bundle.sh $(basename "$OUTPUT")"
echo ""
echo "Delete $OUTPUT from this machine and any transfer media once the standby has it"
echo "and you've confirmed the restore worked — it contains the CA private key."
