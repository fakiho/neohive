#!/bin/bash
# SessionStart hook: check if Neohive is active for this project.
# Outputs a dynamic context message — no hardcoded agent names.

NEOHIVE_DIR="${CLAUDE_PROJECT_DIR}/.neohive"

if [ -d "$NEOHIVE_DIR" ]; then
  # Count registered agents
  AGENT_COUNT=0
  AGENT_NAMES=""
  if [ -f "$NEOHIVE_DIR/agents.json" ]; then
    AGENT_COUNT=$(jq 'length' "$NEOHIVE_DIR/agents.json" 2>/dev/null || echo "0")
    # List alive agent names (dynamic — no hardcoding)
    AGENT_NAMES=$(jq -r '[to_entries[] | select(.value.alive == true) | .key] | join(", ")' \
      "$NEOHIVE_DIR/agents.json" 2>/dev/null || echo "")
  fi

  # Count active workflows
  WF_COUNT=0
  if [ -f "$NEOHIVE_DIR/workflows.json" ]; then
    WF_COUNT=$(jq '[.[] | select(.status == "active")] | length' \
      "$NEOHIVE_DIR/workflows.json" 2>/dev/null || echo "0")
  fi

  # Count pending tasks
  PENDING_TASKS=0
  if [ -f "$NEOHIVE_DIR/tasks.json" ]; then
    PENDING_TASKS=$(jq '[.[] | select(.status == "pending" or .status == "in_progress")] | length' \
      "$NEOHIVE_DIR/tasks.json" 2>/dev/null || echo "0")
  fi

  # Build the names hint (show only if agents are online)
  NAMES_HINT=""
  if [ -n "$AGENT_NAMES" ]; then
    NAMES_HINT=" Online agents: $AGENT_NAMES."
  fi

  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart"
  },
  "systemMessage": "Neohive is active ($AGENT_COUNT agents registered, $WF_COUNT active workflows, $PENDING_TASKS pending/in-progress tasks).$NAMES_HINT\n\nTo join: call register() with the name you were assigned, then get_briefing(), then listen(). Do NOT invent a name — the user or Coordinator will tell you which name to use."
}
EOF
fi

exit 0
