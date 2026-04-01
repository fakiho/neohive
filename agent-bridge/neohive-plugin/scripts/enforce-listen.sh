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
# Uses jq for robust parsing and filtering
LAST_TOOL=$(tail -100 "$ACTIVITY_FILE" 2>/dev/null | jq -r --arg session "$SESSION" '
  select(.session == $session or $session == "") | .tool
' | grep "^mcp__neohive__" | tail -1)

# No neohive tools used in this session — allow stop
[ -z "$LAST_TOOL" ] && exit 0

# ROLE EXEMPTION: Exempt Coordinator from blocking (they orchestrate multiple agents)
# Look up the agent name from the last activity and check profiles.json
AGENT_NAME=$(tail -100 "$ACTIVITY_FILE" 2>/dev/null | jq -r --arg session "$SESSION" '
  select(.session == $session or $session == "") | .agent
' | tail -1)

if [ -f "$NEOHIVE_DIR/profiles.json" ]; then
  ROLE=$(jq -r --arg name "$AGENT_NAME" '.[$name].role // empty' "$NEOHIVE_DIR/profiles.json")
  if [ "$ROLE" = "Coordinator" ]; then
    exit 0
  fi
fi

# Last action was listen/register/rules management — allow stop
case "$LAST_TOOL" in
  mcp__neohive__listen|mcp__neohive__listen_codex|mcp__neohive__listen_group|\
  mcp__neohive__register|mcp__neohive__consume_messages|\
  mcp__neohive__add_rule|mcp__neohive__remove_rule|mcp__neohive__toggle_rule)
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
