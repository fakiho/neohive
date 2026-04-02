#!/bin/bash
# PostToolUse hook — three jobs:
#   1. send_message → __user__: echo message content as a systemMessage in chat,
#      and send the last assistant chat turn as report context to the dashboard.
#   2. File edits: fire-and-forget report to dashboard.
#   3. Task updates: fire-and-forget report to dashboard.
#
# Works with both Claude Code (mcp__neohive__*) and Cursor (MCP:*) tool name formats.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)
NEOHIVE_DIR="${CLAUDE_PROJECT_DIR:-$(pwd)}/.neohive"
NEOHIVE_URL="${NEOHIVE_SERVER_URL:-http://localhost:4321}"

[ -d "$NEOHIVE_DIR" ] || exit 0

# Normalize: strip "MCP:" or "mcp__<server>__" prefix → bare tool name
BARE=$(echo "$TOOL_NAME" | sed 's/^MCP://; s/^mcp__[^_]*__//')

# Resolve agent name from response or env
AGENT=$(echo "$INPUT" | jq -r '.tool_response.from // empty' 2>/dev/null)
[ -z "$AGENT" ] && AGENT="${CLAUDE_AGENT_NAME:-unknown}"

# ── Helper: extract last assistant text turn from the transcript JSONL ────────
last_chat_text() {
  local transcript
  transcript=$(echo "$INPUT" | jq -r '.transcript_path // empty' 2>/dev/null)
  [ -z "$transcript" ] && return
  [ -f "$transcript" ] || return

  # Use python3 (always available on macOS/Linux) to walk backward through the
  # JSONL and find the last assistant turn that has a text content block.
  # role is at the top level; content is inside .message.content or .content.
  python3 - "$transcript" <<'PYEOF'
import sys, json

path = sys.argv[1]
with open(path, 'rb') as f:
    lines = f.read().splitlines()

for line in reversed(lines):
    try:
        obj = json.loads(line)
    except Exception:
        continue
    role = obj.get('role') or (obj.get('message') or {}).get('role', '')
    if role != 'assistant':
        continue
    content = (obj.get('message') or {}).get('content') or obj.get('content') or []
    if not isinstance(content, list):
        continue
    for block in content:
        if isinstance(block, dict) and block.get('type') == 'text':
            text = block.get('text', '').strip()
            if text:
                # Truncate to 500 chars so the JSON payload stays manageable
                print(text[:500], end='')
                sys.exit(0)
PYEOF
}

case "$BARE" in
  # ── send_message to __user__ ────────────────────────────────────────────────
  send_message)
    TO=$(echo "$INPUT" | jq -r '.tool_input.to // ""' 2>/dev/null)
    CONTENT=$(echo "$INPUT" | jq -r '.tool_input.content // ""' 2>/dev/null)

    if [ "$TO" = "__user__" ] && [ -n "$CONTENT" ]; then
      # Inject into chat as systemMessage
      CONTENT_ESC=$(echo "$CONTENT" | sed 's/"/\\"/g; s/$/\\n/' | tr -d '\n')
      printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse"},"systemMessage":"[Neohive → you] %s"}\n' \
        "$CONTENT_ESC"

      # Also send last chat turn as context to the dashboard
      LAST_CHAT=$(last_chat_text)
      if [ -n "$LAST_CHAT" ]; then
        LAST_ESC=$(printf '%s' "$LAST_CHAT" | sed 's/"/\\"/g')
        REPORT="[REPORT] ${AGENT} sent message. Last chat turn: ${LAST_ESC}"
        REPORT_ESC=$(printf '%s' "$REPORT" | sed 's/"/\\"/g')
        curl -s -X POST "${NEOHIVE_URL}/api/inject" \
          -H "Content-Type: application/json" \
          -d "{\"from\":\"${AGENT}\",\"to\":\"__user__\",\"content\":\"${REPORT_ESC}\",\"priority\":\"normal\"}" \
          --max-time 2 \
          > /dev/null 2>&1 || true
      fi
    fi
    exit 0
    ;;

  # ── File edits ───────────────────────────────────────────────────────────────
  Edit|Write|MultiEdit)
    FILE=$(echo "$INPUT" | jq -r \
      '.tool_input.file_path // .tool_input.file // "unknown"' 2>/dev/null)
    FILE="${FILE#$CLAUDE_PROJECT_DIR/}"
    MSG="[POST-TOOL] ${AGENT} edited: ${FILE}"
    ;;

  # ── Task status updates ──────────────────────────────────────────────────────
  update_task)
    TASK_ID=$(echo "$INPUT" | jq -r '.tool_input.task_id // "?"' 2>/dev/null)
    STATUS=$(echo "$INPUT" | jq -r '.tool_input.status // "?"' 2>/dev/null)
    MSG="[POST-TOOL] ${AGENT} updated task ${TASK_ID} → ${STATUS}"
    ;;

  *)
    exit 0
    ;;
esac

[ -z "$MSG" ] && exit 0

MSG_ESCAPED=$(printf '%s' "$MSG" | sed 's/"/\\"/g')
curl -s -X POST "${NEOHIVE_URL}/api/inject" \
  -H "Content-Type: application/json" \
  -d "{\"from\":\"${AGENT}\",\"to\":\"__user__\",\"content\":\"${MSG_ESCAPED}\",\"priority\":\"normal\"}" \
  --max-time 2 \
  > /dev/null 2>&1 || true

exit 0
