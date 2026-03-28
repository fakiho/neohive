> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# CLI Reference

All commands are invoked via `npx neohive <command>` or `neohive <command>`.

## init

Auto-detect installed CLIs and configure MCP.

```bash
npx neohive init [options]
```

| Flag | Description |
|------|-------------|
| `--claude` | Configure for Claude Code only |
| `--gemini` | Configure for Gemini CLI only |
| `--codex` | Configure for Codex CLI only |
| `--all` | Configure for all detected CLIs |
| `--ollama` | Set up Ollama local LLM bridge |
| `--template T` | Initialize with a team template (`pair`, `team`, `review`, `debate`, `managed`) |

**What it does:**
- Creates `.neohive/` directory in the project root
- Writes CLI-specific MCP configuration:
  - **Claude Code:** `.mcp.json` in project root
  - **Gemini CLI:** `.gemini/settings.json`
  - **Codex CLI:** `.codex/config.toml`
  - **Ollama:** `.neohive/ollama-agent.js` bridge script

**CLI detection logic:**
- Claude Code: `~/.claude/` directory exists
- Gemini CLI: `~/.gemini/` directory exists or `$GEMINI_API_KEY` is set
- Codex CLI: `~/.codex/` directory exists
- Ollama: `ollama --version` command succeeds

## mcp

Start the MCP server on **stdio** (what IDE MCP configs invoke).

```bash
npx neohive mcp
```

## serve

Start an optional **HTTP** MCP server (default port **4321**; use `--port` to override). Prefer `mcp` for normal IDE integration.

```bash
npx neohive serve
npx neohive serve --port 8080
```

## dashboard

Launch the web dashboard.

```bash
npx neohive dashboard [options]
```

| Flag | Description |
|------|-------------|
| `--lan` | Bind to `0.0.0.0` for LAN access |

## templates

List available team templates.

```bash
npx neohive templates
```

## reset

Clear all conversation data (auto-archives first).

```bash
npx neohive reset --force
```

Requires `--force` flag to confirm.

## msg

Send a message directly from the CLI.

```bash
npx neohive msg <agent> <text>
```

Messages appear as sent from "CLI".

## status

Show active agents, message count, active workflows, and in-progress tasks.

```bash
npx neohive status
```

## doctor

Run diagnostic health checks.

```bash
npx neohive doctor
```

Checks: data directory, server.js, agent status, MCP configuration, stale locks.

## uninstall

Remove neohive configuration from all CLI configs.

```bash
npx neohive uninstall
```

## help

Show usage information.

```bash
npx neohive help
```
