#!/bin/bash
# Cursor stop hook — block completion only when inbox has actionable mail.
# - Pending non-system inbox → inject preview + block
# - No actionable pending → allow stop (even if last tool was send_message; empty inbox)
# - Read-only last tool or listen/register → allow (early exit)
#
# Input:  hook JSON (status, workspace_roots, loop_count, …)
# Output: Cursor 2.x: { "followup_message": "..." } to force another turn;
#         legacy: { "continue": false, "agentMessage": "..." }

set -euo pipefail
INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/cursor_hook_lib.py"

NEOHIVE_DIR=$(printf '%s' "$INPUT" | python3 "$LIB" neohive_dir)
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

STATUS=$(printf '%s' "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
[ "$STATUS" = "aborted" ] && printf '%s\n' '{"continue":true}' && exit 0

[ -f "$ACTIVITY_FILE" ] || { printf '%s\n' '{"continue":true}'; exit 0; }

# Auto-discover dashboard URL
NEOHIVE_URL="http://localhost:3000"
_DASHBOARD_JSON="${NEOHIVE_DIR}/dashboard.json"
if [ -f "$_DASHBOARD_JSON" ]; then
  _DISCOVERED=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('url',''))" "$_DASHBOARD_JSON" 2>/dev/null)
  [ -n "$_DISCOVERED" ] && NEOHIVE_URL="$_DISCOVERED"
fi

read -r AGENT_NAME LAST_TOOL <<< "$(tail -200 "$ACTIVITY_FILE" 2>/dev/null | python3 -c "
import sys, json
agent = ''
last_tool = ''
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
        if e.get('agent') and e['agent'] not in ('unknown', ''):
            agent = e['agent']
        t = e.get('tool', '')
        if t.startswith('mcp__neohive__'):
            last_tool = t
    except Exception:
        pass
print(agent or 'unknown', last_tool)
" 2>/dev/null)"

[ -z "$LAST_TOOL" ] && printf '%s\n' '{"continue":true}' && exit 0

STOP_ALLOW=$(python3 "$LIB" stop_allow "$LAST_TOOL")
if [[ "$STOP_ALLOW" == "yes" ]]; then
  printf '%s\n' '{"continue":true}'
  exit 0
fi

PENDING_MSGS=""
if [ "$AGENT_NAME" != "unknown" ] && [ -f "$NEOHIVE_DIR/messages.jsonl" ]; then
  PENDING_MSGS=$(python3 - "$NEOHIVE_DIR/messages.jsonl" "$NEOHIVE_DIR/consumed-${AGENT_NAME}.json" "$AGENT_NAME" <<'PYEOF'
import sys, json

msg_file, consumed_file, agent = sys.argv[1], sys.argv[2], sys.argv[3]

consumed = set()
try:
    with open(consumed_file) as f:
        consumed = set(json.load(f))
except OSError:
    pass

pending = []
try:
    with open(msg_file) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                m = json.loads(line)
                if m.get("id") in consumed:
                    continue
                to = m.get("to", "")
                if to != agent and to != "__group__" and to != "__all__":
                    continue
                if to == "__group__" and m.get("from") == agent:
                    continue
                if m.get("system"):
                    continue
                pending.append(m)
            except json.JSONDecodeError:
                pass
except OSError:
    pass

priority_order = {"critical": 0, "high": 1, "normal": 2, "low": 3}
pending.sort(key=lambda m: priority_order.get(m.get("priority"), 2))

for m in pending[:3]:
    sender = m.get("from", "?")
    content = (m.get("content") or "").replace("\n", " ").strip()[:400]
    msg_id = m.get("id", "")
    print(f"FROM {sender}: {content} [id:{msg_id}]")
PYEOF
  2>/dev/null)
fi

block_json() {
  export BLOCK_TEXT="$1"
  python3 -c "
import json, os
m = os.environ.get('BLOCK_TEXT', '')
out = {'continue': False, 'agentMessage': m, 'followup_message': m}
print(json.dumps(out))
"
  unset BLOCK_TEXT
}

if [ -n "$PENDING_MSGS" ]; then
  MSG_COUNT=$(echo "$PENDING_MSGS" | wc -l | tr -d ' ')
  curl -s -X POST "${NEOHIVE_URL}/api/inject" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"from":"%s","to":"__user__","content":"[PUSH DELIVERY] %s has %s pending message(s) — injecting into Cursor context.","priority":"normal"}' \
      "$AGENT_NAME" "$AGENT_NAME" "$MSG_COUNT")" \
    --max-time 2 >/dev/null 2>&1 || true
  MSGS_ESCAPED=$(echo "$PENDING_MSGS" | python3 -c "import sys; print(sys.stdin.read().replace(chr(10), ' | '))" 2>/dev/null || echo "$PENDING_MSGS")
  TEXT="NEOHIVE — INCOMING MESSAGES FOR ${AGENT_NAME}: ${MSGS_ESCAPED} — Call listen() now to consume and respond. Do not stop."
  block_json "$TEXT"
  exit 0
fi

# Inbox has no pending non-system messages — do not block stop (avoids empty-inbox loops).
# afterMCPExecution already injects a listen() reminder after mutating tools.
printf '%s\n' '{"continue":true}'
exit 0
