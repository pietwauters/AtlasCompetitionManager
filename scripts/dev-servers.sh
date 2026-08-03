#!/usr/bin/env bash
# dev-servers.sh — dev convenience: start/stop this server together with the
# sibling mqtt-web server (/home/piet/mqtt-web), since a full local test
# usually needs both running. No pm2, no boot integration — plain `node`
# processes, detached from the terminal so closing it doesn't kill them.
#
# Usage:
#   ./scripts/dev-servers.sh [start]   # start both (no-op for any already running)
#   ./scripts/dev-servers.sh stop      # stop ALL instances of both, however started
#   ./scripts/dev-servers.sh status    # show what's currently running
#
# Override the mqtt-web location if it isn't a sibling directory:
#   MQTT_WEB_DIR=/path/to/mqtt-web ./scripts/dev-servers.sh start

set -euo pipefail

ATLAS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MQTT_WEB_DIR="${MQTT_WEB_DIR:-$(cd "$ATLAS_DIR/.." 2>/dev/null && pwd)/mqtt-web}"

RUN_DIR="/tmp/atlas-dev-servers"
mkdir -p "$RUN_DIR"

ATLAS_LOG="$RUN_DIR/atlas.log"
MQTT_LOG="$RUN_DIR/mqtt-web.log"

# Find every "node ... server.js" process that actually belongs to the given
# directory — matched by the process's real cwd *or* by an absolute path to
# that directory's server.js appearing on its command line, so this catches
# a process regardless of how it was launched (this script, a bare
# `node server.js`, etc). Deliberately not a bare pkill on a port or a loose
# "server.js" pattern — that would risk hitting an unrelated node process.
pids_for_dir() {
  local target_dir="$1" server_path pid cwd cmdline
  server_path="$target_dir/server.js"
  for pid in $(pgrep -f 'node .*server\.js' 2>/dev/null || true); do
    cwd="$(readlink -f "/proc/$pid/cwd" 2>/dev/null || true)"
    cmdline="$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null || true)"
    if [[ "$cwd" == "$target_dir" || "$cmdline" == *"$server_path"* ]]; then
      echo "$pid"
    fi
  done
}

start_one() {
  local name="$1" dir="$2" logfile="$3" pids
  pids="$(pids_for_dir "$dir")"
  if [[ -n "$pids" ]]; then
    echo "$name: already running (pid $(echo "$pids" | tr '\n' ' '))"
    return
  fi
  if [[ ! -f "$dir/server.js" ]]; then
    echo "$name: no server.js found in $dir" >&2
    return 1
  fi
  echo "Starting $name ($dir)..."
  ( cd "$dir" && exec nohup node "$dir/server.js" >"$logfile" 2>&1 ) &
  disown 2>/dev/null || true
  sleep 0.5
  pids="$(pids_for_dir "$dir")"
  if [[ -n "$pids" ]]; then
    echo "  → pid $pids, log: $logfile"
  else
    echo "  → failed to start, see $logfile" >&2
    tail -n 20 "$logfile" >&2 2>/dev/null || true
  fi
}

stop_one() {
  local name="$1" dir="$2" pids
  pids="$(pids_for_dir "$dir")"
  if [[ -z "$pids" ]]; then
    echo "$name: no running instances found"
    return
  fi
  echo "$name: stopping the following:"
  ps -o pid,etime,cmd -p $pids --no-headers | sed 's/^/    /'
  kill $pids 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    sleep 0.5
    pids="$(pids_for_dir "$dir")"
    [[ -z "$pids" ]] && break
  done
  if [[ -n "$pids" ]]; then
    echo "$name: force-killing remaining pid(s) $(echo "$pids" | tr '\n' ' ')"
    kill -9 $pids 2>/dev/null || true
  fi
}

status_one() {
  local name="$1" dir="$2" pids
  pids="$(pids_for_dir "$dir")"
  if [[ -z "$pids" ]]; then
    echo "$name: not running"
  else
    echo "$name: running"
    ps -o pid,etime,cmd -p $pids --no-headers | sed 's/^/    /'
  fi
}

cmd="${1:-start}"
case "$cmd" in
  start)
    start_one "Atlas"    "$ATLAS_DIR"    "$ATLAS_LOG"
    start_one "mqtt-web" "$MQTT_WEB_DIR" "$MQTT_LOG"
    echo ""
    echo "Atlas:    http://localhost:3001  (https://openpiste.local:3443)"
    echo "mqtt-web: https://localhost:3000"
    echo "Logs:     $RUN_DIR/*.log"
    ;;
  stop)
    stop_one "Atlas"    "$ATLAS_DIR"
    stop_one "mqtt-web" "$MQTT_WEB_DIR"
    ;;
  status)
    status_one "Atlas"    "$ATLAS_DIR"
    status_one "mqtt-web" "$MQTT_WEB_DIR"
    ;;
  *)
    echo "Usage: $0 {start|stop|status}" >&2
    exit 1
    ;;
esac
