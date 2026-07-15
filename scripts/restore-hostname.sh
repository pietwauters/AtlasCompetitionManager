#!/usr/bin/env bash
# restore-hostname.sh — undo scripts/set-hostname.sh (or install.sh's interactive
# hostname step, which delegates to it): restores this machine's original hostname
# from the backup left at data/hostname.backup.
#
# If no backup is found — set-hostname.sh was never accepted on this machine, or the
# backup file has been lost/removed — asks interactively what hostname to set
# instead, rather than failing outright.
#
# Usage:
#   ./scripts/restore-hostname.sh

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOSTNAME_BACKUP="$DIR/data/hostname.backup"
CURRENT="$(hostname)"

if [[ -f "$HOSTNAME_BACKUP" ]]; then
  ORIGINAL="$(cat "$HOSTNAME_BACKUP")"
  echo "Found a backed-up original hostname: '$ORIGINAL' (current: '$CURRENT')."
  read -r -p "Restore hostname to '$ORIGINAL'? [y/N] " ANSWER
  if [[ "$ANSWER" != "y" && "$ANSWER" != "Y" ]]; then
    echo "Aborted — hostname left as '$CURRENT'."
    exit 0
  fi
  NEW="$ORIGINAL"
else
  echo "No hostname backup found at $HOSTNAME_BACKUP."
  echo "(Either scripts/set-hostname.sh was never run/accepted on this machine, or"
  echo "the backup has since been removed.)"
  read -r -p "What hostname should this machine use? [current: $CURRENT] " NEW
  NEW="${NEW:-$CURRENT}"
  if [[ "$NEW" == "$CURRENT" ]]; then
    echo "No change requested — leaving hostname as '$CURRENT'."
    exit 0
  fi
fi

echo "Setting hostname to '$NEW' (needs sudo)..."
sudo hostnamectl set-hostname "$NEW"
if grep -q "^127.0.1.1" /etc/hosts; then
  sudo sed -i "s/^127.0.1.1.*/127.0.1.1\t$NEW/" /etc/hosts
else
  echo -e "127.0.1.1\t$NEW" | sudo tee -a /etc/hosts >/dev/null
fi

if [[ -f "$HOSTNAME_BACKUP" ]]; then
  rm -f "$HOSTNAME_BACKUP"
  echo "Removed $HOSTNAME_BACKUP now that it's been restored — a future"
  echo "set-hostname.sh run will treat '$NEW' as the fresh original."
fi

echo ""
echo "Done. Hostname is now '$NEW'."
echo "A reboot, or at least 'sudo systemctl restart avahi-daemon', may be needed for"
echo "mDNS (.local) to fully pick up the change."
