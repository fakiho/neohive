#!/bin/bash
# Stop hook: block agent from stopping if last neohive action wasn't listen()
# Filters by CLAUDE_SESSION_ID so each agent's session is checked independently.
# Exit 2 = block stop (forces Claude to continue and call listen)
# Exit 0 = allow stop

NEOHIVE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"
SESSION="${CLAUDE_SESSION_ID:-}"

# Not a neohive project — allow stop
[ -f "$ACTIVITY_FILE" ] || exit 0

# Get the last neohive tool used in THIS session
LAST_TOOL=$(tail -100 "$ACTIVITY_FILE" 2>/dev/null | python3 -c "
import sys, json, os
session = os.environ.get('CLAUDE_SESSION_ID', '')
last = None
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try:
        entry = json.loads(line)
        # If session ID is available, filter to this session only
        if session and entry.get('session', '') != session:
            continue
        tool = entry.get('tool', '')
        if tool.startswith('mcp__neohive__'):
            last = tool
    except:
        pass
print(last or '')
" 2>/dev/null)

# No neohive tools used in this session — allow stop
[ -z "$LAST_TOOL" ] && exit 0

# Last action was listen/register — agent is in listen mode, allow stop
case "$LAST_TOOL" in
  mcp__neohive__listen|mcp__neohive__listen_codex|mcp__neohive__listen_group|mcp__neohive__register)
    exit 0
    ;;
esac

# Last neohive action was something other than listen — block stop
cat <<'EOF'

⚠️  NEOHIVE — REQUIRED ACTION BEFORE STOPPING:

Your last neohive action was not listen(). You MUST call listen() before stopping.
This keeps you in the receive loop for your next task.

→ Call: listen()

Do not respond with text. Call listen() now.
EOF
exit 2
