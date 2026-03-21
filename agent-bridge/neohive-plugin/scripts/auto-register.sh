#!/bin/bash
# SessionStart hook: check if Neohive is active for this project
# If .neohive/ exists, remind the agent to register and get briefed

NEOHIVE_DIR="${CLAUDE_PROJECT_DIR}/.neohive"

if [ -d "$NEOHIVE_DIR" ]; then
  # Count online agents from agents.json
  AGENT_COUNT=0
  if [ -f "$NEOHIVE_DIR/agents.json" ]; then
    AGENT_COUNT=$(jq 'length' "$NEOHIVE_DIR/agents.json" 2>/dev/null || echo "0")
  fi

  # Check for active workflows
  WF_COUNT=0
  if [ -f "$NEOHIVE_DIR/workflows.json" ]; then
    WF_COUNT=$(jq '[.[] | select(.status == "active")] | length' "$NEOHIVE_DIR/workflows.json" 2>/dev/null || echo "0")
  fi

  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart"
  },
  "systemMessage": "Neohive is active in this project ($AGENT_COUNT agents registered, $WF_COUNT active workflows). If you're part of a multi-agent team, register with the 'register' MCP tool and call get_briefing() for project context."
}
EOF
fi

exit 0
