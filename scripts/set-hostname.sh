#!/usr/bin/env bash
# set-hostname.sh — explicitly ask before setting this machine's hostname to
# "openpiste". CLAUDE.md's TLS/OPP2 design assumes devices reach this server as
# openpiste.local via mDNS (avahi-daemon advertises <hostname>.local automatically
# once the hostname is set). Backs up whatever the hostname was before changing
# anything, so restore-hostname.sh can put it back later.
#
# Called automatically (still interactively — skipped if stdin isn't a terminal) by
# install.sh; also safe to run any time standalone, e.g. if you skipped it during
# install, or want to point an already-running deployment at openpiste.local.
#
# Idempotent: does nothing if the hostname is already "openpiste", and never
# overwrites an existing backup — that file is the ONE true original hostname, and a
# second run (say, after a previous run already renamed this machine) must not
# clobber it with "openpiste".
#
# Usage:
#   ./scripts/set-hostname.sh
#   ./scripts/set-hostname.sh --yes   # skip the confirmation prompt (scripted/first-boot callers with no tty)

set -euo pipefail

ASSUME_YES=0
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  ASSUME_YES=1
fi

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTNAME_BACKUP="$DIR/data/hostname.backup"
CURRENT="$(hostname)"

if [[ "$CURRENT" == "openpiste" ]]; then
  echo "Hostname is already 'openpiste' — nothing to do."
  exit 0
fi

echo "Atlas's OPP2 design (CLAUDE.md) assumes this device is reachable as"
echo "openpiste.local via mDNS. Current hostname: '$CURRENT'."
if [[ "$ASSUME_YES" == 1 ]]; then
  ANSWER=y
else
  read -r -p "Set this machine's hostname to 'openpiste' now? [y/N] " ANSWER
fi
if [[ "$ANSWER" != "y" && "$ANSWER" != "Y" ]]; then
  echo "Leaving hostname as '$CURRENT'. OPP2 features that assume openpiste.local"
  echo "(TLS certs, broker mDNS discovery) may need manual reconfiguration without it."
  exit 0
fi

mkdir -p "$DIR/data"
if [[ ! -f "$HOSTNAME_BACKUP" ]]; then
  echo "$CURRENT" > "$HOSTNAME_BACKUP"
  [[ -n "${SUDO_USER:-}" ]] && chown "$SUDO_USER":"$SUDO_USER" "$HOSTNAME_BACKUP" 2>/dev/null || true
  echo "Backed up original hostname ('$CURRENT') to $HOSTNAME_BACKUP"
else
  echo "Backup already exists at $HOSTNAME_BACKUP (from an earlier run) — leaving it"
  echo "as the original hostname of record, not overwriting with '$CURRENT'."
fi

echo "Setting hostname to 'openpiste' (needs sudo)..."
sudo hostnamectl set-hostname openpiste
if grep -q "^127.0.1.1" /etc/hosts; then
  sudo sed -i "s/^127.0.1.1.*/127.0.1.1\topenpiste/" /etc/hosts
else
  echo -e "127.0.1.1\topenpiste" | sudo tee -a /etc/hosts >/dev/null
fi

if command -v systemctl &>/dev/null && systemctl is-active --quiet avahi-daemon 2>/dev/null; then
  echo "Restarting avahi-daemon so openpiste.local is advertised immediately..."
  sudo systemctl restart avahi-daemon
fi

echo ""
echo "Done. Hostname is now 'openpiste' — openpiste.local should resolve now."
echo "Run ./scripts/restore-hostname.sh any time to undo this."
