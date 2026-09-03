#!/usr/bin/env bash
# prepare-pi-firstboot.sh — run on THIS machine (not the Pi), after flashing
# Raspberry Pi OS Lite with rpi-imager and mounting the freshly-written
# device's root (ext4) partition somewhere on this machine.
#
# Drops in a systemd unit that clones and fully provisions Atlas — app,
# MQTT broker, local NTP server, and the complete Tier A mTLS authentication
# chain — unattended on the Pi's first real boot. See
# docs/pi-image-quickstart.md for the full flow and what to expect.
#
# Deliberately does NOT touch the block device itself, partition it, or write
# the OS image — that's rpi-imager's job, done through its own GUI and its own
# device picker. This script only writes two small files into an
# already-existing filesystem that you point it at explicitly.
#
# Usage:
#   ./scripts/prepare-pi-firstboot.sh <root-mountpoint> <target-username>
#
# <root-mountpoint>  where you mounted the Pi's root (ext4, NOT the small FAT32
#                    boot partition) partition on this machine, e.g. /media/you/rootfs
# <target-username>  the username you set in rpi-imager's OS Customisation —
#                    must match exactly, or the first-boot service will wait
#                    60s for a user that never appears and give up.

set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <root-mountpoint> <target-username>" >&2
  exit 1
fi

ROOT_MNT="$1"
TARGET_USER="$2"
DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# ---------------------------------------------------------------------------
# Refuse to proceed unless this really looks like a Raspberry Pi OS root —
# never guess, never touch an arbitrary path.
# ---------------------------------------------------------------------------
if [[ ! -d "$ROOT_MNT" ]]; then
  echo "!! $ROOT_MNT is not a directory." >&2
  exit 1
fi
if [[ ! -e "$ROOT_MNT/etc/rpi-issue" && ! -d "$ROOT_MNT/boot/firmware" ]]; then
  echo "!! $ROOT_MNT doesn't look like a Raspberry Pi OS root filesystem" >&2
  echo "   (expected etc/rpi-issue or boot/firmware under it). Refusing to proceed." >&2
  echo "   Make sure you mounted the ext4 root partition, not the small FAT32 boot one." >&2
  exit 1
fi
if [[ ! -d "$ROOT_MNT/etc/systemd/system" ]]; then
  echo "!! $ROOT_MNT/etc/systemd/system doesn't exist — refusing to proceed." >&2
  exit 1
fi

echo "==> Target: $ROOT_MNT (user: $TARGET_USER)"

# ---------------------------------------------------------------------------
# Write atlas-firstboot.sh, substituting the real username in for the
# placeholder this repo's copy ships with.
# ---------------------------------------------------------------------------
echo "==> Writing opt/atlas-firstboot.sh"
sudo mkdir -p "$ROOT_MNT/opt"
sed "s/__TARGET_USER__/$TARGET_USER/" "$DIR/scripts/atlas-firstboot.sh" \
  | sudo tee "$ROOT_MNT/opt/atlas-firstboot.sh" >/dev/null
sudo chmod 755 "$ROOT_MNT/opt/atlas-firstboot.sh"

# ---------------------------------------------------------------------------
# Write the systemd unit and enable it offline via `systemctl --root=`.
#
# Waits on time-sync.target, not just network-online.target: a Pi has no
# battery-backed RTC, so a cold first boot's clock can start out badly wrong
# (observed in practice: stuck on a months-old date) until NTP corrects it.
# Confirmed in real testing (2026-09-03) that this alone made apt treat every
# Debian repo's signature as "not live until" a future date (since the repo
# really was signed after the Pi's wrong idea of "now"), forcing a slow
# stale-index fallback right at atlas-firstboot.sh's very first apt-get. git
# clone (HTTPS, also checks certificate validity windows against system time)
# and every cert atlas-firstboot.sh later issues could hit the same problem.
# time-sync.target is what systemd-timesyncd/chrony signal once they've
# actually synced, so ordering after it means apt/git/openssl only ever run
# with a clock that's actually correct.
# ---------------------------------------------------------------------------
echo "==> Writing etc/systemd/system/atlas-firstboot.service"
sudo tee "$ROOT_MNT/etc/systemd/system/atlas-firstboot.service" >/dev/null <<'EOF'
[Unit]
Description=Atlas Competition Manager — first-boot provisioning
After=network-online.target time-sync.target
Wants=network-online.target time-sync.target
ConditionPathExists=!/opt/.atlas-firstboot-done

[Service]
Type=oneshot
ExecStart=/opt/atlas-firstboot.sh
RemainAfterExit=yes
TimeoutStartSec=0

[Install]
WantedBy=multi-user.target
EOF

echo "==> Enabling atlas-firstboot.service (offline, via systemctl --root)"
sudo systemctl --root="$ROOT_MNT" enable atlas-firstboot.service

echo ""
echo "Done. Verifying:"
sudo systemctl --root="$ROOT_MNT" is-enabled atlas-firstboot.service

echo ""
echo "Safe to unmount/eject $ROOT_MNT now and boot the Pi."
echo "First boot will take real time (apt + npm installs on a Pi, not a desktop) —"
echo "watch progress with: ssh $TARGET_USER@openpiste.local 'tail -f /var/log/atlas-firstboot.log'"
