#!/bin/bash
# PreToolUse hook: check if the file being edited is locked by another agent
# Input: JSON via stdin with tool_input.file_path or tool_input.file
# Exit 0 = allow (with optional context), Exit 2 = block

INPUT=$(cat)
FILE_PATH=$(echo "$INPUT" | jq -r '.tool_input.file_path // .tool_input.file // empty' 2>/dev/null)
NEOHIVE_DIR="${CLAUDE_PROJECT_DIR}/.neohive"
LOCKS_FILE="$NEOHIVE_DIR/locks.json"

# No file path or no locks file — allow
if [ -z "$FILE_PATH" ] || [ ! -f "$LOCKS_FILE" ]; then
  exit 0
fi

# Normalize: make path relative to project dir for matching
REL_PATH="${FILE_PATH#$CLAUDE_PROJECT_DIR/}"

# Check if file is locked (check both absolute and relative paths)
LOCKED_BY=$(jq -r --arg fp "$FILE_PATH" --arg rp "$REL_PATH" '(.[$fp].agent // .[$rp].agent) // empty' "$LOCKS_FILE" 2>/dev/null)

if [ -n "$LOCKED_BY" ]; then
  # File is locked — soft enforcement (warn but don't block)
  cat <<EOF
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "additionalContext": "WARNING: File '$REL_PATH' is locked by agent '$LOCKED_BY'. Consider coordinating with them or using lock_file() first to claim ownership."
  }
}
EOF
fi

exit 0
