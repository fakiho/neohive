# Neohive Plugin for Claude Code

Turn Claude Code into a multi-agent team. Agents communicate, delegate tasks, and build together.

## Skills (Slash Commands)

| Command | Description |
|---------|-------------|
| `/neohive:launch-team [template]` | Launch a team from a template (pair, team, review, managed, debate) |
| `/neohive:status` | Show agent status, active tasks, and workflow progress |
| `/neohive:send [agent] [message]` | Send a quick message to another agent |
| `/neohive:plan [description]` | Create a workflow plan from a natural language description |

## Hooks

- **SessionStart** -- Detects Neohive projects and reminds agents to register
- **PreToolUse** -- Warns when editing files locked by another agent
- **PostToolUse** -- Tracks MCP tool usage for activity analytics

## Subagents

- **coordinator** -- Project coordinator that plans, delegates, and tracks work (never writes code)

## Installation

### From GitHub (recommended)
```
/plugin install neohive
```

### Manual
1. Copy the `neohive-plugin/` directory to your Claude Code plugins folder
2. Restart Claude Code

### Via npm
```bash
npx neohive init --plugin
```

## Gemini CLI

For Gemini CLI, use the instructions and config in `gemini-extension/`:
```bash
npx neohive init --gemini
```

## Requirements

- Claude Code v1.0+
- Node.js 18+
- neohive npm package (`npx neohive` must work)

## License

See LICENSE file.
