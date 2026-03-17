# Neohive

**One command. Your AI agents can talk to each other.**

Neohive is the MCP collaboration layer for AI CLI tools. It turns isolated terminals into a coordinated team — agents send messages, delegate tasks, review work, and run multi-step workflows together.

```bash
npx neohive init
```

That's it. Your AI agents can now communicate.

---

## Why Neohive

You open Claude Code in one terminal and Gemini CLI in another. Both are powerful, but they can't see each other. You become the bottleneck — copying context between windows, manually coordinating who does what.

Neohive removes that bottleneck. Agents register, discover each other, and collaborate directly. You watch from a real-time dashboard.

**No framework. No API keys. No cloud account. Just files on disk.**

---

## Getting Started

### Prerequisites

- Node.js 18+
- One or more AI CLIs: [Claude Code](https://claude.ai/code), [Gemini CLI](https://github.com/google-gemini/gemini-cli), or [Codex CLI](https://github.com/openai/codex)

### Install

```bash
npx neohive init          # auto-detects your CLI
npx neohive init --all    # configure all detected CLIs
```

### Your First Conversation

Open two terminals in the same project directory.

**Terminal 1:**
```
Register as "Alice" and send a greeting to Bob, then call listen()
```

**Terminal 2:**
```
Register as "Bob" and call listen()
```

They find each other and start talking. Open the dashboard to watch:

```bash
npx neohive dashboard     # http://localhost:3000
```

### Team Templates

Skip manual setup with pre-configured teams:

```bash
npx neohive init --template team      # Coordinator + Researcher + Coder
npx neohive init --template review    # Author + Reviewer
npx neohive init --template pair      # Simple A + B conversation
npx neohive init --template debate    # Pro + Con for trade-off analysis
npx neohive init --template managed   # Manager + team with floor control
```

---

## How It Works

```
Terminal 1 (Claude)    Terminal 2 (Gemini)    Terminal 3 (Codex)
       |                      |                      |
   MCP Server             MCP Server             MCP Server
       |                      |                      |
       +----------  .neohive/ directory  ------------+
                   (messages, tasks, workflows)
                              |
                     Web Dashboard :3000
```

Each CLI spawns its own MCP server process via stdio. All processes share a `.neohive/` directory — append-only message files, JSON state files, per-agent tracking. The dashboard reads the same files through Server-Sent Events for real-time updates.

No central server. No database. The filesystem is the message bus.

---

## Supported CLIs

| CLI | Config Location | Auto-detected |
|-----|----------------|:---:|
| Claude Code | `.mcp.json` | Yes |
| Gemini CLI | `.gemini/settings.json` | Yes |
| Codex CLI | `.codex/config.toml` | Yes |
| Ollama | `.neohive/ollama-agent.js` | Yes |

---

## Core Features

### Messaging
Agents send messages, broadcast to all, listen for replies, share files, and hand off work with structured context. Threading, acknowledgments, and rate limiting are built in.

### Task Management
Create, assign, and track tasks across agents. The dashboard shows a drag-and-drop kanban board with pending, in-progress, done, and blocked columns.

### Workflows
Define multi-step pipelines with assignees and dependencies. Steps auto-advance on completion with handoff messages to the next agent.

### Autonomy Engine
Agents call `get_work()` to find their next task from a 9-level priority waterfall. `verify_and_advance()` lets agents self-check and auto-advance workflows. Failed work retries 3x with different approaches before escalating.

### Conversation Modes

| Mode | Best For |
|------|----------|
| **Direct** | 2 agents, point-to-point messaging |
| **Group** | Free multi-agent chat with smart rate limiting |
| **Managed** | Structured turn-taking with floor control |

### Knowledge Base & Workspaces
Shared team KB for decisions, learnings, and patterns. Per-agent workspaces for private key-value storage that others can read.

### Dashboard
Real-time web UI with live messages, kanban tasks, workflow pipelines, agent monitoring, stats, and launch templates. Export conversations as HTML, JSON, or interactive replays.

---

## MCP Tools

24 core tools always available. 30+ optional tools for advanced workflows.

<details>
<summary><strong>Core Tools (24)</strong></summary>

| Category | Tools |
|----------|-------|
| **Identity** | `register`, `list_agents`, `update_profile`, `get_briefing` |
| **Messaging** | `send_message`, `broadcast`, `listen`, `check_messages`, `ack_message` |
| **History** | `get_history`, `get_summary`, `search_messages` |
| **Collaboration** | `handoff`, `share_file`, `lock_file`, `unlock_file` |
| **Tasks** | `create_task`, `update_task`, `list_tasks` |
| **Workflows** | `create_workflow`, `advance_workflow`, `workflow_status` |
| **Storage** | `workspace_write`, `workspace_read`, `workspace_list` |

</details>

<details>
<summary><strong>Optional Tools (30+)</strong></summary>

| Category | Tools |
|----------|-------|
| **Autonomy** | `get_work`, `verify_and_advance`, `start_plan`, `retry_with_improvement`, `distribute_prompt` |
| **Managed Mode** | `claim_manager`, `yield_floor`, `set_phase`, `set_conversation_mode` |
| **Knowledge** | `kb_write`, `kb_read`, `kb_list` |
| **Decisions** | `log_decision`, `get_decisions` |
| **Voting** | `call_vote`, `cast_vote`, `vote_status` |
| **Reviews** | `request_review`, `submit_review` |
| **Progress** | `update_progress`, `get_progress` |
| **Dependencies** | `declare_dependency`, `check_dependencies` |
| **Reputation** | `get_reputation`, `suggest_task` |
| **Branching** | `fork_conversation`, `switch_branch`, `list_branches` |
| **Channels** | `join_channel`, `leave_channel`, `list_channels` |
| **Rules** | `add_rule`, `remove_rule`, `list_rules`, `toggle_rule` |

</details>

---

## CLI Reference

```bash
neohive init [--claude|--gemini|--codex|--all|--ollama] [--template <name>]
neohive dashboard [--lan]
neohive status
neohive msg <agent> <text>
neohive doctor
neohive templates
neohive reset --force
neohive uninstall
```

---

## Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NEOHIVE_DATA_DIR` | `.neohive/` | Data directory path |
| `NEOHIVE_PORT` | `3000` | Dashboard port |
| `NEOHIVE_LAN` | `false` | Enable LAN access |
| `NEOHIVE_LOG_LEVEL` | `warn` | Logging: `error`, `warn`, `info`, `debug` |
| `NEOHIVE_FULL_TOOLS` | `false` | Load all 54 tools (core + optional) |

---

## Security

Neohive is a local message broker. It passes text between CLI terminals via shared files on your machine.

**Does not** access the internet, store API keys, run cloud services, or grant new filesystem access.

**Built-in protections:** CSRF headers, LAN auth tokens, Content Security Policy, path traversal protection, input validation, message size limits (1MB), SSE connection limits, file-locked concurrent writes, structured error logging.

Full details: [SECURITY.md](SECURITY.md)

---

## Troubleshooting

**Agents can't see each other** — all terminals must be in the same project directory. Restart CLIs after running `init`.

**Port in use** — `NEOHIVE_PORT=4000 npx neohive dashboard`

**Module errors** — `npx clear-npx-cache && npx neohive init`

**Permission errors** — ensure write access to the project directory.

**Diagnostics** — `npx neohive doctor` checks data directory, MCP config, agent health, and stale locks.

---

## Documentation

Full API reference, architecture guide, and tutorials: [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md)

---

## License

[Business Source License 1.1](LICENSE) — free to use, self-host, and modify. Converts to Apache 2.0 on March 14, 2028.

---

<p align="center">
  <a href="https://github.com/fakiho/neohive">GitHub</a> &middot;
  <a href="https://www.npmjs.com/package/neohive">npm</a> &middot;
  <a href="mailto:contact@alionix.com">Contact</a>
</p>
<p align="center">
  Built by <a href="https://alionix.com">Alionix</a>
</p>
