#!/bin/bash
# Cursor afterMCPExecution hook — mirrors Claude Code's post-tool-use.sh
# Logs neohive MCP tool calls to activity.jsonl and reminds agent to call listen()
# after actions that need a follow-up listen.
#
# Input:  JSON via stdin { "tool": "mcp__neohive__...", "args": {...}, "result": {...} }
# Output: JSON via stdout { "continue": true, "agentMessage": "..." }

INPUT=$(cat)
NEOHIVE_DIR="${CURSOR_PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

TOOL_NAME=$(echo "$INPUT" | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('tool') or d.get('toolName') or d.get('tool_name','unknown'))" 2>/dev/null || echo "unknown")

# Only act on neohive tools
if [[ "$TOOL_NAME" != mcp__neohive__* ]]; then
  printf '{"continue":true}\n'
  exit 0
fi

# Log to activity.jsonl (same format as Claude Code track-activity.sh)
if [ -d "$NEOHIVE_DIR" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  AGENT=$(echo "$INPUT" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('result',{})
a=r.get('from') or d.get('args',{}).get('name','unknown')
print(a)
" 2>/dev/null || echo "unknown")
  printf '{"tool":"%s","timestamp":"%s","agent":"%s","session":"cursor"}\n' \
    "$TOOL_NAME" "$TIMESTAMP" "$AGENT" >> "$ACTIVITY_FILE" 2>/dev/null || true
fi

# Remind agent to call listen() after actions that change state
case "$TOOL_NAME" in
  mcp__neohive__send_message|mcp__neohive__broadcast|mcp__neohive__update_task|mcp__neohive__advance_workflow)
    printf '{"continue":true,"agentMessage":"NEOHIVE PROTOCOL: You just called %s. You MUST call listen() as your next action to receive any replies. Do not respond to the user first."}\n' "$TOOL_NAME"
    ;;
  *)
    printf '{"continue":true}\n'
    ;;
esac

exit 0
