#!/bin/bash
# UserPromptSubmit hook: inject live neohive team context + pending messages before every prompt.
# No hardcoded names — all data read dynamically from .neohive/ files.
# Exit 0 always (never blocks the prompt).

NEOHIVE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"
SESSION="${CLAUDE_SESSION_ID:-}"

# Not a neohive project — nothing to inject
[ -d "$NEOHIVE_DIR" ] || exit 0

# Agents: list alive agents with their roles (dynamic, no hardcoded names)
AGENTS_ONLINE=""
if [ -f "$NEOHIVE_DIR/agents.json" ]; then
  AGENTS_ONLINE=$(jq -r '
    [to_entries[]
      | select(.value.alive == true)
      | "\(.key)(\(.value.role // "agent"))"]
    | join(", ")
  ' "$NEOHIVE_DIR/agents.json" 2>/dev/null || echo "")
fi

# Only inject if there is an active team
[ -z "$AGENTS_ONLINE" ] && exit 0

# Task counts
PENDING_COUNT=0
IN_PROGRESS_COUNT=0
if [ -f "$NEOHIVE_DIR/tasks.json" ]; then
  PENDING_COUNT=$(jq '[.[] | select(.status == "pending")] | length' \
    "$NEOHIVE_DIR/tasks.json" 2>/dev/null || echo "0")
  IN_PROGRESS_COUNT=$(jq '[.[] | select(.status == "in_progress")] | length' \
    "$NEOHIVE_DIR/tasks.json" 2>/dev/null || echo "0")
fi

# Resolve agent name for this session from activity log
AGENT_NAME=""
if [ -f "$ACTIVITY_FILE" ]; then
  AGENT_NAME=$(tail -200 "$ACTIVITY_FILE" 2>/dev/null | python3 -c "
import sys, json
session = '$SESSION'
agent = ''
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        e = json.loads(line)
        if session and e.get('session', '') != session and session != '': continue
        if e.get('agent') and e['agent'] not in ('unknown', ''):
            agent = e['agent']
    except: pass
print(agent)
" 2>/dev/null)
fi

# Check for pending messages for this agent
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

# Build system message
AGENTS_ESCAPED=$(printf '%s' "$AGENTS_ONLINE" | sed 's/"/\\"/g')
STATUS_MSG="Neohive team online: $AGENTS_ESCAPED | Tasks: $PENDING_COUNT pending, $IN_PROGRESS_COUNT in-progress."

if [ -n "$PENDING_MSGS" ]; then
  MSGS_ESCAPED=$(printf '%s' "$PENDING_MSGS" | sed 's/"/\\"/g; s/\\/\\\\/g' | tr -d '\n')
  SYSTEM_MSG="$STATUS_MSG INCOMING MESSAGES FOR ${AGENT_NAME}: $MSGS_ESCAPED — call listen() to consume them."
else
  SYSTEM_MSG="$STATUS_MSG Reminder: call listen() after every neohive action."
fi

python3 -c "
import json, sys
print(json.dumps({
    'hookSpecificOutput': {'hookEventName': 'UserPromptSubmit'},
    'systemMessage': sys.argv[1]
}))
" "$SYSTEM_MSG"

exit 0
