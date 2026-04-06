#!/bin/bash
# Stop hook: block agent from stopping if last neohive action wasn't listen()
# Also auto-reports to coordinator via /api/inject when blocking.
# Exit 2 = block stop (forces Claude to continue and call listen)
# Exit 0 = allow stop

NEOHIVE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"
SESSION="${CLAUDE_SESSION_ID:-}"
NEOHIVE_URL="${NEOHIVE_SERVER_URL:-http://localhost:4321}"

# Allow exit: no tool calls this session (user cancelled before any tools ran)
LOOP_COUNT="${CLAUDE_LOOP_COUNT:-0}"
[ "$LOOP_COUNT" = "0" ] && exit 0

# Allow exit: user aborted — agent had no chance to call listen()
STOP_STATUS="${CLAUDE_STOP_HOOK_STATUS:-}"
[ "$STOP_STATUS" = "aborted" ] && exit 0

# Not a neohive project — allow stop
[ -f "$ACTIVITY_FILE" ] || exit 0

# Get the last neohive tool used in THIS session
LAST_TOOL=$(tail -100 "$ACTIVITY_FILE" 2>/dev/null | jq -r --arg session "$SESSION" '
  select(.session == $session or $session == "") | .tool
' | grep "^mcp__neohive__" | tail -1)

# No neohive tools used in this session — allow stop
[ -z "$LAST_TOOL" ] && exit 0

# Look up agent name from the last activity
AGENT_NAME=$(tail -100 "$ACTIVITY_FILE" 2>/dev/null | jq -r --arg session "$SESSION" '
  select(.session == $session or $session == "") | .agent
' | tail -1)
AGENT="${AGENT_NAME:-unknown}"

# All roles must call listen() — no exemptions

# Last action was listen/register/rules management — allow stop
case "$LAST_TOOL" in
  mcp__neohive__listen|\
  mcp__neohive__register|\
  mcp__neohive__add_rule|mcp__neohive__remove_rule|mcp__neohive__toggle_rule)
    exit 0
    ;;
esac

# Last neohive action was something other than listen — report + block

# Auto-report to coordinator via neohive /api/inject (HTTP equivalent of send_message)
# Fire-and-forget: don't fail if dashboard isn't running
PAYLOAD=$(printf '{"from":"%s","to":"__user__","content":"[STOP HOOK] %s attempted to stop without calling listen(). Last tool: %s. Blocking stop — agent will be prompted to call listen() now.","priority":"normal"}' \
  "$AGENT" "$AGENT" "$LAST_TOOL")
curl -s -X POST "${NEOHIVE_URL}/api/inject" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" \
  --max-time 2 \
  > /dev/null 2>&1 || true

cat <<'EOF'

⚠️  NEOHIVE — REQUIRED ACTION BEFORE STOPPING:

Your last neohive action was not listen(). You MUST call listen() before stopping.
This keeps you in the receive loop for your next task.
Your coordinator has been notified via the dashboard.

→ Call: listen()

Do not respond with text. Call listen() now.
EOF
exit 2
