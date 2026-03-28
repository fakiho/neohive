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

### Codex CLI

File: `.codex/config.toml`

```toml
[mcp_servers.neohive]
command = "node"
args = ["/path/to/neohive/server.js"]
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

*Neohive v6.0.3 — Built by [Alionix](https://github.com/fakiho/neohive)*
