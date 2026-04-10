#!/bin/bash
# Cursor beforeSubmitPrompt hook — mirrors Claude Code's before-prompt.sh
# Injects live team status + pending messages into agent context before every prompt.
#
# Input:  JSON via stdin { "prompt": "..." }
# Output: JSON via stdout { "continue": true, "agentMessage": "..." }

NEOHIVE_DIR="${CURSOR_PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

# Not a neohive project
[ -d "$NEOHIVE_DIR" ] || { printf '{"continue":true}\n'; exit 0; }

# Agents online
AGENTS_ONLINE=""
if [ -f "$NEOHIVE_DIR/agents.json" ]; then
  AGENTS_ONLINE=$(python3 -c "
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    alive = [f'{k}({v.get(\"role\",\"agent\")})' for k,v in d.items() if v.get('alive')]
    print(', '.join(alive))
except: pass
" "$NEOHIVE_DIR/agents.json" 2>/dev/null || echo "")
fi

# No active team — nothing to inject
[ -z "$AGENTS_ONLINE" ] && printf '{"continue":true}\n' && exit 0

# Task counts
PENDING_COUNT=0
IN_PROGRESS_COUNT=0
if [ -f "$NEOHIVE_DIR/tasks.json" ]; then
  read PENDING_COUNT IN_PROGRESS_COUNT <<< "$(python3 -c "
import json
try:
    tasks = json.load(open('$NEOHIVE_DIR/tasks.json'))
    p = sum(1 for t in tasks if t.get('status')=='pending')
    i = sum(1 for t in tasks if t.get('status')=='in_progress')
    print(p, i)
except: print(0, 0)
" 2>/dev/null || echo "0 0")"
fi

# Resolve agent name (most recent active agent from activity log)
AGENT_NAME=""
if [ -f "$ACTIVITY_FILE" ]; then
  AGENT_NAME=$(tail -200 "$ACTIVITY_FILE" 2>/dev/null | python3 -c "
import sys, json
agent = ''
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        if e.get('agent') and e['agent'] not in ('unknown', ''):
            agent = e['agent']
    except: pass
print(agent)
" 2>/dev/null)
fi

# Check for pending messages
PENDING_MSGS=""
if [ -n "$AGENT_NAME" ] && [ "$AGENT_NAME" != "unknown" ] && [ -f "$NEOHIVE_DIR/messages.jsonl" ]; then
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

parts = []
for m in pending[:3]:
    sender = m.get('from', '?')
    content = m.get('content', '').replace('\n', ' ').strip()[:300]
    msg_id = m.get('id', '')
    parts.append(f"FROM {sender}: {content} [id:{msg_id}]")
print(' | '.join(parts))
PYEOF
  2>/dev/null)
fi

# Build agent message
STATUS_MSG="Neohive team online: ${AGENTS_ONLINE} | Tasks: ${PENDING_COUNT} pending, ${IN_PROGRESS_COUNT} in-progress."
if [ -n "$PENDING_MSGS" ]; then
  FULL_MSG="${STATUS_MSG} INCOMING MESSAGES FOR ${AGENT_NAME}: ${PENDING_MSGS} — call listen() to consume them."
else
  FULL_MSG="${STATUS_MSG} Reminder: call listen() after every neohive action."
fi

python3 -c "
import json, sys
print(json.dumps({'continue': True, 'agentMessage': sys.argv[1]}))
" "$FULL_MSG"

exit 0
