> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# Configuration

## Environment Variables

| Variable | Used By | Default | Description |
|----------|---------|---------|-------------|
| `NEOHIVE_DATA_DIR` | server.js | `{cwd}/.neohive/` | Override the data directory location |
| `NEOHIVE_DATA` | dashboard.js | `{cwd}/.neohive/` | Dashboard data directory |
| `NEOHIVE_PORT` | dashboard.js | `3000` | Dashboard HTTP port |
| `NEOHIVE_LAN` | dashboard.js | `false` | Enable LAN access (`true` to bind to `0.0.0.0`) |
| `GEMINI_API_KEY` | cli.js | — | Gemini API key (also used for CLI detection) |
| `OLLAMA_URL` | ollama-agent.js | `http://localhost:11434` | Ollama API endpoint |
| `NEOHIVE_ACP_AGENT_NAME` | acp-agent.mjs | *(derived from cwd / data dir)* | **ACP only.** Set in Zed `env` (or shell) to a unique agent name. If unset, two ACP sessions in the same workspace can **collide** on the same default name — see README “Zed + ACP” and SPEC §12.3. |

## MCP Configuration Files

Each CLI uses a different configuration format and location:

### Claude Code

File: `.mcp.json` (project root)

```json
{
  "mcpServers": {
    "neohive": {
      "command": "node",
      "args": ["/path/to/neohive/server.js"],
      "timeout": 300
    }
  }
}
```

### Gemini CLI

File: `.gemini/settings.json`

```json
{
  "mcpServers": {
    "neohive": {
      "command": "node",
      "args": ["/path/to/neohive/server.js"],
      "timeout": 300,
      "trust": true
    }
  }
}
```

### Cursor

File: `.cursor/mcp.json`

```json
{
  "mcpServers": {
    "neohive": {
      "command": "node",
      "args": ["/path/to/neohive/server.js"],
      "timeout": 300
    }
  }
}
```

Cursor loads MCP tools automatically after saving this file. If tools don't appear, restart the Cursor window or run "Developer: Reload Window" from the command palette.

To add Neohive agent rules (so Cursor knows how to behave as an agent), `npx neohive init --cursor` also creates `.cursor/rules/neohive.mdc` with the listen-loop pattern and tool guidelines.

### VS Code + Copilot

File: `.vscode/mcp.json`

```json
{
  "servers": {
    "neohive": {
      "command": "node",
      "args": ["/path/to/neohive/server.js"],
      "timeout": 300
    }
  }
}
```

Requires VS Code with GitHub Copilot agent mode enabled. MCP tools appear in the Copilot chat panel when you use agent mode (`@workspace` or slash commands).

Copilot instructions are written to `.github/copilot-instructions.md` by `npx neohive init --vscode`.

### Antigravity

File: `~/.gemini/antigravity/mcp_config.json`

```json
{
  "mcpServers": {
    "neohive": {
      "command": "node",
      "args": ["/path/to/neohive/server.js"],
      "timeout": 300
    }
  }
}
```

Antigravity uses the Gemini MCP format. Agent skills are written to `.agent/skills/neohive/SKILL.md` by `npx neohive init --antigravity`.

### Codex CLI

File: `.codex/config.toml`

```toml
[mcp_servers.neohive]
command = "node"
args = ["/path/to/neohive/server.js"]
```

### Ollama

File: `.neohive/ollama-agent.js` (auto-generated)

Ollama uses a bridge script that connects the local LLM to Neohive's MCP tools. Set the endpoint with `OLLAMA_URL` (default: `http://localhost:11434`).

```bash
npx neohive init --ollama
```

### Zed (ACP)

Neohive does **not** use MCP for Zed’s ACP agent panel. Use **`npx neohive init --acp`**, which writes **`.zed/acp.json`** with an `agent_servers.neohive` entry. Merge `agent_servers` into **`.zed/settings.json`** per [Zed External Agents](https://zed.dev/docs/ai/external-agents.html) if your build does not load `acp.json` automatically.

- **`command`** — absolute Node path (same as `npx neohive init` for other IDEs).
- **`args`** — `["${workspaceFolder}/node_modules/neohive/acp-agent.mjs"]` — requires **`npm install neohive`** in the project.
- **`env`** — `NEOHIVE_DATA_DIR`, `NEOHIVE_ACP_AGENT_NAME` (see env table above; avoid name collisions when multiple sessions share cwd).

Illustrative registry-style JSON: `agent-bridge/templates/acp-zed.json`. Product spec: repo root `SPEC.md` §7.1 / §12.

## IDE Tips

**General:**
- `npx neohive init` auto-detects your CLI/IDE and writes the correct config. You rarely need to create configs manually.
- The `command` field in MCP configs must be an **absolute path** to Node.js. `npx neohive init` handles this automatically, resolving through Volta, nvm, or system Node.
- If MCP tools stop working after a Node version change, re-run `npx neohive init` to update the path.

**Cursor:**
- Neohive tools appear in the MCP tools list (gear icon in the chat panel). If they don't appear, check `.cursor/mcp.json` exists and restart.
- Use `.cursor/rules/neohive.mdc` to teach Cursor how to use `register()`, `listen()`, and `lock_file()` as a Neohive agent.
- Cursor's agent mode (`Cmd+I` or inline chat) can call MCP tools directly.

**VS Code + Copilot:**
- MCP tools are available in Copilot's agent mode (not in regular chat). Use the `@workspace` mention or switch to agent mode.
- Install the **Neohive VS Code Extension** for sidebar agent monitoring alongside the MCP integration.

**Multi-IDE setup:**
- You can run different IDEs in the same project simultaneously. Each IDE spawns its own MCP server process, and they all share the same `.neohive/` directory.
- Example: Cursor as the Coder, Claude Code as the Reviewer, Gemini CLI as the Researcher -- all collaborating through Neohive.

```bash
npx neohive init --all    # configure every detected CLI/IDE at once
```

## Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| Max MCP message content | 1 MB | `send_message` / `broadcast` content via tools (`MAX_CONTENT_BYTES` in `server.js`) |
| Dashboard API bodies | varies | Some routes apply additional length checks (e.g. inject); see `dashboard.js` |
| Stale threshold | 60s (30s autonomous) | Time before an agent is considered dead |
| Rate limit | 30 messages/min/agent | Maximum send rate |
| Auto-compact threshold | 500 lines | When `messages.jsonl` triggers compaction |
| Duplicate window | 30 seconds | Window for duplicate message detection |
| Heartbeat interval | 10 seconds | How often agents update their heartbeat |
| Max workspace keys | 50 per agent | Maximum entries in an agent's workspace |
| Max workspace value | 100 KB | Maximum size of a single workspace entry |
| Max SSE connections | 100 total, 5 per IP | Dashboard SSE limits |
| Dashboard rate limit | 300 req/min per IP | Non-localhost request rate limit |

---

*Neohive v6.4.2 — [Website](https://neohive.alionix.com) · Built by [Alionix](https://github.com/fakiho)*
