#!/bin/bash
# Codex Stop hook — two jobs:
#   1. If pending messages exist for this agent: inject them directly into context (no listen() needed)
#   2. If no pending messages but last tool wasn't listen: prompt agent to call listen()
#
# Codex passes hook context as JSON on stdin (no CLAUDE_PROJECT_DIR-style env
# vars), so cwd/session are read from the payload instead of the environment.
# Exit 2 = block stop (inject message or reminder into context)
# Exit 0 = allow stop

STDIN_JSON=$(cat)
PROJECT_DIR=$(echo "$STDIN_JSON" | jq -r '.cwd // empty' 2>/dev/null)
SESSION=$(echo "$STDIN_JSON" | jq -r '.session_id // empty' 2>/dev/null)
STOP_STATUS=$(echo "$STDIN_JSON" | jq -r '.stop_hook_status // empty' 2>/dev/null)

NEOHIVE_DIR="${PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

# Auto-discover dashboard URL
_DASHBOARD_JSON="${NEOHIVE_DIR}/dashboard.json"
if [ -z "$NEOHIVE_SERVER_URL" ] && [ -f "$_DASHBOARD_JSON" ]; then
  _DISCOVERED=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('url',''))" "$_DASHBOARD_JSON" 2>/dev/null)
  [ -n "$_DISCOVERED" ] && NEOHIVE_SERVER_URL="$_DISCOVERED"
fi
NEOHIVE_URL="${NEOHIVE_SERVER_URL:-http://localhost:${NEOHIVE_PORT:-3000}}"

# Allow: user aborted
[ "$STOP_STATUS" = "aborted" ] && exit 0

# Not a neohive project
[ -f "$ACTIVITY_FILE" ] || exit 0

# Resolve agent name + last tool for this session from activity log
read -r AGENT_NAME LAST_TOOL <<< "$(tail -200 "$ACTIVITY_FILE" 2>/dev/null | python3 -c "
import sys, json
session = '$SESSION'
agent = ''
last_tool = ''
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        if session and e.get('session', '') != session and session != '': continue
        if e.get('agent') and e['agent'] not in ('unknown', ''):
            agent = e['agent']
        if e.get('tool', '').startswith('mcp__neohive__'):
            last_tool = e['tool']
    except: pass
print(agent or 'unknown', last_tool)
" 2>/dev/null)"

# No neohive tools used this session — allow stop
[ -z "$LAST_TOOL" ] && exit 0

# Already listening/registering — allow stop
case "$LAST_TOOL" in
  mcp__neohive__listen|mcp__neohive__register|mcp__neohive__listen_codex|mcp__neohive__listen_group)
    exit 0 ;;
esac

# Check for pending messages for this agent in messages.jsonl
PENDING_MSGS=""
if [ "$AGENT_NAME" != "unknown" ] && [ -f "$NEOHIVE_DIR/messages.jsonl" ]; then
  PENDING_MSGS=$(python3 - "$NEOHIVE_DIR/messages.jsonl" "$NEOHIVE_DIR/consumed-${AGENT_NAME}.json" "$AGENT_NAME" <<'PYEOF'
import sys, json

msg_file, consumed_file, agent = sys.argv[1], sys.argv[2], sys.argv[3]

# Load consumed IDs
consumed = set()
try:
    with open(consumed_file) as f:
        consumed = set(json.load(f))
except: pass

# Scan all messages for unconsumed ones addressed to this agent
pending = []
try:
    with open(msg_file) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                m = json.loads(line)
                if m.get('id') in consumed: continue
                to = m.get('to', '')
                if to != agent and to != '__group__' and to != '__all__': continue
                if to == '__group__' and m.get('from') == agent: continue
                if m.get('system'): continue  # skip system messages
                pending.append(m)
            except: pass
except: pass

# Output up to 3 pending messages, priority order
priority_order = {'critical': 0, 'high': 1, 'normal': 2, 'low': 3}
pending.sort(key=lambda m: priority_order.get(m.get('priority'), 2))

for m in pending[:3]:
    sender = m.get('from', '?')
    content = m.get('content', '').replace('\n', ' ').strip()[:400]
    msg_id = m.get('id', '')
    print(f"FROM {sender}: {content} [id:{msg_id}]")
PYEOF
  2>/dev/null)
fi

# ── Case 1: Pending messages exist — inject them directly ─────────────────────
if [ -n "$PENDING_MSGS" ]; then
  # Report to dashboard
  PAYLOAD=$(printf '{"from":"%s","to":"__user__","content":"[PUSH DELIVERY] %s has %s pending message(s) — injecting into context.","priority":"normal"}' \
    "$AGENT_NAME" "$AGENT_NAME" "$(echo "$PENDING_MSGS" | wc -l | tr -d ' ')")
  curl -s -X POST "${NEOHIVE_URL}/api/inject" \
    -H "Content-Type: application/json" -d "$PAYLOAD" --max-time 2 > /dev/null 2>&1 || true

  cat <<EOF

📨 NEOHIVE — INCOMING MESSAGE(S) FOR ${AGENT_NAME}:

${PENDING_MSGS}

These messages are waiting for you. Call listen() to officially receive and consume them,
then process and respond. Do not stop — call listen() now.
EOF
  exit 2
fi

# ── Case 2: No pending messages but last tool wasn't listen ───────────────────
curl -s -X POST "${NEOHIVE_URL}/api/inject" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"from":"%s","to":"__user__","content":"[STOP HOOK] %s stopping without listen(). Last tool: %s. Prompting to call listen().","priority":"low"}' \
    "$AGENT_NAME" "$AGENT_NAME" "$LAST_TOOL")" \
  --max-time 2 > /dev/null 2>&1 || true

cat <<'EOF'

⚠️  NEOHIVE — CALL listen() BEFORE STOPPING:

No pending messages right now, but you must stay in the receive loop.
Call listen() now — it will return immediately if nothing arrives, with retry:true.

→ Call: listen()
EOF
exit 2
