#!/usr/bin/env bash
# configure-wifi.sh — scan for or connect to WiFi networks via NetworkManager,
# triggered from admin.html's WiFi card. Same "narrowly-scoped sudo script"
# pattern as scripts/push-tier-a-crl.sh: this file alone gets a passwordless
# sudoers grant, never a blanket one.
#
# Unlike push-tier-a-crl.sh, scan and connect are NOT split into two scripts —
# that split exists there to keep an *unprivileged*, ownership-sensitive step
# (writing data/tls/) out of the privileged half. Nothing here writes anything
# app-owned; both subcommands need root equally (regulatory country via
# raspi-config always needs root), so one script/one sudoers line is simpler
# for the operator than two.
#
# The connect subcommand reads the WiFi password from stdin, one line, rather
# than argv — this keeps it off services/wifiConfig.js's own execFileSync argv
# and out of this script's own process listing. nmcli itself still receives it
# as a CLI argument below (nmcli has no non-interactive stdin mode for this),
# but that's only ever visible to root, which is already running this whole
# script — not a new exposure, just one fewer unnecessary hop.
#
# Usage:
#   configure-wifi.sh scan <country>
#   configure-wifi.sh connect <country> <ssid>      # password read from stdin (may be empty for an open network)

set -euo pipefail

MODE="${1:-}"
COUNTRY="${2:-}"

if [[ -z "$MODE" || -z "$COUNTRY" ]]; then
  echo "Usage: $0 scan <country> | connect <country> <ssid>" >&2
  exit 1
fi
if [[ ! "$COUNTRY" =~ ^[A-Za-z]{2}$ ]]; then
  echo "Invalid country code: $COUNTRY" >&2
  exit 1
fi
COUNTRY="${COUNTRY^^}"

echo "Setting WiFi regulatory country to $COUNTRY..."
sudo raspi-config nonint do_wifi_country "$COUNTRY"
sudo nmcli radio wifi on

case "$MODE" in
  scan)
    sudo nmcli device wifi rescan 2>/dev/null || true
    sleep 2
    sudo nmcli -t -f SSID,SIGNAL,SECURITY device wifi list
    ;;
  connect)
    SSID="${3:-}"
    if [[ -z "$SSID" ]]; then
      echo "Usage: $0 connect <country> <ssid>" >&2
      exit 1
    fi
    read -r PASSWORD || true
    if [[ -z "${PASSWORD:-}" ]]; then
      sudo nmcli device wifi connect "$SSID"
    else
      sudo nmcli device wifi connect "$SSID" password "$PASSWORD"
    fi
    ;;
  *)
    echo "Unknown mode: $MODE" >&2
    exit 1
    ;;
esac
