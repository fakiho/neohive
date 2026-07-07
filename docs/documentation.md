# Neohive

### The MCP Collaboration Layer for AI CLI Tools

**Version 6.4.2** | Node.js >= 18 | [Website](https://neohive.alionix.com) | [GitHub](https://github.com/fakiho/neohive) | By [Alionix](https://github.com/fakiho)

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
  - [Recommended Setup](#recommended-setup)
  - [Zed and ACP](#zed-and-acp-agent-client-protocol)
  - [Troubleshooting](#troubleshooting)
- [Essentials](#essentials)
- [Reference library](#reference-library) — split deep dives under [`docs/reference/`](reference/)
- [Architecture](#architecture)
- [Tools Reference](#tools-reference)
- [Dashboard](#dashboard)
- [CLI Reference](#cli-reference)
- [Data Directory Reference](#data-directory-reference)
- [Advanced Topics](#advanced-topics)
- [Configuration](#configuration)

---

## Overview

Neohive is an MCP (Model Context Protocol) server and web dashboard that enables multiple AI CLI terminals to communicate with each other in real time. It turns isolated AI agents — each running in their own terminal — into a collaborative team that can send messages, assign tasks, share files, vote on decisions, and execute multi-step workflows.

### Why It Exists

AI CLI tools like Claude Code, Gemini CLI, and Codex CLI are powerful individually, but they operate in isolation. When a complex project requires research, coding, and review happening simultaneously, there is no built-in way for these agents to coordinate. Neohive bridges that gap with a shared filesystem protocol that requires zero infrastructure — no database, no message queue, no cloud service. Just files on disk.

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Agent** | An AI CLI terminal registered with a unique name. Each agent runs its own MCP server process. |
| **Bridge** | The shared `.neohive/` directory where all agents read and write data. |
| **Message** | A JSON object appended to a JSONL file. Messages have senders, recipients, timestamps, and optional threading. |
| **Tool** | An MCP tool exposed by the server. Agents call tools to send messages, create tasks, manage workflows, and more. |
| **Dashboard** | A web UI that monitors all agents, messages, tasks, and workflows in real time via SSE. |

### Supported CLIs & IDEs

**CLI tools:**
- **Claude Code** — Anthropic's CLI for Claude
- **Gemini CLI** — Google's CLI for Gemini
- **Codex CLI** — OpenAI's CLI for Codex
- **Ollama** — Local LLM bridge

**IDEs with MCP support:**
- **Cursor** — AI-native IDE built on VS Code
- **VS Code + Copilot** — GitHub Copilot agent mode
- **Antigravity** — Gemini-powered coding IDE

**ACP (Agent Client Protocol):**
- **Zed** — use `npx neohive init --acp` for a `.zed/acp.json` fragment and merge into Zed project settings; see [Zed and ACP](#zed-and-acp-agent-client-protocol) and [SPEC.md](../SPEC.md) §7.1 / §12.

**VS Code Extension:**
- **[Neohive Extension](https://marketplace.visualstudio.com/items?itemName=alionix.neohive)** (v0.5.0) — Monitor agents and workflows directly in your editor's sidebar. Provides real-time agent liveness, task board, workflow viewer, `@neohive` chat participant, and automatic MCP + hooks setup on activation.

---

## Getting Started

### Installation

Install and configure in any project directory:

```bash
npx neohive init
```

This auto-detects which AI CLIs you have installed and configures MCP for each one. The command creates a `.neohive/` directory in your project root and writes the appropriate MCP configuration file for your CLI.

To configure for a specific CLI:

```bash
npx neohive init --claude    # Claude Code only
npx neohive init --gemini    # Gemini CLI only
npx neohive init --codex     # Codex CLI only
npx neohive init --all       # All detected CLIs
npx neohive init --ollama    # Ollama local LLM bridge
npx neohive init --acp       # Zed ACP: .zed/acp.json + .neohive/
npx neohive init --acp-worker  # ACP worker template: .neohive/acp-workers.json
```

### Zed and ACP (Agent Client Protocol)

Neohive’s ACP entrypoint is **`acp-agent.mjs`** (npm package **`neohive`**). It talks to the same **`.neohive/`** hub as the MCP server, using the protocol described at [agentclientprotocol.com](https://agentclientprotocol.com/).

```bash
npx neohive init --acp
```

**What it writes**

- **`.neohive/`** — created if missing (shared data directory).
- **`.zed/acp.json`** — JSON with an **`agent_servers.neohive`** object suitable for Zed’s [custom external agents](https://zed.dev/docs/ai/external-agents.html) docs (`type: "custom"`, `command`, `args`, `env`).
- **`.zed/settings.json`** — **`agent_servers.neohive`** is **merged** idempotently so Zed loads the agent from project settings without a manual copy step.

**Wire-up in Zed**

Reload or restart Zed, open this folder as the **workspace root**, then start the external ACP agent named **`neohive`**. If you use only **`.zed/acp.json`** from an older flow, you can still merge **`agent_servers`** into **`.zed/settings.json`** by hand.

**Dependencies**

- **Consumer projects:** run **`npm install neohive`** so `node_modules/neohive/acp-agent.mjs` exists (default `args` path).
- **Developing the `neohive` package in `agent-bridge/`** (that folder is the cwd, with `acp-agent.mjs` next to `package.json`): `init --acp` uses **`${workspaceFolder}/acp-agent.mjs`**.
- **Developing the full Neohive git repo** (workspace root contains **`agent-bridge/`** with the published package): `init --acp` uses **`${workspaceFolder}/agent-bridge/acp-agent.mjs`** and **`${workspaceFolder}/.neohive`** — open the **repository root** in Zed, not only `agent-bridge/`.

**Agent naming and collisions**

- The generated `env` uses **`NEOHIVE_ACP_AGENT_NAME`: `acp-${workspaceName}`** when Zed expands `${workspaceName}` (see [SPEC.md](../SPEC.md) §7.1).
- **Collision:** If **`NEOHIVE_ACP_AGENT_NAME` is unset** at runtime and **two ACP sessions share the same cwd**, the bridge’s default name can match and both sessions fight for one Neohive identity. **Set `NEOHIVE_ACP_AGENT_NAME` explicitly** in `env` to a unique value per session (or per developer) when running multiple agents against one workspace.
- **Unexpanded variables:** If the editor passes a literal string like `acp-${workspaceName}`, name validation may fail — use a **static** value (e.g. `acp-backend`) for simple copy-paste configs.

**Reference template**

Registry-oriented JSON (not identical to `.zed/acp.json`) lives at **`agent-bridge/templates/acp-zed.json`** for comparisons and future registry work.

**Headless ACP workers (`dispatch`)**

- Run **`npx neohive init --acp-worker`** to add **`.neohive/acp-workers.json`** (worker `id` → `command` / `args` / `env`). Edit **`args`** for your CLI’s ACP mode.
- In Zed, prompt with first line **`dispatch worker=<id> cwd=<path>`** and task body below. **`cwd`** must stay under the session workspace roots; worker binaries are **never** taken from free-form text (only from the JSON file).
- Draft registry PR material: **[`docs/acp-registry/`](./acp-registry/README.md)**.

### Recommended Setup

`npx neohive init` gets you running, but a few extra steps ensure agents stay reliable across all IDEs.

#### Claude Code

```bash
npx neohive init --claude
```

`init` automatically handles MCP config, listen-enforcement hooks, and neohive skills. For the best experience:

- **VS Code Extension** — Install the [Neohive extension](https://marketplace.visualstudio.com/items?itemName=alionix.neohive) for automatic MCP configuration, in-editor agent status, task board, workflow viewer, and `@neohive` chat participant. The extension configures hooks on activation so you don't need to run anything manually.
- **Without the extension** — `init` installs hooks automatically. Run `npx neohive hooks` at any time to update or repair them. Hooks keep agents in the listen loop and block them from stopping mid-session.
- **Skills** — Installed into `.claude/skills/neohive/` automatically. They teach Claude how to use the MCP tools, launch teams, and follow collaboration conventions.

#### Cursor

```bash
npx neohive init --cursor
```

Installs MCP config, skills (`.cursor/skills/neohive/`), slash commands (`.cursor/commands/`), and agent definitions (`.cursor/agents/`).

> **Important:** Cursor sometimes disables newly added MCP servers by default. After init, go to **Settings → MCP**, find `neohive`, and enable it. Reload the window.

#### Antigravity

```bash
npx neohive init --antigravity
```

Installs MCP config globally and skills into `.agent/skills/neohive/`.

> **Important:** Same as Cursor — check **Settings → MCP** and ensure `neohive` is enabled after init.

#### Everything at once

```bash
npx neohive init --all
```

Configures MCP, hooks, skills, agents, and commands for every detected CLI and IDE in one command.

---

### Troubleshooting

**Agent can't register / MCP tools not found**

The IDE has likely disabled the neohive MCP server. Open Settings → MCP (or Tools & Integrations), find `neohive`, and toggle it on. Restart or reload the IDE window after enabling it.

**Agent stopped listening mid-session**

Due to a current IDE limitation, agents can occasionally exit the listen loop after a long idle period. Ask the agent: *"Call listen()"* to resume. We are actively working on a permanent fix via server-side timeout improvements.

---

### First Conversation

**Step 1: Open two terminals.** Each terminal should be running an AI CLI (e.g., Claude Code) in the same project directory.

**Step 2: Register each agent.** In Terminal 1, tell the AI:

```
Register as "Alice" and send a message to Bob saying hello.
```

In Terminal 2:

```
Register as "Bob" and listen for messages.
```

**Step 3: Watch them talk.** Alice's message appears in Bob's terminal. Bob can reply, and the conversation flows naturally.

### Using Templates

Templates pre-configure agent teams for common workflows:

```bash
npx neohive init --template team
```

Available templates:

| Template | Agents | Description |
|----------|--------|-------------|
| `pair` | 2 | Simple two-agent conversation for brainstorming or Q&A |
| `team` | 3 | Coordinator, Researcher, and Coder for complex features |
| `review` | 2 | Code review pipeline with author and reviewer |
| `debate` | 2 | Structured debate between opposing viewpoints |
| `managed` | 3 | Managed mode with floor control and structured turn-taking |

### Launch the Dashboard

Monitor your agents in real time:

```bash
npx neohive dashboard
```

Open `http://localhost:3000` in your browser. The dashboard shows live messages, agent status, tasks, workflows, and more — all updating in real time via Server-Sent Events.

---

## Essentials

### Agents

An agent is any AI CLI terminal that has registered with a name. Agents are identified by:

- **Name** — 1-20 alphanumeric characters (including underscores and hyphens)
- **PID** — The OS process ID of their MCP server
- **Provider** — Which CLI they're running on (Claude, Gemini, Codex)
- **Branch** — Which conversation branch they're on (default: `main`)

Reserved names that cannot be used: `__system__`, `__all__`, `__open__`, `__close__`, `system`, `dashboard`, `Dashboard`.

#### Agent Lifecycle

```
CLI launches server.js via stdio
        |
    MCP handshake
        |
  Agent calls register()
        |
  Heartbeat starts (10s interval)
        |
  Agent works: send, listen, create tasks...
        |
  Process exits → cleanup (remove from agents.json, save recovery snapshot)
```

Agents are detected as alive or dead through a combination of:
1. **Heartbeat freshness** — Last activity within the stale threshold (60 seconds)
2. **PID checking** — `process.kill(pid, 0)` to verify the process exists

### Messages

Messages are the fundamental unit of communication. Every message contains:

```json
{
  "id": "unique-id",
  "seq": 42,
  "from": "Alice",
  "to": "Bob",
  "content": "Hello from Alice!",
  "timestamp": "2026-04-02T10:00:00.000Z",
  "thread_id": null
}
```

#### Routing Rules

- **2 agents online:** The `to` field is optional — messages auto-route to the other agent.
- **3+ agents online:** The `to` field is required. Use `broadcast()` to send to everyone.
- **Channels:** Messages can be sent to named channels for sub-team communication.

#### Threading

Reply to a specific message by setting `reply_to` to that message's ID. The system automatically computes a `thread_id` for the conversation thread.

#### Rate Limiting

- Maximum 30 messages per minute per agent
- Duplicate detection: identical content to the same recipient within 30 seconds is blocked
- Group mode adds additional cooldowns that scale with agent count

### Conversation Modes

The system supports three distinct conversation modes that change how agents interact.

#### Direct Mode (Default)

Point-to-point messaging. Each message goes from one agent to one other agent. With exactly two agents online, the recipient is inferred automatically.

Best for: Pair programming, focused collaboration between two agents.

#### Group Mode

Free multi-agent chat. All agents can send messages to anyone or broadcast to everyone. Includes:
- **Cooldowns** — Adaptive delay between sends (scales with agent count, capped at 3 seconds)
- **Rate limiting** — Must call `listen()` between sends
- **Broadcast** — Send to all agents at once

Best for: Team discussions, brainstorming, multi-agent coordination.

#### Managed Mode

Structured turn-taking controlled by a manager agent. The manager:
1. Claims the manager role with `claim_manager()`
2. Grants speaking rights with `yield_floor(to: "AgentName")`
3. Sets conversation phases with `set_phase()`

Other agents can only send messages when they have the floor. This prevents chaos in large teams.

Best for: Formal reviews, structured planning sessions, large teams (5+ agents).

Switch modes at any time:

```
set_conversation_mode({ mode: "group" })
```

### Cursor project skills

Optional Cursor Agent Skills in this repository (attach in Cursor when role-playing Neohive teams):

| Skill | Path | Audience |
|-------|------|----------|
| **neohive-coordinator** | `.cursor/skills/neohive-coordinator/SKILL.md` | Coordinators and leads: tasks, workflows, dashboard REST (`X-LTT-Request`, `NEOHIVE_PORT`), **Stay with me** vs **Run autonomously**. |
| **neohive-developer-agent** | `.cursor/skills/neohive-developer-agent/SKILL.md` | Implementers: **register**, **listen**, **lock_file** / **unlock_file**, MCP re-init and absolute Node `command`, verification habits. |

---

## Reference library

Long-form reference material lives under **[`docs/reference/`](reference/)** so this hub stays readable. See **[`docs/README.md`](README.md)** for how files in `docs/` are named. Start from the **[reference index](reference/README.md)** or jump directly:

| Topic | File |
|-------|------|
| System design & data flow | [reference/architecture.md](reference/architecture.md) |
| MCP tools (**70+**, full parameters) | [reference/tools.md](reference/tools.md) |
| Dashboard (SSE, REST, security) | [reference/dashboard.md](reference/dashboard.md) |
| CLI commands | [reference/cli.md](reference/cli.md) |
| `.neohive/` data files | [reference/data-directory.md](reference/data-directory.md) |
| Autonomy, managed mode, branching, channels | [reference/advanced.md](reference/advanced.md) |
| `next_action` response chain & coordinator flows | [reference/next-action-chain.md](reference/next-action-chain.md) |
| Environment variables & MCP config snippets | [reference/configuration.md](reference/configuration.md) |

---

## Architecture

Diagrams, process model, message lifecycle, and data directory resolution: **[reference/architecture.md](reference/architecture.md)**.

---

## Tools Reference

All **70+** built-in MCP tools with parameters and examples: **[reference/tools.md](reference/tools.md)**.

---

## Dashboard

Setup, LAN mode, security, SSE, and REST API tables: **[reference/dashboard.md](reference/dashboard.md)**.

---

## CLI Reference

`npx neohive` commands (`init`, `mcp`, `serve`, `dashboard`, …): **[reference/cli.md](reference/cli.md)**.

---

## Data Directory Reference

Catalog of JSON/JSONL files under `.neohive/`: **[reference/data-directory.md](reference/data-directory.md)**.

---

## Advanced Topics

Autonomous workflows, managed mode, branching, channels, templates, dynamic guide: **[reference/advanced.md](reference/advanced.md)**.

---

## Configuration

Environment variables, per-CLI MCP config examples, and key constants: **[reference/configuration.md](reference/configuration.md)**.

---

*Neohive v6.4.2 — [Website](https://neohive.alionix.com) · Built by [Alionix](https://github.com/fakiho)*
