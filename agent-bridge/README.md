<p align="center">
  <h1 align="center">Neohive</h1>
</p>

<p align="center">
  <strong>One command. Your AI agents can talk to each other.</strong>
</p>

<p align="center">
  The MCP collaboration layer for Claude Code, Gemini CLI, and Codex CLI.
</p>

<br />

<p align="center">
  <a href="https://www.npmjs.com/package/neohive"><img src="https://img.shields.io/npm/v/neohive?style=for-the-badge&logo=npm&logoColor=white&color=CB3837" alt="npm version"></a>
  &nbsp;
  <a href="https://www.npmjs.com/package/neohive"><img src="https://img.shields.io/npm/dm/neohive?style=for-the-badge&logo=npm&logoColor=white&color=3fb950" alt="npm downloads"></a>
  &nbsp;
  <a href="https://github.com/fakiho/neohive/stargazers"><img src="https://img.shields.io/github/stars/fakiho/neohive?style=for-the-badge&logo=github&logoColor=white&color=58a6ff" alt="GitHub stars"></a>
  &nbsp;
  <a href="https://github.com/fakiho/neohive/blob/master/LICENSE"><img src="https://img.shields.io/badge/License-BSL%201.1-f59e0b?style=for-the-badge" alt="License"></a>
  &nbsp;
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/Node.js-18+-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node.js"></a>
</p>

<p align="center">
  <a href="#-quick-start">Quick Start</a> &middot;
  <a href="#-features">Features</a> &middot;
  <a href="#-how-it-works">How It Works</a> &middot;
  <a href="docs/DOCUMENTATION.md">Documentation</a> &middot;
  <a href="#%EF%B8%8F-cli-reference">CLI Reference</a> &middot;
  <a href="https://www.npmjs.com/package/neohive">npm</a>
</p>

<br />

---

<br />

You open Claude Code in one terminal and Gemini CLI in another. Both are powerful — but they can't see each other. You copy context between windows, manually coordinate who does what.

**Neohive removes that bottleneck.** Install once, and your AI agents discover each other, send messages, delegate tasks, review work, and execute multi-step workflows — automatically.

> No framework to learn. No API keys to manage. No cloud account required. Just files on disk.

<br />

## Contents

- [Quick Start](#-quick-start)
- [Features](#-features)
- [How It Works](#-how-it-works)
- [Supported CLIs](#-supported-clis)
- [Team Templates](#-team-templates)
- [Dashboard](#-dashboard)
- [MCP Tools](#-mcp-tools)
- [CLI Reference](#%EF%B8%8F-cli-reference)
- [Configuration](#%EF%B8%8F-configuration)
- [Security](#-security)
- [Documentation](#-documentation)
- [Contributing](#-contributing)
- [License](#-license)

<br />

## 🚀 Quick Start

```bash
npx neohive init
```

That's it. Neohive auto-detects your CLI, writes the MCP config, and creates a `.neohive/` data directory.

Now open two terminals in the same project:

```
# Terminal 1
Register as "Alice" and send a greeting to Bob, then call listen()

# Terminal 2
Register as "Bob" and call listen()
```

Watch them communicate in real time:

```bash
npx neohive dashboard    # opens http://localhost:3000
```

> **Want a pre-configured team?** Use templates:
> ```bash
> npx neohive init --template team    # Coordinator + Researcher + Coder
> ```

<br />

## ✨ Features

| | Feature | Description |
|---|---------|-------------|
| 💬 | **Real-time Messaging** | Send, broadcast, listen, thread, acknowledge — with rate limiting and dedup |
| 📋 | **Task Management** | Create, assign, and track tasks with a drag-and-drop kanban board |
| 🔄 | **Workflow Pipelines** | Multi-step automation with dependency graphs and auto-handoff |
| 🤖 | **Autonomy Engine** | Agents find work, self-verify, retry on failure, and escalate when stuck |
| 🎯 | **Managed Mode** | Structured turn-taking with floor control for disciplined multi-agent teams |
| 📊 | **Live Dashboard** | Web UI with messages, tasks, workflows, agent monitoring, and stats |
| 🧠 | **Knowledge Base** | Shared team memory for decisions, learnings, and patterns |
| 🔒 | **File Locking** | Concurrent write protection across all 19 data files |
| 🌿 | **Branching** | Fork conversations at any point with isolated history |
| 📡 | **Channels** | Sub-team communication with dedicated message streams |
| 🗳️ | **Voting & Reviews** | Team decisions and structured code review workflows |
| 🔌 | **Multi-CLI** | Works across Claude Code, Gemini CLI, Codex CLI, and Ollama |

<br />

## 🏗 How It Works

```
  ┌─────────────┐   ┌─────────────┐   ┌─────────────┐
  │ Claude Code  │   │ Gemini CLI  │   │  Codex CLI  │
  │  Terminal 1  │   │  Terminal 2  │   │  Terminal 3  │
  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘
         │                  │                   │
    MCP Server         MCP Server          MCP Server
    (stdio)            (stdio)             (stdio)
         │                  │                   │
         └──────────────────┼───────────────────┘
                            │
                   ┌────────▼────────┐
                   │   .neohive/     │
                   │                 │
                   │  messages.jsonl │
                   │  agents.json    │
                   │  tasks.json     │
                   │  workflows.json │
                   │  ...            │
                   └────────┬────────┘
                            │
                   ┌────────▼────────┐
                   │   Dashboard     │
                   │  localhost:3000  │
                   │  (SSE real-time) │
                   └─────────────────┘
```

Each CLI spawns its own MCP server process. All processes share a `.neohive/` directory — append-only message files, JSON state files, per-agent tracking. No central server. No database. **The filesystem is the message bus.**

<br />

## 🔌 Supported CLIs

| CLI | Config Location | Auto-detected | Init Flag |
|-----|----------------|:---:|-----------|
| [Claude Code](https://claude.ai/code) | `.mcp.json` | ✅ | `--claude` |
| [Gemini CLI](https://github.com/google-gemini/gemini-cli) | `.gemini/settings.json` | ✅ | `--gemini` |
| [Codex CLI](https://github.com/openai/codex) | `.codex/config.toml` | ✅ | `--codex` |
| [Ollama](https://ollama.com) | `.neohive/ollama-agent.js` | ✅ | `--ollama` |

```bash
npx neohive init --all    # configure all detected CLIs at once
```

<br />

## 🧩 Team Templates

Pre-configured teams with ready-to-paste prompts for each terminal:

```bash
npx neohive init --template <name>
```

| Template | Agents | Best For |
|----------|--------|----------|
| `team` | Coordinator, Researcher, Coder | Complex features needing research + implementation |
| `review` | Author, Reviewer | Code review with structured feedback |
| `pair` | A, B | Brainstorming, Q&A, simple conversations |
| `debate` | Pro, Con | Evaluating trade-offs and architecture decisions |
| `managed` | Manager, Designer, Coder, Tester | Large teams with structured turn-taking |

<br />

## 📊 Dashboard

```bash
npx neohive dashboard          # http://localhost:3000
npx neohive dashboard --lan    # accessible from your phone
```

| Tab | What It Shows |
|-----|---------------|
| **Messages** | Live feed with markdown, search, bookmarks, pins, reactions |
| **Tasks** | Drag-and-drop kanban board (pending / in-progress / done / blocked) |
| **Workspaces** | Per-agent key-value storage browser |
| **Workflows** | Pipeline visualization with step progress |
| **Launch** | Spawn agents with templates and copyable prompts |
| **Stats** | Per-agent scores, response times, hourly activity charts |
| **Docs** | In-dashboard tool reference and mode guides |

Plus: agent status monitoring, profile popups, message injection, conversation export (HTML/JSON/replay), multi-project support, dark/light theme, mobile responsive.

<br />

## 🛠 MCP Tools

**24 core tools** always available. **30+ optional tools** loaded with `NEOHIVE_FULL_TOOLS=true`.

<details>
<summary><strong>Core Tools (24)</strong> — messaging, tasks, workflows, storage</summary>

<br />

| Category | Tools |
|----------|-------|
| **Identity** | `register` · `list_agents` · `update_profile` · `get_briefing` |
| **Messaging** | `send_message` · `broadcast` · `listen` · `check_messages` · `ack_message` |
| **History** | `get_history` · `get_summary` · `search_messages` |
| **Collaboration** | `handoff` · `share_file` · `lock_file` · `unlock_file` |
| **Tasks** | `create_task` · `update_task` · `list_tasks` |
| **Workflows** | `create_workflow` · `advance_workflow` · `workflow_status` |
| **Storage** | `workspace_write` · `workspace_read` · `workspace_list` |

</details>

<details>
<summary><strong>Optional Tools (30+)</strong> — autonomy, voting, reviews, branching</summary>

<br />

| Category | Tools |
|----------|-------|
| **Autonomy** | `get_work` · `verify_and_advance` · `start_plan` · `retry_with_improvement` · `distribute_prompt` |
| **Managed Mode** | `claim_manager` · `yield_floor` · `set_phase` · `set_conversation_mode` |
| **Knowledge** | `kb_write` · `kb_read` · `kb_list` |
| **Decisions** | `log_decision` · `get_decisions` |
| **Voting** | `call_vote` · `cast_vote` · `vote_status` |
| **Reviews** | `request_review` · `submit_review` |
| **Progress** | `update_progress` · `get_progress` |
| **Dependencies** | `declare_dependency` · `check_dependencies` |
| **Reputation** | `get_reputation` · `suggest_task` |
| **Branching** | `fork_conversation` · `switch_branch` · `list_branches` |
| **Channels** | `join_channel` · `leave_channel` · `list_channels` |
| **Rules** | `add_rule` · `remove_rule` · `list_rules` · `toggle_rule` |

</details>

<br />

## ⌨️ CLI Reference

```bash
neohive init [--claude|--gemini|--codex|--all|--ollama] [--template <name>]
neohive dashboard [--lan]
neohive status              # active agents, tasks, workflows
neohive msg <agent> <text>  # send message from CLI
neohive doctor              # diagnostic health check
neohive templates           # list available templates
neohive reset --force       # clear data (auto-archives first)
neohive uninstall           # remove from all CLI configs
```

<br />

## ⚙️ Configuration

| Variable | Default | Description |
|----------|---------|-------------|
| `NEOHIVE_DATA_DIR` | `.neohive/` | Data directory path |
| `NEOHIVE_PORT` | `3000` | Dashboard port |
| `NEOHIVE_LAN` | `false` | Enable LAN access |
| `NEOHIVE_LOG_LEVEL` | `warn` | Logging: `error` · `warn` · `info` · `debug` |
| `NEOHIVE_FULL_TOOLS` | `false` | Load all 54 tools (core + optional) |

<br />

## 🔐 Security

Neohive is a **local message broker**. It passes text between CLI terminals via shared files. It does not access the internet, store API keys, or run cloud services.

**Built-in protections:**

- ✅ CSRF custom header validation
- ✅ Content Security Policy (CSP)
- ✅ File-locked concurrent writes (all 19 data files)
- ✅ Path traversal protection with symlink validation
- ✅ Content sanitization on message injection
- ✅ SSE connection limits and rate limiting
- ✅ Message size limits (1MB)
- ✅ LAN mode with token-based authentication
- ✅ Structured error logging

Full details: [SECURITY.md](SECURITY.md)

<br />

## 📚 Documentation

| Resource | Link |
|----------|------|
| Full API Reference | [docs/DOCUMENTATION.md](docs/DOCUMENTATION.md) |
| Architecture & Data Flow | [docs/DOCUMENTATION.md#architecture](docs/DOCUMENTATION.md#architecture) |
| Tool Reference | [docs/DOCUMENTATION.md#tools-reference](docs/DOCUMENTATION.md#tools-reference) |
| Vision & Roadmap | [VISION.md](VISION.md) |
| Security Policy | [SECURITY.md](SECURITY.md) |
| Contributing Guide | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Changelog | [CHANGELOG.md](CHANGELOG.md) |

<br />

## 🤝 Contributing

We welcome contributions. See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

```bash
git clone https://github.com/fakiho/neohive.git
cd neohive/agent-bridge
node server.js    # run the MCP server
node dashboard.js # run the dashboard
```

<br />

## 📄 License

[Business Source License 1.1](LICENSE) — free to use, self-host, and modify. Converts to Apache 2.0 on March 14, 2028.

<br />

---

<p align="center">
  Built by <a href="https://alionix.com"><strong>Alionix</strong></a>
</p>

<p align="center">
  <a href="https://github.com/fakiho/neohive">GitHub</a> &middot;
  <a href="https://www.npmjs.com/package/neohive">npm</a> &middot;
  <a href="docs/DOCUMENTATION.md">Docs</a> &middot;
  <a href="mailto:contact@alionix.com">Contact</a>
</p>
