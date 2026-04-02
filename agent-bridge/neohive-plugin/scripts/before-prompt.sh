#!/bin/bash
# UserPromptSubmit hook: inject live neohive team context before every prompt.
# No hardcoded names — all data read dynamically from .neohive/ files.
# Exit 0 always (never blocks the prompt).

NEOHIVE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.neohive"

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

# Task counts
PENDING_COUNT=0
IN_PROGRESS_COUNT=0
if [ -f "$NEOHIVE_DIR/tasks.json" ]; then
  PENDING_COUNT=$(jq '[.[] | select(.status == "pending")] | length' \
    "$NEOHIVE_DIR/tasks.json" 2>/dev/null || echo "0")
  IN_PROGRESS_COUNT=$(jq '[.[] | select(.status == "in_progress")] | length' \
    "$NEOHIVE_DIR/tasks.json" 2>/dev/null || echo "0")
fi

# Only inject if there is an active team
[ -z "$AGENTS_ONLINE" ] && exit 0

# Escape for JSON
AGENTS_ESCAPED=$(printf '%s' "$AGENTS_ONLINE" | sed 's/"/\\"/g')

cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "UserPromptSubmit"
  },
  "systemMessage": "Neohive team status: $AGENTS_ESCAPED | Tasks: $PENDING_COUNT pending, $IN_PROGRESS_COUNT in-progress. Reminder: call listen() after every action."
}
EOF

exit 0
