#!/bin/bash
# Cursor stop hook — mirrors Claude Code's enforce-listen.sh
# Blocks the agent from stopping if:
#   1. Pending messages exist → injects them directly (push delivery)
#   2. Last neohive tool wasn't listen → reminds agent to call listen()
#
# Input:  JSON via stdin { "status": "completed"|"aborted"|"error" }
# Output: JSON via stdout { "continue": false, "agentMessage": "..." } to block
#                         { "continue": true } to allow stop

INPUT=$(cat)
NEOHIVE_DIR="${CURSOR_PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

# Allow if user aborted
STATUS=$(echo "$INPUT" | python3 -c "import sys,json; print(json.load(sys.stdin).get('status',''))" 2>/dev/null || echo "")
[ "$STATUS" = "aborted" ] && printf '{"continue":true}\n' && exit 0

# Not a neohive project
[ -f "$ACTIVITY_FILE" ] || { printf '{"continue":true}\n'; exit 0; }

# Auto-discover dashboard URL
_DASHBOARD_JSON="${NEOHIVE_DIR}/dashboard.json"
NEOHIVE_URL="http://localhost:3000"
if [ -f "$_DASHBOARD_JSON" ]; then
  _DISCOVERED=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(d.get('url',''))" "$_DASHBOARD_JSON" 2>/dev/null)
  [ -n "$_DISCOVERED" ] && NEOHIVE_URL="$_DISCOVERED"
fi

# Resolve agent name + last tool from activity log
# Cursor doesn't expose a session ID, so we use the most recent agent entry
read -r AGENT_NAME LAST_TOOL <<< "$(tail -200 "$ACTIVITY_FILE" 2>/dev/null | python3 -c "
import sys, json
agent = ''
last_tool = ''
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        if e.get('agent') and e['agent'] not in ('unknown', ''):
            agent = e['agent']
        if e.get('tool', '').startswith('mcp__neohive__'):
            last_tool = e['tool']
    except: pass
print(agent or 'unknown', last_tool)
" 2>/dev/null)"

# No neohive tools used — allow stop
[ -z "$LAST_TOOL" ] && printf '{"continue":true}\n' && exit 0

# Already listening/registering — allow stop
case "$LAST_TOOL" in
  mcp__neohive__listen|mcp__neohive__register|mcp__neohive__listen_codex|mcp__neohive__listen_group)
    printf '{"continue":true}\n'
    exit 0 ;;
esac

# Check for pending messages for this agent
PENDING_MSGS=""
if [ "$AGENT_NAME" != "unknown" ] && [ -f "$NEOHIVE_DIR/messages.jsonl" ]; then
  PENDING_MSGS=$(python3 - "$NEOHIVE_DIR/messages.jsonl" "$NEOHIVE_DIR/consumed-${AGENT_NAME}.json" "$AGENT_NAME" <<'PYEOF'
import sys, json

msg_file, consumed_file, agent = sys.argv[1], sys.argv[2], sys.argv[3]

consumed = set()
try:
    with open(consumed_file) as f:
        consumed = set(json.load(f))
except: pass

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
                if m.get('system'): continue
                pending.append(m)
            except: pass
except: pass

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

# ── Case 1: Pending messages — inject them and block stop ─────────────────────
if [ -n "$PENDING_MSGS" ]; then
  MSG_COUNT=$(echo "$PENDING_MSGS" | wc -l | tr -d ' ')

  # Report to dashboard
  curl -s -X POST "${NEOHIVE_URL}/api/inject" \
    -H "Content-Type: application/json" \
    -d "$(printf '{"from":"%s","to":"__user__","content":"[PUSH DELIVERY] %s has %s pending message(s) — injecting into Cursor context.","priority":"normal"}' \
      "$AGENT_NAME" "$AGENT_NAME" "$MSG_COUNT")" \
    --max-time 2 > /dev/null 2>&1 || true

  MSGS_ESCAPED=$(echo "$PENDING_MSGS" | python3 -c "import sys; print(sys.stdin.read().replace('\\n',' | '))" 2>/dev/null || echo "$PENDING_MSGS")
  python3 -c "
import json, sys
print(json.dumps({
  'continue': False,
  'agentMessage': 'NEOHIVE — INCOMING MESSAGES FOR ' + sys.argv[1] + ': ' + sys.argv[2] + ' — Call listen() now to consume and respond. Do not stop.'
}))
" "$AGENT_NAME" "$MSGS_ESCAPED"
  exit 0
fi

# ── Case 2: No pending messages but last tool wasn't listen ───────────────────
curl -s -X POST "${NEOHIVE_URL}/api/inject" \
  -H "Content-Type: application/json" \
  -d "$(printf '{"from":"%s","to":"__user__","content":"[STOP HOOK] %s stopping without listen(). Last tool: %s.","priority":"low"}' \
    "$AGENT_NAME" "$AGENT_NAME" "$LAST_TOOL")" \
  --max-time 2 > /dev/null 2>&1 || true

python3 -c "
import json
print(json.dumps({
  'continue': False,
  'agentMessage': 'NEOHIVE PROTOCOL: You must call listen() before stopping. No pending messages now, but you must stay in the receive loop. Call listen() — it returns immediately with retry:true if nothing arrives.'
}))
"
exit 0
