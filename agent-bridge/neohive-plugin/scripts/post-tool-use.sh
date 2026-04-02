#!/bin/bash
# PostToolUse hook: report significant tool actions to neohive via /api/inject.
# Covers file edits and task updates — complements track-activity.sh (which logs locally).
# Async + fire-and-forget: never blocks tool execution.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)
NEOHIVE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.neohive"
NEOHIVE_URL="${NEOHIVE_SERVER_URL:-http://localhost:4321}"

# Not a neohive project — skip
[ -d "$NEOHIVE_DIR" ] || exit 0

# Resolve agent name: prefer response field, fall back to env
AGENT=$(echo "$INPUT" | jq -r '.tool_response.from // empty' 2>/dev/null)
[ -z "$AGENT" ] && AGENT="${CLAUDE_AGENT_NAME:-unknown}"

MSG=""

case "$TOOL_NAME" in
  # File edits — report which file was changed
  Edit|Write|MultiEdit)
    FILE=$(echo "$INPUT" | jq -r \
      '.tool_input.file_path // .tool_input.file // "unknown"' 2>/dev/null)
    # Strip workspace prefix for brevity
    FILE="${FILE#$CLAUDE_PROJECT_DIR/}"
    MSG="[POST-TOOL] ${AGENT} edited: ${FILE}"
    ;;

  # Task status updates — report task ID and new status
  mcp__neohive__update_task)
    TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // "?"' 2>/dev/null)
    STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // "?"' 2>/dev/null)
    MSG="[POST-TOOL] ${AGENT} updated task ${TASK_ID} → ${STATUS}"
    ;;

  # All other tools — skip (track-activity.sh handles general logging)
  *)
    exit 0
    ;;
esac

[ -z "$MSG" ] && exit 0

# Escape for JSON inline
MSG_ESCAPED=$(printf '%s' "$MSG" | sed 's/"/\\"/g')

curl -s -X POST "${NEOHIVE_URL}/api/inject" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"${AGENT}\",\"to\":\"__user__\",\"content\":\"${MSG_ESCAPED}\",\"priority\":\"normal\"}" \
  --max-time 2 \
  > /dev/null 2>&1 || true

exit 0
