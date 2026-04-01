#!/usr/bin/env bash
# neohive-agent-wrap.sh — wrap a CLI agent to capture output to a JSONL log file.
# Usage: neohive-agent-wrap.sh <agentName> <cmd> [args...]
# The VS Code extension watches the log file and forwards output to the dashboard.
#
# Example:
#   neohive-agent-wrap.sh ClaudeBackend claude --dangerously-skip-permissions

set -euo pipefail

if [ $# -lt 2 ]; then
  echo "Usage: $0 <agentName> <cmd> [args...]" >&2
  exit 1
fi

AGENT_NAME="$1"; shift
DATA_DIR="${NEOHIVE_DATA_DIR:-.neohive}"
LOG_FILE="$DATA_DIR/agent-log-${AGENT_NAME}.jsonl"

mkdir -p "$DATA_DIR"

"$@" 2>&1 | while IFS= read -r line; do
  TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  # Escape backslashes then double-quotes for JSON string encoding
  ENCODED=$(printf '%s' "$line" | sed 's/\\/\\\\/g; s/"/\\"/g; s/	/\\t/g')
  printf '{"ts":"%s","agent":"%s","data":"%s"}\n' "$TS" "$AGENT_NAME" "$ENCODED" >> "$LOG_FILE"
done
