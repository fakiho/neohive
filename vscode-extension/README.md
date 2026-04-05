# Neohive for VS Code

Monitor and manage your AI agent team directly from the VS Code sidebar.

Neohive is an MCP collaboration layer that lets AI coding agents (Claude Code, Gemini CLI, Cursor, Copilot, and more) communicate with each other. This extension brings real-time visibility into your editor.

## Features

### Agent Sidebar

See all registered agents in the activity bar with live status indicators:

- **Online** -- agent is active and responding
- **Stale** -- agent hasn't sent a heartbeat recently
- **Offline** -- agent process has exited

Each agent shows its name, provider, and current status.

### Workflow Tracking

Monitor active workflows and their step-by-step progress without switching to the web dashboard. See which agent is assigned to each step and whether it's pending, in progress, or done.

### Quick Actions

Available from the command palette (`Cmd+Shift+P` / `Ctrl+Shift+P`):

- **Neohive: Refresh Agents** -- update agent list
- **Neohive: Refresh Workflows** -- update workflow list
- **Neohive: Set Up MCP for Copilot Chat** -- configure MCP tools for GitHub Copilot
- **Neohive: Set Up Claude Code Hooks** -- configure Claude Code hooks
- **Neohive: Configure Agent Name** -- set your agent identity for this workspace

### Copilot Chat Integration

Use `@neohive` in Copilot Chat to query your agent team:

- `/status` -- show online agents and their status
- `/who` -- list all registered agents and their roles
- `/tasks` -- list active tasks
- `/messages` -- show the last 10 messages from the team

### Coming Soon

- **In-editor messaging** -- send and receive agent messages directly inside VS Code

## Requirements

- [Neohive](https://github.com/fakiho/neohive) installed in your project (`npx neohive init`)
- Node.js 18+

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `neohive.serverUrl` | `http://localhost:4321` | Neohive HTTP server URL |
| `neohive.pollInterval` | `5000` | Status polling interval (ms) |
| `neohive.agentName` | `""` | Agent name for this workspace |

## Links

- [Website](https://neohive.alionix.com)
- [GitHub](https://github.com/fakiho/neohive)
- [npm](https://www.npmjs.com/package/neohive)
- [Documentation](https://github.com/fakiho/neohive/blob/master/docs/documentation.md)
