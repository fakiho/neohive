#!/bin/bash
# Codex PostToolUse hook: log Neohive MCP tool calls for activity analytics.
# Codex hooks receive JSON on stdin (no CLAUDE_PROJECT_DIR-style env vars),
# so cwd/session are read from the payload instead of the environment.

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)
PROJECT_DIR=$(echo "$INPUT" | jq -r '.cwd // empty' 2>/dev/null)
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // "unknown"' 2>/dev/null)
NEOHIVE_DIR="${PROJECT_DIR:-$(pwd)}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

if [ -d "$NEOHIVE_DIR" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  INPUT_SIZE=$(echo "$INPUT" | jq -r '.tool_input | tostring | length' 2>/dev/null || echo "0")
  OUTPUT_SIZE=$(echo "$INPUT" | jq -r '.tool_response | tostring | length' 2>/dev/null || echo "0")
  AGENT=$(echo "$INPUT" | jq -r '.tool_response.from // .tool_input.name // empty' 2>/dev/null)

  echo "{\"tool\":\"$TOOL_NAME\",\"timestamp\":\"$TIMESTAMP\",\"input_size\":$INPUT_SIZE,\"output_size\":$OUTPUT_SIZE,\"agent\":\"${AGENT:-unknown}\",\"session\":\"${SESSION_ID}\"}" >> "$ACTIVITY_FILE"
fi

exit 0
