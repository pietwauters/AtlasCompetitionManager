#!/usr/bin/env bash
# provision-broker.sh — make this machine capable of being the OPP2 broker host
# from a genuinely clean install: Mosquitto's base (non-TLS) listeners, and a local
# chrony NTP server (docs/level2.md §4.3 — "The broker host SHOULD also run a local
# NTP server... On Linux, chrony is recommended"). The two are bundled in one script
# deliberately: devices reach the NTP server at the same address as the broker, so
# it only makes sense to set up chrony on whichever machine is actually running
# Mosquitto.
#
# What this does NOT do: configure Mosquitto's TLS listeners (8883, 9002) — those
# depend on data/tls/{ca,server}.{crt,key} existing first (generate-tls-cert.sh),
# and are created by install-broker-cert.sh once the certs are actually there. This
# script only creates the two listeners that never depend on TLS material: 1883
# (plain MQTT) and 9001 (plain WebSockets).
#
# Idempotent and non-destructive: skips package install if already present, skips
# each listener stanza if one already exists (anywhere in mosquitto.conf or
# /etc/mosquitto/conf.d/*.conf — won't duplicate or fight a hand-customized setup),
# backs up mosquitto.conf/chrony.conf before any edit, and asks before doing
# anything at all. Safe to run standalone any time, not just from install.sh.
#
# Usage:
#   ./scripts/provision-broker.sh
#   ./scripts/provision-broker.sh --yes   # answer both prompts "yes" non-interactively
#                                          #   (for scripted/first-boot callers with no tty)

set -euo pipefail

ASSUME_YES=0
if [[ "${1:-}" == "--yes" || "${1:-}" == "-y" ]]; then
  ASSUME_YES=1
fi

MOSQ_CONF="/etc/mosquitto/mosquitto.conf"
MOSQ_CONF_D="/etc/mosquitto/conf.d"
CHRONY_CONF="/etc/chrony/chrony.conf"

has_listener() {
  grep -rhq "^listener $1\b" "$MOSQ_CONF" "$MOSQ_CONF_D"/*.conf 2>/dev/null
}

# ---------------------------------------------------------------------------
# Mosquitto: install + base (non-TLS) listeners
# ---------------------------------------------------------------------------
NEED_1883=0; NEED_9001=0
if command -v mosquitto &>/dev/null; then
  has_listener 1883 || NEED_1883=1
  has_listener 9001 || NEED_9001=1
else
  NEED_1883=1; NEED_9001=1
fi

if ! command -v mosquitto &>/dev/null || [[ "$NEED_1883" == 1 || "$NEED_9001" == 1 ]]; then
  echo "This machine will host the MQTT broker for Atlas (docs/level2.md's default:"
  echo "mqtt://openpiste.local:1883)."
  if ! command -v mosquitto &>/dev/null; then
    echo "Mosquitto is not installed."
  else
    echo "Mosquitto is installed, but missing:$( [[ $NEED_1883 == 1 ]] && echo -n ' listener 1883' )$( [[ $NEED_9001 == 1 ]] && echo -n ' listener 9001' )."
  fi
  if [[ "$ASSUME_YES" == 1 ]]; then
    ANSWER=y
  else
    read -r -p "Install/configure it now? [y/N] " ANSWER
  fi
  if [[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]]; then
    if ! command -v mosquitto &>/dev/null; then
      echo "Installing mosquitto..."
      sudo apt-get update -y
      sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y mosquitto mosquitto-clients
    fi

    if [[ "$NEED_1883" == 1 || "$NEED_9001" == 1 ]]; then
      STAMP=$(date +%Y%m%d%H%M%S)
      echo "Backing up $MOSQ_CONF -> $MOSQ_CONF.bak-provision-$STAMP"
      sudo cp -a "$MOSQ_CONF" "$MOSQ_CONF.bak-provision-$STAMP"

      TMP=$(mktemp)
      sudo cp "$MOSQ_CONF" "$TMP"
      {
        if [[ "$NEED_1883" == 1 ]]; then
          echo ""
          echo "# Added by scripts/provision-broker.sh — plain MQTT, matches"
          echo "# docs/level2.md's default mqtt://openpiste.local:1883"
          echo "listener 1883"
          echo "allow_anonymous true"
        fi
        if [[ "$NEED_9001" == 1 ]]; then
          echo ""
          echo "# Added by scripts/provision-broker.sh — plain WebSockets, for browser"
          echo "# clients that don't need TLS (see also 9002, added by"
          echo "# install-broker-cert.sh once TLS certs exist)"
          echo "listener 9001"
          echo "protocol websockets"
          echo "allow_anonymous true"
        fi
      } | sudo tee -a "$TMP" >/dev/null
      sudo install -o root -g root -m 644 "$TMP" "$MOSQ_CONF"
      rm -f "$TMP"
    fi

    sudo systemctl enable mosquitto
    sudo systemctl restart mosquitto
    echo "Mosquitto running with listener(s) 1883/9001. TLS listeners (8883, 9002)"
    echo "still need ./scripts/generate-tls-cert.sh + ./scripts/install-broker-cert.sh."
  else
    echo "Skipped — Mosquitto not installed/configured by this run."
  fi
else
  echo "Mosquitto already installed with listeners 1883 and 9001 present, skipping."
fi

# ---------------------------------------------------------------------------
# Chrony: local NTP server, so devices on the venue network can sync clocks
# without internet access — docs/level2.md §4.3. Keeps whatever upstream
# pool/server lines the distro shipped (real internet time when available) and
# adds a stratum-10 fallback so chrony still serves time to local clients even
# with zero working upstream source, plus an explicit allow for common private
# subnets (venue routers vary — 10/8, 172.16/12, 192.168/16 covers effectively
# all of them without opening this to the public internet).
# ---------------------------------------------------------------------------
MARKER="# Added by scripts/provision-broker.sh"
if command -v chronyd &>/dev/null && sudo grep -q "^$MARKER" "$CHRONY_CONF" 2>/dev/null; then
  echo "chrony already installed and configured as a local NTP server, skipping."
else
  echo ""
  echo "docs/level2.md §4.3 recommends running a local NTP server (chrony) on this"
  echo "same machine, so devices reach it at the same address as the broker."
  if [[ "$ASSUME_YES" == 1 ]]; then
    ANSWER=y
  else
    read -r -p "Install/configure chrony as a local NTP server now? [y/N] " ANSWER
  fi
  if [[ "$ANSWER" == "y" || "$ANSWER" == "Y" ]]; then
    if ! command -v chronyd &>/dev/null; then
      echo "Installing chrony..."
      sudo apt-get update -y
      sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y chrony
    fi

    STAMP=$(date +%Y%m%d%H%M%S)
    echo "Backing up $CHRONY_CONF -> $CHRONY_CONF.bak-provision-$STAMP"
    sudo cp -a "$CHRONY_CONF" "$CHRONY_CONF.bak-provision-$STAMP"

    if ! sudo grep -q "^$MARKER" "$CHRONY_CONF"; then
      {
        echo ""
        echo "$MARKER — serve NTP to the local competition network even with no"
        echo "# internet access (docs/level2.md §4.3). Existing pool/server lines"
        echo "# above are left untouched, so real internet time is still used"
        echo "# when available; this is only the offline fallback + local access."
        echo "allow 10.0.0.0/8"
        echo "allow 172.16.0.0/12"
        echo "allow 192.168.0.0/16"
        echo "local stratum 10"
      } | sudo tee -a "$CHRONY_CONF" >/dev/null
    fi

    sudo systemctl enable chrony
    sudo systemctl restart chrony
    echo "chrony running as a local NTP server on this machine."
  else
    echo "Skipped — chrony not installed/configured by this run."
  fi
fi
