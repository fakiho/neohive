#!/bin/bash
# Cursor beforeSubmitPrompt — inject team status + pending inbox preview.
#
# Input:  hook JSON (workspace_roots, …)
# Output: { "continue": true, "agentMessage": "..." }

set -euo pipefail
INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/cursor_hook_lib.py"

NEOHIVE_DIR=$(printf '%s' "$INPUT" | python3 "$LIB" neohive_dir)
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

[ -d "$NEOHIVE_DIR" ] || { printf '%s\n' '{"continue":true}'; exit 0; }

# Agents "online" = JSON entry with live PID (agents.json has no boolean `alive`)
AGENTS_ONLINE=""
if [ -f "$NEOHIVE_DIR/agents.json" ]; then
  AGENTS_ONLINE=$(NEOHIVE_JSON="$NEOHIVE_DIR/agents.json" python3 -c "
import json, os

def pid_alive(pid):
    if not pid:
        return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, TypeError):
        return False

path = os.environ.get('NEOHIVE_JSON', '')
try:
    with open(path) as f:
        agents = json.load(f)
except OSError:
    print('')
    raise SystemExit

parts = []
for name, info in agents.items():
    if not isinstance(info, dict):
        continue
    p = info.get('pid')
    if pid_alive(p):
        parts.append(f\"{name}(online)\")
print(', '.join(parts[:40]))
" 2>/dev/null || echo "")
fi

[ -z "$AGENTS_ONLINE" ] && printf '%s\n' '{"continue":true}' && exit 0

PENDING_COUNT=0
IN_PROGRESS_COUNT=0
if [ -f "$NEOHIVE_DIR/tasks.json" ]; then
  read -r PENDING_COUNT IN_PROGRESS_COUNT <<< "$(python3 -c "
import json
try:
    tasks = json.load(open('$NEOHIVE_DIR/tasks.json'))
    p = sum(1 for t in tasks if t.get('status')=='pending')
    i = sum(1 for t in tasks if t.get('status')=='in_progress')
    print(p, i)
except OSError:
    print(0, 0)
" 2>/dev/null || echo "0 0")"
fi

AGENT_NAME=""
if [ -f "$ACTIVITY_FILE" ]; then
  AGENT_NAME=$(tail -200 "$ACTIVITY_FILE" 2>/dev/null | python3 -c "
import sys, json
agent = ''
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        e = json.loads(line)
        if e.get('agent') and e['agent'] not in ('unknown', ''):
            agent = e['agent']
    except Exception:
        pass
print(agent)
" 2>/dev/null)
fi

PENDING_MSGS=""
if [ -n "$AGENT_NAME" ] && [ "$AGENT_NAME" != "unknown" ] && [ -f "$NEOHIVE_DIR/messages.jsonl" ]; then
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

parts = []
for m in pending[:3]:
    sender = m.get("from", "?")
    content = (m.get("content") or "").replace("\n", " ").strip()[:300]
    msg_id = m.get("id", "")
    parts.append(f"FROM {sender}: {content} [id:{msg_id}]")
print(" | ".join(parts))
PYEOF
  2>/dev/null)
fi

STATUS_MSG="Neohive team online: ${AGENTS_ONLINE} | Tasks: ${PENDING_COUNT} pending, ${IN_PROGRESS_COUNT} in-progress."
if [ -n "$PENDING_MSGS" ]; then
  FULL_MSG="${STATUS_MSG} INCOMING MESSAGES FOR ${AGENT_NAME}: ${PENDING_MSGS} — call listen() to consume them."
else
  FULL_MSG="${STATUS_MSG} Reminder: after send_message / update_task / broadcast, call listen() before you stop."
fi

python3 -c "
import json, sys
print(json.dumps({'continue': True, 'agentMessage': sys.argv[1]}))
" "$FULL_MSG"

exit 0
