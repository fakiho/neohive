#!/usr/bin/env bash
# Canonical Neohive dashboard launcher — pins the hive to agent-bridge/.neohive
# so the dashboard, Files tab, and BMad watcher always read the same directory
# agents register into. Avoids the data-dir ancestor-scoring fallback that can
# otherwise pick the wrong .neohive.
set -euo pipefail

ROOT="/home/sparo/neohive/agent-bridge"
PORT="${NEOHIVE_PORT:-4000}"

# Kill any existing dashboard, then relaunch on the canonical hive.
pkill -f "node dashboard.js" 2>/dev/null || true
sleep 1

cd "$ROOT"
NEOHIVE_LAN="${NEOHIVE_LAN:-true}" \
NEOHIVE_PORT="$PORT" \
NEOHIVE_DATA_DIR="$ROOT/.neohive" \
NEOHIVE_PROJECT_ROOT="$ROOT" \
nohup node dashboard.js > "/tmp/neohive-dashboard-$PORT.log" 2>&1 &

sleep 2
LOG="/tmp/neohive-dashboard-$PORT.log"
echo "Neohive dashboard started on http://localhost:$PORT (hive: $ROOT/.neohive)"
echo "LAN mode: ON"

# Surface the LAN access URL + token (the dashboard writes them to its log).
grep -E "LAN access:|LAN token:" "$LOG" 2>/dev/null || {
  TOKEN="$(cat "$ROOT/.lan-token" 2>/dev/null || true)"
  IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
  [ -n "$TOKEN" ] && echo "  LAN token:  $TOKEN"
  [ -n "$IP" ] && [ -n "$TOKEN" ] && echo "  LAN access: http://$IP:$PORT?token=$TOKEN"
}
echo "Log: $LOG"
