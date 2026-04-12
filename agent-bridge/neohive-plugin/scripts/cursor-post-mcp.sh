#!/bin/bash
# Cursor afterMCPExecution — log neohive MCP calls + inject listen() reminder after mutating tools.
#
# Input:  hook JSON (includes workspace_roots; MCP fields vary by Cursor version)
# Output: JSON { "continue": true, "agentMessage"?: "..." }

set -euo pipefail
INPUT=$(cat)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$SCRIPT_DIR/cursor_hook_lib.py"

TOOL_NAME=$(printf '%s' "$INPUT" | python3 "$LIB" tool_name)
NEOHIVE_DIR=$(printf '%s' "$INPUT" | python3 "$LIB" neohive_dir)
ACTIVITY_FILE="$NEOHIVE_DIR/activity.jsonl"

if [[ "$TOOL_NAME" != mcp__neohive__* ]]; then
  printf '{"continue":true}\n'
  exit 0
fi

NEEDS_REMIND=$(python3 "$LIB" needs_listen "$TOOL_NAME")

AGENT_ID="unknown"
if [[ "$TOOL_NAME" == mcp__neohive__register ]]; then
  AGENT_ID=$(printf '%s' "$INPUT" | python3 "$LIB" register_name)
fi

if [ -d "$NEOHIVE_DIR" ]; then
  TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
  printf '{"tool":"%s","timestamp":"%s","agent":"%s","session":"cursor"}\n' \
    "$TOOL_NAME" "$TIMESTAMP" "$AGENT_ID" >>"$ACTIVITY_FILE" 2>/dev/null || true
fi

if [[ "$NEEDS_REMIND" == "yes" ]]; then
  printf '{"continue":true,"agentMessage":"NEOHIVE PROTOCOL: You just used %s. Call listen() as your NEXT tool invocation before replying to the user or stopping — the hub is async; replies arrive via listen()."}\n' "$TOOL_NAME"
else
  printf '{"continue":true}\n'
fi

exit 0
