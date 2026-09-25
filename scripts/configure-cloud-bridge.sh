#!/usr/bin/env bash
# configure-cloud-bridge.sh — relay this venue's local OPP2 traffic to the global
# cloud broker using Mosquitto's native bridge, with the topic prefix defined in
# docs/level2.md §31.2:
#
#   local  openpiste/{piste}/{publisher}/{type}
#   cloud  openpiste/{NOC}/{yyyy}/{mm}/{dd}/{tournament_id}/{piste}/{publisher}/{type}
#
# The prefix depends only on the tournament, so the bridge config is static for the
# whole event. Which competition a piste is running at any moment travels inside the
# relayed messages (`competition` in software/record and software/match, §31.4), so
# pistes can move between competitions freely without touching the bridge.
#
# This is §31.6 "Option A" (manual bridge configuration): the operator describes the
# tournament and its competitions in a small JSON file (see
# scripts/cloud-bridge.example.json) and runs this script once at setup, again
# whenever the competition list changes, and with --remove when the tournament is
# over. Competition ids must match each competition's "OPP2 code" in Atlas.
#
# Relayed: openpiste/+/{role}/# for each official publisher role (apparatus,
# software, remote, var, scoresheet) plus any vendor roles listed under
# "extra_publishers". Never a bare openpiste/+/+/+ wildcard: the Tier A provisioning
# response topic openpiste/_provision/response/{device_id} has the same shape as a
# piste topic and carries a freshly issued client certificate (§31.6 MUST NOT).
#
# Uniqueness (§31.3) comes from the hierarchy, not a registry: {tournament_id} only
# has to be unique within {NOC}/{date}. Before configuring anything, the script reads
# the retained §31.5 tournament identity message on the cloud broker. If it exists
# and describes a different tournament (name/city/start date), the script stops —
# someone else has that path. If it describes this tournament, it's a re-run. A
# connection/auth failure aborts rather than being mistaken for "free".
# Check-then-publish isn't atomic, but two operators picking the same tournament_id
# for the same NOC and date within seconds of each other isn't a realistic scenario.
#
# Cloud-broker requirement (mqtt.openpiste.org ACL): the bridge user needs
#   user <bridge-user>
#   topic readwrite openpiste/#
#
# The bridge is out-only: nothing on the cloud broker can publish into the venue.
#
# Usage:
#   ./scripts/configure-cloud-bridge.sh <config.json>            # check, write bridge, publish identity
#   ./scripts/configure-cloud-bridge.sh <config.json> --dry-run  # validate + print generated config only
#   ./scripts/configure-cloud-bridge.sh <config.json> --force    # skip the identity collision check
#   ./scripts/configure-cloud-bridge.sh <config.json> --remove   # clear identity message, remove bridge
#
# Environment (testing only): MOSQ_CONF_D (default /etc/mosquitto/conf.d),
# NO_RESTART=1 (don't restart mosquitto), SUDO= (run privileged steps without sudo).

set -euo pipefail

CONFIG="${1:-}"
MODE="${2:-}"
if [[ -z "$CONFIG" || ! -f "$CONFIG" ]]; then
  sed -n '/^# Usage:/,/^# Environment/p' "$0" | sed 's/^# \{0,1\}//' | head -n -1
  exit 1
fi
case "$MODE" in ""|--dry-run|--force|--remove) ;; *) echo "Unknown option: $MODE" >&2; exit 1;; esac

MOSQ_CONF_D="${MOSQ_CONF_D:-/etc/mosquitto/conf.d}"
SUDO="${SUDO-sudo}"
[[ $EUID == 0 ]] && SUDO=""
BRIDGE_CONF="$MOSQ_CONF_D/openpiste-cloud-bridge.conf"
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

for bin in node mosquitto_sub mosquitto_pub; do
  command -v "$bin" &>/dev/null || { echo "Missing required command: $bin" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# Validate the config and render everything derived from it into $WORK:
#   broker.env      host/port/user/password-file/tls settings for this shell
#   bridge.topics   mosquitto `topic` lines, one per publisher role
#   identity.topic  §31.5 tournament identity topic
#   identity.json   §31.5 tournament identity payload
# ---------------------------------------------------------------------------
node - "$CONFIG" "$WORK" <<'NODE'
'use strict';
const fs = require('fs');
const path = require('path');
const [cfgPath, out] = process.argv.slice(2);

const errors = [];
const fail = (msg) => errors.push(msg);
let cfg;
try { cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')); }
catch (e) { console.error(`Cannot read ${cfgPath}: ${e.message}`); process.exit(1); }

const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '')
  && !isNaN(Date.parse(s + 'T00:00:00Z'))
  && new Date(s + 'T00:00:00Z').toISOString().startsWith(s);

const b = cfg.broker || {};
const broker = {
  host: b.host || 'mqtt.openpiste.org',
  port: b.port || 8883,
  username: b.username || 'bridge',
  passwordFile: b.password_file || '/etc/openpiste/bridge_password',
  tls: b.tls !== false,
  cafile: b.cafile || '',
};

const t = cfg.tournament || {};
if (!/^[A-Z]{3}$/.test(t.country || '')) fail('tournament.country must be a 3-letter IOC code in upper case (e.g. "BEL")');
if (!isDate(t.start_date)) fail('tournament.start_date must be a valid "YYYY-MM-DD" date');
if (!isDate(t.end_date)) fail('tournament.end_date must be a valid "YYYY-MM-DD" date');
if (isDate(t.start_date) && isDate(t.end_date) && t.end_date < t.start_date) fail('tournament.end_date is before start_date');
if (!ID_RE.test(t.id || '')) fail('tournament.id must be lowercase letters/digits separated by single hyphens (e.g. "bel-nat-champ-2026")');
for (const f of ['name', 'city']) if (!t[f]) fail(`tournament.${f} is required`);

const comps = Array.isArray(cfg.competitions) ? cfg.competitions : [];
if (!comps.length) fail('competitions must list at least one competition');
const seenComp = new Set();
comps.forEach((c, i) => {
  const where = `competitions[${i}]${c.id ? ` (${c.id})` : ''}`;
  if (!ID_RE.test(c.id || '')) fail(`${where}.id must be lowercase letters/digits separated by single hyphens (e.g. "u17-m-foil")`);
  else if (seenComp.has(c.id)) fail(`${where}: duplicate competition id`);
  seenComp.add(c.id);
  if (!c.name) fail(`${where}.name is required`);
  if (!['F', 'E', 'S'].includes(c.weapon)) fail(`${where}.weapon must be "F", "E" or "S"`);
  if (!['I', 'T'].includes(c.type)) fail(`${where}.type must be "I" or "T"`);
  if (c.gender !== undefined && !['M', 'F', 'X'].includes(c.gender)) fail(`${where}.gender must be "M", "F" or "X"`);
  if (c.pistes !== undefined) fail(`${where}.pistes is not used — pistes aren't tied to a competition (docs/level2.md §31.4)`);
});

const OFFICIAL_ROLES = ['apparatus', 'software', 'remote', 'var', 'scoresheet'];
const extra = cfg.extra_publishers === undefined ? [] : cfg.extra_publishers;
if (!Array.isArray(extra)) fail('extra_publishers must be an array of vendor roles (e.g. ["x_acme_settingsmanager"])');
else for (const r of extra) {
  if (!/^x_[a-z0-9]+_[a-z0-9_]+$/.test(r)) fail(`extra_publishers: "${r}" is not a vendor role of the form x_{vendor_id}_{role} (§29.5)`);
}

if (errors.length) {
  console.error('Config errors:');
  for (const e of errors) console.error('  - ' + e);
  process.exit(1);
}

const [yyyy, mm, dd] = t.start_date.split('-');
const base = `openpiste/${t.country}/${yyyy}/${mm}/${dd}/${t.id}`;

const tournament = {
  id: t.id, name: t.name, city: t.city, country: t.country,
  start_date: t.start_date, end_date: t.end_date,
};
if (t.organiser) tournament.organiser = t.organiser;
if (t.ext_id) tournament.ext_id = t.ext_id;
const competitions = comps.map((c) => {
  const competition = { id: c.id, name: c.name, weapon: c.weapon, type: c.type };
  if (c.category) competition.category = c.category;
  if (c.gender) competition.gender = c.gender;
  return competition;
});
fs.writeFileSync(path.join(out, 'identity.topic'), `${base}/identity`);
fs.writeFileSync(path.join(out, 'identity.json'),
  JSON.stringify({ protocol: 'OPP2', version: '1.0', tournament, competitions }));

const roles = [...OFFICIAL_ROLES, ...extra];
fs.writeFileSync(path.join(out, 'bridge.topics'),
  roles.map((r) => `topic +/${r}/# out 1 openpiste/ ${base}/`).join('\n') + '\n');

const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
fs.writeFileSync(path.join(out, 'broker.env'), [
  `BROKER_HOST=${q(broker.host)}`,
  `BROKER_PORT=${q(broker.port)}`,
  `BROKER_USER=${q(broker.username)}`,
  `BROKER_PASS_FILE=${q(broker.passwordFile)}`,
  `BROKER_TLS=${broker.tls ? 1 : 0}`,
  `BROKER_CAFILE=${q(broker.cafile)}`,
  `TOURNAMENT_LABEL=${q(`${t.name} (${t.city}, ${t.start_date})`)}`,
  `COMP_COUNT=${comps.length}`,
  `ROLES=${q(roles.join(' '))}`,
  `CLOUD_BASE=${q(base)}`,
].join('\n') + '\n');
NODE

# shellcheck source=/dev/null
source "$WORK/broker.env"
IDENTITY_TOPIC=$(cat "$WORK/identity.topic")

if [[ "$MODE" == "--dry-run" ]]; then
  echo "Config OK — $COMP_COUNT competition(s), roles: $ROLES → $BROKER_HOST:$BROKER_PORT"
  echo ""
  echo "Bridge topic lines:"
  sed 's/^/  /' "$WORK/bridge.topics"
  echo ""
  echo "Identity (retained) → $IDENTITY_TOPIC"
  echo "  $(cat "$WORK/identity.json")"
  exit 0
fi

# Password is read with sudo so the file can stay root-only (0600).
BROKER_PASS=$($SUDO cat "$BROKER_PASS_FILE" 2>/dev/null | head -n1 | tr -d '\r\n') || true
if [[ -z "$BROKER_PASS" ]]; then
  echo "Cannot read the bridge password from $BROKER_PASS_FILE." >&2
  echo "Create it with:" >&2
  echo "  sudo install -d -m 700 $(dirname "$BROKER_PASS_FILE")" >&2
  echo "  sudo sh -c 'umask 077; cat > $BROKER_PASS_FILE'   # paste password, then Ctrl-D" >&2
  exit 1
fi

# Every Atlas Pi has the hostname "openpiste", so Mosquitto's default bridge client
# id (<hostname>.<connection>) would be identical at every venue and the cloud
# broker would keep disconnecting one venue in favour of another (§31.6). Derive a
# stable per-machine id instead.
MACHINE_TAG=$(sha256sum /etc/machine-id 2>/dev/null | cut -c1-12)
[[ -n "$MACHINE_TAG" ]] || MACHINE_TAG=$(hostname | sha256sum | cut -c1-12)
CLIENT_ID="atlas-bridge-$MACHINE_TAG"

# Credentials for the one-shot sub/pub calls below go in the clients' own options
# file ($XDG_CONFIG_HOME/mosquitto_{sub,pub}) rather than -P on the command line,
# which would expose the password in the process list.
install -d -m 700 "$WORK/xdg"
{
  echo "-h $BROKER_HOST"
  echo "-p $BROKER_PORT"
  echo "-u $BROKER_USER"
  echo "-P $BROKER_PASS"
  if [[ "$BROKER_TLS" == 1 ]]; then
    if [[ -n "$BROKER_CAFILE" ]]; then echo "--cafile $BROKER_CAFILE"
    else echo "--capath /etc/ssl/certs"; fi
  fi
} > "$WORK/xdg/mosquitto_sub"
cp "$WORK/xdg/mosquitto_sub" "$WORK/xdg/mosquitto_pub"
export XDG_CONFIG_HOME="$WORK/xdg"
MOSQ_ARGS=(-i "$CLIENT_ID-setup")

# Prints the retained payload on the topic (empty if none). Exits the script on any
# failure other than mosquitto_sub's own timeout (rc 27), so an unreachable broker
# or rejected credential is never mistaken for "nothing retained here".
read_retained() {
  local out rc=0
  out=$(mosquitto_sub "${MOSQ_ARGS[@]}" -t "$1" -C 1 -W 5 --retained-only 2>"$WORK/sub.err") || rc=$?
  if [[ $rc == 0 ]]; then printf '%s' "$out"; return 0; fi
  if [[ $rc == 27 ]]; then return 0; fi
  echo "Could not read $1 from $BROKER_HOST:$BROKER_PORT: $(tr '\n' ' ' < "$WORK/sub.err")" >&2
  exit 1
}

restart_mosquitto() {
  [[ "${NO_RESTART:-0}" == 1 ]] && { echo "NO_RESTART=1 — not restarting mosquitto."; return; }
  $SUDO systemctl restart mosquitto
  sleep 1
  systemctl is-active --quiet mosquitto || {
    echo "mosquitto failed to restart — check: journalctl -u mosquitto -n 30" >&2
    exit 1
  }
}

# ---------------------------------------------------------------------------
# --remove: clear the retained identity message (the discovery layer should list
# only live tournaments, §31.5), then drop the bridge.
# ---------------------------------------------------------------------------
if [[ "$MODE" == "--remove" ]]; then
  mosquitto_pub "${MOSQ_ARGS[@]}" -t "$IDENTITY_TOPIC" -r -q 1 -n
  echo "Cleared $IDENTITY_TOPIC"
  if [[ -f "$BRIDGE_CONF" ]]; then
    $SUDO rm -f "$BRIDGE_CONF"
    echo "Removed $BRIDGE_CONF"
    restart_mosquitto
  else
    echo "No bridge config at $BRIDGE_CONF — nothing to remove."
  fi
  # Backups hold the bridge password too; mosquitto never loads them (not *.conf).
  $SUDO rm -f "$BRIDGE_CONF".bak-*
  echo "Note: retained piste topics already relayed to the cloud stay there until"
  echo "overwritten or cleared on the cloud broker itself."
  exit 0
fi

# ---------------------------------------------------------------------------
# Collision check against an existing §31.5 tournament identity message.
# ---------------------------------------------------------------------------
if [[ "$MODE" != "--force" ]]; then
  echo "Checking $BROKER_HOST for another tournament at $CLOUD_BASE ..."
  existing=$(read_retained "$IDENTITY_TOPIC")
  if [[ -n "$existing" ]]; then
    verdict=$(node -e '
      const a = JSON.parse(process.argv[1]).tournament || {};
      let b = {};
      try { b = JSON.parse(process.argv[2]).tournament || {}; } catch (_) {}
      const same = ["name", "city", "start_date"].every((k) => a[k] === b[k]);
      console.log(same ? "same" : `${b.name || "?"} (${b.city || "?"}, ${b.start_date || "?"})`);
    ' "$(cat "$WORK/identity.json")" "$existing")
    if [[ "$verdict" != "same" ]]; then
      echo "" >&2
      echo "COLLISION: $CLOUD_BASE is already claimed by:" >&2
      echo "  $verdict" >&2
      echo "This tournament is: $TOURNAMENT_LABEL" >&2
      echo "Pick a different tournament.id in $CONFIG." >&2
      exit 1
    fi
    echo "  Already holds this tournament's identity — treating as a re-run."
  fi
fi

# ---------------------------------------------------------------------------
# Write the bridge config (0640 root:mosquitto — it contains the password).
# ---------------------------------------------------------------------------
{
  echo "# Generated by scripts/configure-cloud-bridge.sh from $(realpath "$CONFIG")"
  echo "# on $(date -u +%Y-%m-%dT%H:%M:%SZ) — re-run the script rather than editing by hand."
  echo "# $TOURNAMENT_LABEL"
  echo ""
  echo "connection openpiste-cloud"
  echo "address $BROKER_HOST:$BROKER_PORT"
  echo "remote_clientid $CLIENT_ID"
  echo "remote_username $BROKER_USER"
  echo "remote_password $BROKER_PASS"
  if [[ "$BROKER_TLS" == 1 ]]; then
    if [[ -n "$BROKER_CAFILE" ]]; then echo "bridge_cafile $BROKER_CAFILE"
    else echo "bridge_capath /etc/ssl/certs"; fi
  fi
  echo "bridge_protocol_version mqttv311"
  echo "try_private true"
  echo "start_type automatic"
  echo "notifications false"
  echo ""
  cat "$WORK/bridge.topics"
} > "$WORK/bridge.conf"

if [[ -f "$BRIDGE_CONF" ]]; then
  BACKUP="$BRIDGE_CONF.bak-$(date +%Y%m%d%H%M%S)"
  $SUDO cp -a "$BRIDGE_CONF" "$BACKUP"
  $SUDO chmod 600 "$BACKUP"
  echo "Backed up previous bridge config to $BACKUP"
fi
if [[ -n "$SUDO" || $EUID == 0 ]] && getent group mosquitto >/dev/null; then
  $SUDO install -o root -g mosquitto -m 640 "$WORK/bridge.conf" "$BRIDGE_CONF"
else
  $SUDO install -m 644 "$WORK/bridge.conf" "$BRIDGE_CONF"
fi
echo "Wrote $BRIDGE_CONF (roles: $ROLES)"

# ---------------------------------------------------------------------------
# Publish the §31.5 tournament identity (retained, QoS 1) directly to the cloud.
# ---------------------------------------------------------------------------
mosquitto_pub "${MOSQ_ARGS[@]}" -t "$IDENTITY_TOPIC" -r -q 1 -f "$WORK/identity.json"
echo "Published identity → $IDENTITY_TOPIC ($COMP_COUNT competition(s))"

restart_mosquitto
echo ""
echo "Cloud bridge active. Watch it from anywhere with:"
echo "  mosquitto_sub -h $BROKER_HOST -p $BROKER_PORT ... -t '$CLOUD_BASE/#' -v"
