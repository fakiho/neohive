#!/bin/bash
# PostToolUse hook: log Neohive MCP tool calls for activity analytics
# Runs async — does not block tool execution
# Input: JSON via stdin with tool_name, tool_input, tool_response

INPUT=$(cat)
TOOL_NAME=$(echo "$INPUT" | jq -r '.tool_name // "unknown"' 2>/dev/null)
NEOHIVE_DIR="${CLAUDE_PROJECT_DIR}/.neohive"
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

# Only log if neohive data dir exists
if [ -d "$NEOHIVE_DIR" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  INPUT_SIZE=$(echo "$INPUT" | jq -r '.tool_input | tostring | length' 2>/dev/null || echo "0")
  OUTPUT_SIZE=$(echo "$INPUT" | jq -r '.tool_response | tostring | length' 2>/dev/null || echo "0")

  # Extract agent name from tool response if available
  AGENT=$(echo "$INPUT" | jq -r '.tool_response.from // .tool_input.name // empty' 2>/dev/null)

  echo "{\"tool\":\"$TOOL_NAME\",\"timestamp\":\"$TIMESTAMP\",\"input_size\":$INPUT_SIZE,\"output_size\":$OUTPUT_SIZE,\"agent\":\"${AGENT:-unknown}\",\"session\":\"${CLAUDE_SESSION_ID:-unknown}\"}" >> "$ACTIVITY_FILE"
fi

exit 0
