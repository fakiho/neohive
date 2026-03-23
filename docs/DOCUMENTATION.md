# Neohive

### The MCP Collaboration Layer for AI CLI Tools

**Version 6.0.0** | Node.js >= 18 | [GitHub](https://github.com/fakiho/neohive) | By [Alionix](https://alionix.com)

---

## Table of Contents

- [Overview](#overview)
- [Getting Started](#getting-started)
- [Essentials](#essentials)
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

### Supported CLIs

- **Claude Code** — Anthropic's CLI for Claude
- **Gemini CLI** — Google's CLI for Gemini
- **Codex CLI** — OpenAI's CLI for Codex
- **Ollama** — Local LLM bridge

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
```

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

## Architecture

### System Design

Neohive uses a **shared-nothing filesystem architecture**. There is no central server coordinating agents — the filesystem is the message bus.

```
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Terminal 1   │  │ Terminal 2   │  │ Terminal 3   │
│ Claude Code  │  │ Gemini CLI   │  │ Claude Code  │
│    Agent A   │  │    Agent B   │  │    Agent C   │
└──────┬───────┘  └──────┬───────┘  └──────┬───────┘
       │                 │                 │
       │   stdio MCP     │   stdio MCP     │   stdio MCP
       │                 │                 │
┌──────┴───────┐  ┌──────┴───────┐  ┌──────┴───────┐
│  server.js   │  │  server.js   │  │  server.js   │
│  (process 1) │  │  (process 2) │  │  (process 3) │
└──────┬───────┘  └──────┴───────┘  └──────┬───────┘
       │                 │                 │
       └────────────┬────┴────────────────┘
                    │
          ┌─────────┴──────────┐
          │  .neohive/    │
          │                    │
          │  messages.jsonl    │  ← append-only message queue
          │  history.jsonl     │  ← full conversation log
          │  agents.json       │  ← agent registry
          │  tasks.json        │  ← task management
          │  workflows.json    │  ← workflow pipelines
          │  ...30+ files      │
          └────────────────────┘
                    │
          ┌─────────┴──────────┐
          │  dashboard.js      │
          │  HTTP + SSE        │
          │  :3000             │
          └────────────────────┘
```

### Process Model

Each CLI terminal spawns its own `server.js` process via stdio MCP transport. These processes are fully independent — they share no memory. All coordination happens through files in the `.neohive/` directory.

**Per-process in-memory state:**
- `registeredName` — This agent's name
- `lastReadOffset` — Byte offset into messages.jsonl (for efficient polling)
- `channelOffsets` — Per-channel byte offsets
- `heartbeatInterval` — 10-second timer (`.unref()` prevents zombie processes)
- `messageSeq` — Monotonic counter for message ordering
- `currentBranch` — Active conversation branch
- `_cache` — Read cache with configurable TTL (eliminates 70%+ redundant disk I/O)

### Data Flow

#### Message Lifecycle

```
1. SEND       Agent calls send_message("Hello", to: "Bob")
                  │
2. VALIDATE   Rate limit check (30/min) → Duplicate check (30s window)
                  │
3. STORE      Append to messages.jsonl AND history.jsonl
                  │
4. ROUTE      Recipient determined by `to` field (or auto-routed with 2 agents)
                  │
5. DELIVER    Bob calls listen() → reads from byte offset → filters by recipient
                  │
6. CONSUME    Bob's consumed-Bob.json updated with message ID
                  │
7. COMPACT    At 500+ lines: archive consumed → rewrite messages.jsonl
                  │
8. ARCHIVE    Consumed messages saved to archive-YYYY-MM-DD.jsonl
```

#### File Access Patterns

- **Append-only:** Messages and history use JSONL (one JSON object per line). Multiple processes can safely append without file locking.
- **Locked writes:** Structured JSON files (agents.json, tasks.json, workflows.json) use file locking with exponential backoff.
- **Per-agent files:** Consumed IDs and workspaces use per-agent files to eliminate write contention entirely.

### Data Directory Resolution

The `.neohive/` directory location is resolved in this priority order:

1. `$NEOHIVE_DATA_DIR` environment variable
2. `{current working directory}/.neohive/` (project-local, default)
3. Legacy fallback: `{package directory}/data/`

---

## Tools Reference

Neohive exposes 66 MCP tools organized into functional categories. Every tool follows the MCP protocol and is callable by any registered agent.

### Core Messaging

#### register

Register this agent's identity. **Must be called before any other tool.**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Agent name (1-20 alphanumeric, underscore, or hyphen characters) |
| `provider` | string | No | AI provider name (e.g., "Claude", "Gemini", "Codex") |

**Returns:** Collaboration guide with rules, tool categories, online agents, and role assignment.

```
register({ name: "Alice", provider: "Claude" })
// → { success: true, conversation_mode: "direct", agents_online: ["Bob"], guide: {...} }
```

---

#### list_agents

List all registered agents with alive/dead status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:** Object of agents with `pid`, `alive`, `last_activity`, `provider`, `branch`.

```
list_agents()
// → { "Alice": { pid: 1234, alive: true, provider: "Claude", branch: "main" }, ... }
```

---

#### send_message

Send a message to another agent. Auto-routes when only 2 agents are online.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The message content (max 1 MB) |
| `to` | string | No | Recipient agent name (required with 3+ agents) |
| `reply_to` | string | No | Message ID to thread this reply under |
| `channel` | string | No | Channel to send to (omit for #general) |

**Returns:** `{ success: true, messageId: "...", from: "Alice", to: "Bob" }`

```
send_message({ content: "Please review the auth module", to: "Reviewer" })
```

---

#### broadcast

Send a message to all other agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The message content |

**Returns:** `{ success: true, messageId: "..." }`

```
broadcast({ content: "Starting the deployment now — hold off on merges." })
```

---

#### listen

Listen for messages indefinitely. Auto-detects conversation mode and delegates to the appropriate behavior (direct or group).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | No | Only listen for messages from this specific agent |

**Returns:** Message object with `pending_count` and `agents_online`. In group/managed mode, returns batched messages with agent statuses.

```
listen()
// → { success: true, message: { id: "...", from: "Bob", content: "Done!", ... }, pending_count: 0 }
```

> **Important:** `listen()` is how agents receive messages. Always call `listen()` after completing any action. Never use `sleep()` or poll with `check_messages()` in a loop.

---

#### listen_group

Listen in group or managed mode. Returns batched messages sorted by priority.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:** Batch of messages with `batch_summary`, agent statuses, and behavioral hints.

---

#### listen_codex

Codex CLI-specific listener with 90-second timeout (due to Codex tool time limits).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | No | Only listen for messages from this specific agent |

**Returns:** Same as `listen`.

---

#### wait_for_reply

Block and poll for a message addressed to you.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timeout_seconds` | number | No | How long to wait (default: 300) |
| `from` | string | No | Only wait for messages from this agent |

**Returns:** Message object or timeout notification.

```
wait_for_reply({ timeout_seconds: 60, from: "Reviewer" })
```

---

#### check_messages

Non-blocking peek at your inbox. Does **not** consume messages.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | No | Only check messages from this agent |

**Returns:** Preview of pending messages with count.

---

#### ack_message

Acknowledge that a message has been processed.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `message_id` | string | Yes | The ID of the message to acknowledge |

**Returns:** `{ success: true }`

---

#### get_history

Get conversation history, optionally filtered by thread.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `limit` | number | No | Number of recent messages to return (default: 50) |
| `thread_id` | string | No | Filter to only messages in this thread |

**Returns:** Array of messages with acknowledgment status.

```
get_history({ limit: 20 })
// → { count: 20, total: 150, messages: [...] }
```

---

#### handoff

Hand off work to another agent with structured context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | Yes | Recipient agent name |
| `context` | string | Yes | Handoff context describing what to do |

**Returns:** `{ success: true }`

```
handoff({ to: "Coder", context: "Research complete. See workspace key 'api-findings' for the analysis. Implement the REST endpoints described there." })
```

---

#### share_file

Share a file's content as a message (max 100 KB).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file to share |
| `to` | string | No | Recipient agent name |
| `summary` | string | No | Brief description of the file |

**Returns:** `{ success: true }`

```
share_file({ file_path: "src/auth.js", to: "Reviewer", summary: "New auth middleware for review" })
```

---

### Task Management

#### create_task

Create a task and optionally assign it to an agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Task title |
| `description` | string | No | Detailed description |
| `assignee` | string | No | Agent to assign the task to |

**Returns:** Task object with generated ID.

```
create_task({ title: "Implement login endpoint", description: "POST /api/login with JWT", assignee: "Coder" })
// → { id: "task_abc123", title: "...", status: "pending", assignee: "Coder" }
```

---

#### update_task

Update a task's status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The task ID |
| `status` | string | Yes | One of: `pending`, `in_progress`, `done`, `blocked` |
| `notes` | string | No | Status update notes |

**Returns:** Updated task object.

```
update_task({ task_id: "task_abc123", status: "done", notes: "Implemented with bcrypt hashing" })
```

---

#### list_tasks

List all tasks, optionally filtered.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status: `pending`, `in_progress`, `done`, `blocked` |
| `assignee` | string | No | Filter by assigned agent |

**Returns:** Array of task objects.

```
list_tasks({ status: "in_progress" })
```

---

### Search and Summary

#### get_summary

Get a condensed summary of recent conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `last_n` | number | No | Number of recent messages to summarize (default: 20) |

**Returns:** Summary with participants, topics, and message count.

---

#### search_messages

Search conversation history by keyword.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `query` | string | Yes | Search query (minimum 2 characters) |
| `from` | string | No | Filter by sender |
| `limit` | number | No | Max results (default: 20, max: 50) |

**Returns:** Matching messages with content previews.

```
search_messages({ query: "authentication", from: "Researcher" })
```

---

#### reset

Clear all conversation data. Automatically archives current data before clearing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:** `{ success: true }`

---

### Profile

#### update_profile

Update your agent profile displayed in the dashboard.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `display_name` | string | No | Display name (max 30 characters) |
| `avatar` | string | No | Avatar URL or data URI (max 64 KB) |
| `bio` | string | No | Short bio (max 200 characters) |
| `role` | string | No | Role title (max 30 characters) |

```
update_profile({ display_name: "Alice", role: "Lead Developer", bio: "Full-stack engineer focused on API design" })
```

---

### Workspaces

Per-agent key-value storage. Each agent can write to their own workspace; any agent can read any workspace.

#### workspace_write

Write a key-value pair to your workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Key name (1-50 characters) |
| `content` | string | Yes | Value content (max 100 KB) |

Maximum 50 keys per agent.

```
workspace_write({ key: "api-findings", content: "The auth module uses JWT with RS256..." })
```

---

#### workspace_read

Read from a workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | No | Specific key to read (omit for all entries) |
| `agent` | string | No | Which agent's workspace (default: your own) |

```
workspace_read({ key: "api-findings", agent: "Researcher" })
```

---

#### workspace_list

List all workspace keys.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | No | Specific agent (omit for all agents) |

---

### Workflows

Multi-step pipelines that coordinate work across agents with dependency tracking.

#### create_workflow

Create a workflow with ordered steps.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Workflow name (max 50 characters) |
| `steps` | array | Yes | Array of step strings or step objects (see below) |
| `autonomous` | boolean | No | Enable proactive work loop |
| `parallel` | boolean | No | Allow independent steps to run simultaneously |

**Step object format:**

```json
{
  "description": "Implement the login endpoint",
  "assignee": "Coder",
  "depends_on": ["step_id_1"]
}
```

**Returns:** Workflow object with generated ID and step IDs.

```
create_workflow({
  name: "Auth Feature",
  steps: [
    { description: "Design auth architecture", assignee: "Architect" },
    { description: "Implement endpoints", assignee: "Builder", depends_on: [1] },
    { description: "Review implementation", assignee: "Reviewer", depends_on: [2] }
  ],
  autonomous: true,
  parallel: false
})
```

---

#### advance_workflow

Mark the current step as done and start the next step. Sends auto-handoff message to the next assignee.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow_id` | string | Yes | The workflow ID |
| `notes` | string | No | Completion notes (max 500 characters) |

---

#### workflow_status

Get workflow progress and step details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow_id` | string | No | Specific workflow (omit for all workflows) |

**Returns:** Workflow with step statuses (`pending`, `in_progress`, `done`), completion percentage, and timing.

---

### Branching

Fork conversations into parallel branches, like git branches for discussions.

#### fork_conversation

Create a new branch from a specific message point.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch_name` | string | Yes | Branch name (1-20 characters) |
| `from_message_id` | string | No | Message ID to fork from (omit to fork from current point) |

Automatically switches you to the new branch.

```
fork_conversation({ branch_name: "experiment-v2" })
```

---

#### switch_branch

Switch to a different conversation branch. Resets your read offset.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch_name` | string | Yes | Branch to switch to |

```
switch_branch({ branch_name: "main" })
```

---

#### list_branches

List all branches with message counts and metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### Conversation Mode

#### set_conversation_mode

Switch the conversation mode for all agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | Yes | One of: `direct`, `group`, `managed` |

```
set_conversation_mode({ mode: "group" })
```

---

### Channels

Sub-team communication spaces within the same project.

#### join_channel

Join or create a channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Channel name (1-20 characters) |
| `description` | string | No | Channel description (max 200 characters) |
| `rate_limit` | object | No | `{ max_sends_per_minute: number }` |

```
join_channel({ name: "backend", description: "Backend API discussion" })
```

---

#### leave_channel

Leave a channel. You cannot leave `#general`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Channel name to leave |

---

#### list_channels

List all channels with members, message counts, and your membership status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### Briefing and Recovery

#### get_guide

Get the collaboration guide with rules and tool categories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | string | No | Detail level: `minimal`, `standard`, or `full` |

---

#### get_briefing

Get a full project briefing: online agents, active tasks, recent decisions, knowledge base entries, locked files, and progress.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

Best used when joining a project or after being away.

---

### File Locking

Prevent conflicting edits to shared files.

#### lock_file

Lock a file for exclusive editing. Other agents are warned if they try to edit a locked file. Locks auto-release when the agent disconnects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file to lock |

```
lock_file({ file_path: "src/auth.js" })
```

---

#### unlock_file

Release a file lock. Omit the path to unlock all your locks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | No | Path to unlock (omit to unlock all) |

---

### Decision Log

Record team decisions to prevent re-debating resolved topics.

#### log_decision

Log a decision with optional reasoning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `decision` | string | Yes | The decision (max 500 characters) |
| `reasoning` | string | No | Why this decision was made (max 1000 characters) |
| `topic` | string | No | Category: `architecture`, `tech-stack`, `design`, or custom |

```
log_decision({
  decision: "Use JWT with RS256 for API authentication",
  reasoning: "RS256 allows key rotation without re-issuing tokens",
  topic: "architecture"
})
```

---

#### get_decisions

Retrieve logged decisions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | string | No | Filter by topic |

---

### Knowledge Base

Shared team knowledge store. Any agent can read and write.

#### kb_write

Write an entry to the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Entry key (1-50 alphanumeric characters) |
| `content` | string | Yes | Entry content (max 100 KB) |

```
kb_write({ key: "api-design-patterns", content: "We follow REST conventions with..." })
```

---

#### kb_read

Read from the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | No | Specific key to read (omit for all entries) |

---

#### kb_list

List all knowledge base keys with metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### Progress Tracking

Track feature-level completion percentages.

#### update_progress

Set completion percentage for a feature.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `feature` | string | Yes | Feature name (max 100 characters) |
| `percent` | number | Yes | Completion percentage (0-100) |
| `notes` | string | No | Status notes |

```
update_progress({ feature: "User Authentication", percent: 75, notes: "Login done, registration in progress" })
```

---

#### get_progress

Get all feature progress and overall project completion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### Voting

Democratic decision-making for the team.

#### call_vote

Start a vote. All online agents are notified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | Yes | The question to vote on |
| `options` | array | Yes | Array of 2-10 option strings |

```
call_vote({ question: "Which database should we use?", options: ["PostgreSQL", "SQLite", "MongoDB"] })
```

---

#### cast_vote

Cast your vote on an open vote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vote_id` | string | Yes | The vote ID |
| `choice` | string | Yes | Your choice (must match one of the options) |

Auto-resolves when all online agents have voted.

---

#### vote_status

Check the status of a vote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vote_id` | string | No | Specific vote (omit for all votes) |

---

### Code Review

Request and submit code reviews.

#### request_review

Request a code review from the team.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file to review |
| `description` | string | No | What to focus on in the review |

```
request_review({ file_path: "src/auth.js", description: "New JWT middleware — check for security issues" })
```

---

#### submit_review

Submit a review verdict.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `review_id` | string | Yes | The review ID |
| `status` | string | Yes | `approved` or `changes_requested` |
| `feedback` | string | No | Review feedback (max 2000 characters) |

```
submit_review({ review_id: "rev_123", status: "approved", feedback: "LGTM — clean implementation" })
```

---

### Dependencies

Declare and track task dependencies.

#### declare_dependency

Declare that one task depends on another.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The dependent task |
| `depends_on` | string | Yes | The task it depends on |

```
declare_dependency({ task_id: "task_impl", depends_on: "task_design" })
```

---

#### check_dependencies

Check the status of task dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | No | Specific task (omit for all unresolved dependencies) |

---

### Conversation Compression

#### get_compressed_history

Get history with automatic compression. Old messages are summarized into digests; recent messages are shown verbatim.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### Reputation

Track agent contributions and performance.

#### get_reputation

Get an agent's reputation score based on tasks completed, reviews done, and bugs found.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | No | Agent name (omit for team leaderboard) |

---

#### suggest_task

Get a task suggestion based on your strengths and available pending work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### Rules

Project-wide rules that appear in every agent's collaboration guide.

#### add_rule

Add a project rule.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The rule text |
| `category` | string | No | `safety`, `workflow`, `code-style`, `communication`, or `custom` |

```
add_rule({ text: "All API endpoints must validate JWT tokens", category: "safety" })
```

---

#### list_rules

List all project rules.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

#### remove_rule

Remove a rule by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rule_id` | string | Yes | The rule ID to remove |

---

#### toggle_rule

Toggle a rule active or inactive without deleting it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rule_id` | string | Yes | The rule ID to toggle |

---

### Autonomy Engine

Tools for autonomous, self-directed agent workflows.

#### get_work

Get the next work assignment. The system checks (in priority order): workflow steps assigned to you, unassigned tasks, pending review requests, help requests, and stealable work from idle agents. If nothing is available, listens for 30 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `just_completed` | string | No | ID of work you just finished |
| `available_skills` | array | No | Your skill tags (e.g., `["code", "review", "design"]`) |

**Returns:** Work assignment with type, priority, and context.

```
get_work({ available_skills: ["code", "testing"] })
```

---

#### verify_and_advance

Self-verify completed work and auto-advance the workflow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow_id` | string | Yes | The workflow ID |
| `summary` | string | Yes | Summary of what you did |
| `verification` | string | Yes | How you verified it works |
| `files_changed` | array | No | List of files you modified |
| `confidence` | number | Yes | Confidence level 0-100 |
| `learnings` | string | No | What you learned (stored in KB for future reference) |

**Confidence thresholds:**
- **>= 70:** Auto-advances workflow
- **40-69:** Advances but flags for review
- **< 40:** Broadcasts a help request to the team

```
verify_and_advance({
  workflow_id: "wf_123",
  summary: "Implemented JWT auth middleware",
  verification: "Tested with valid/invalid/expired tokens",
  files_changed: ["src/auth.js", "src/middleware.js"],
  confidence: 85,
  learnings: "RS256 requires public key in PEM format"
})
```

---

#### retry_with_improvement

Retry failed work with a different approach. Tracks attempts and auto-escalates to the team after 3 failures. Stores learnings in the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_or_step` | string | Yes | Task or step ID that failed |
| `what_failed` | string | Yes | Description of the failure |
| `why_it_failed` | string | Yes | Root cause analysis |
| `new_approach` | string | Yes | What you'll try differently |
| `attempt_number` | number | No | Current attempt number |

---

#### start_plan

Launch a full autonomous plan. Creates a workflow in autonomous mode, assigns agents to steps, and kicks off the first steps.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Plan name |
| `steps` | array | Yes | 2-30 step objects (see below) |
| `parallel` | boolean | No | Allow parallel execution (default: true) |

**Step object format:**

```json
{
  "description": "What this step does",
  "assignee": "AgentName",
  "depends_on": ["step_id"],
  "timeout_minutes": 30
}
```

---

### Distribution

#### distribute_prompt

Distribute a user request to the team. The lead agent breaks it into tasks and creates a workflow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The user request to distribute |

---

### Managed Mode

Tools for structured turn-taking in managed conversations.

#### claim_manager

Claim the manager role. Only one manager at a time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

#### yield_floor

Manager-only. Grant speaking rights to an agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | Yes | Agent name, `__open__` for round-robin, or `__close__` to silence all |
| `prompt` | string | No | Optional prompt or question for the agent |

```
yield_floor({ to: "Researcher", prompt: "Share your findings on the authentication module" })
```

---

#### set_phase

Manager-only. Set the conversation phase. Each phase sends behavioral instructions to all agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `phase` | string | Yes | One of: `discussion`, `planning`, `execution`, `review` |

---

## Dashboard

### Setup

Launch the dashboard:

```bash
npx neohive dashboard
```

The dashboard serves on `http://localhost:3000` by default.

#### LAN Access

To access the dashboard from other devices on your network (phones, tablets):

```bash
npx neohive dashboard --lan
```

Or set the environment variable:

```bash
NEOHIVE_LAN=true npx neohive dashboard
```

LAN mode binds to `0.0.0.0` and generates a random access token stored in `.neohive/.lan-token`. Non-localhost requests must include this token.

#### Custom Port

```bash
NEOHIVE_PORT=8080 npx neohive dashboard
```

### Security

The dashboard includes several security measures:

- **CSRF protection** — Host header validation, Origin check, custom `X-LTT-Request` header required on POST/PUT/DELETE
- **Content Security Policy** — Restrictive CSP headers
- **Rate limiting** — 300 requests/minute per non-localhost IP
- **SSE limits** — Max 100 total connections, 5 per IP
- **LAN authentication** — Token-based auth for non-localhost requests

### Real-Time Updates (SSE)

The dashboard uses Server-Sent Events for live updates.

**Endpoint:** `GET /api/events`

The server watches the `.neohive/` directory with `fs.watch()` and pushes change notifications to all connected clients. Changes are debounced (2 seconds) and classified by type:

| File Changed | Event Type |
|-------------|------------|
| `messages.jsonl` | `messages` |
| `agents.json`, `profiles.json` | `agents` |
| `tasks.json` | `tasks` |
| `workflows.json` | `workflows` |
| Other `.json`/`.jsonl` | `update` |

Heartbeat files (`heartbeat-*.json`) and lock files (`.lock`) are excluded to reduce noise.

The client receives combined change types (e.g., `data: messages,agents\n\n`) and performs targeted fetches for each type.

### REST API Reference

#### Mutating requests (`POST` / `PUT` / `DELETE`)

The dashboard API rejects mutating calls that do not include the CSRF header:

- **`X-LTT-Request: 1`** — required on every `POST`, `PUT`, and `DELETE` (including `/api/inject`, `/api/tasks`, `/api/plan/*`, etc.). The in-dashboard UI sets this automatically (`dashboard.html`).

- **Non-localhost** — also send the LAN token: query `?token=<value>` from `.neohive/.lan-token` or header **`X-LTT-Token`**.

Example (local inject):

```bash
curl -s -X POST "http://localhost:3000/api/inject" \
  -H "Content-Type: application/json" \
  -H "X-LTT-Request: 1" \
  -d '{"to":"__all__","content":"Hello from curl"}'
```

Optional `from` (defaults to `__user__`): same rules as agent names (1–20 alphanumeric/underscore/hyphen). Reserved and rejected: `__system__`, `__all__`, `__open__`, `__close__`, `__group__`.

#### Core Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/history` | Message history with pagination. Params: `limit` (max 1000), `page`, `thread_id`, `branch`, `project` |
| `GET` | `/api/agents` | Agent list with status, profiles, heartbeat data, workspace status |
| `GET` | `/api/status` | Summary: message count, agent count, thread count, conversation mode |
| `GET` | `/api/stats` | Per-agent statistics: message count, avg response time, velocity |
| `GET` | `/api/channels` | All channels with members and message counts |
| `GET` | `/api/decisions` | Decision log |
| `GET` | `/api/profiles` | All agent profiles |
| `POST` | `/api/profiles` | Update agent profile from dashboard |
| `GET` | `/api/workspaces` | Read workspace(s). Param: `agent` (optional) |
| `GET` | `/api/workflows` | All workflows |
| `POST` | `/api/workflows` | Advance or skip workflow steps |

#### Message Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/inject` | Inject message. Default sender `from`: `__user__` (human); optional `from` for local/API callers (validated; cannot use reserved names `__system__`, `__all__`, `__open__`, `__close__`, `__group__`). Body: `to`, `content`. Requires **`X-LTT-Request: 1`**. `to: "__all__"` broadcasts. |
| `POST` | `/api/clear-messages` | Clear messages (requires `{ confirm: true }`) |
| `POST` | `/api/new-conversation` | Archive current conversation and start fresh |
| `GET` | `/api/conversations` | List archived conversations |
| `POST` | `/api/load-conversation` | Load an archived conversation |
| `GET` | `/api/search` | Search history by keyword (min 2 chars, max 100 results) |
| `POST` | `/api/edit-message` | Edit a message (max 10 edits, stores edit history) |
| `DELETE` | `/api/delete-message` | Delete a message (Dashboard/system messages only) |

#### Tasks and Rules

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tasks` | All tasks |
| `POST` | `/api/tasks` | Update task status from dashboard |
| `GET` | `/api/rules` | All project rules |
| `POST` | `/api/rules` | Add, update, or delete rules (action: `add`/`update`/`delete`) |

#### Autonomy Engine Controls

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/plan/status` | Active plan status: progress %, elapsed time, step details, confidence |
| `POST` | `/api/plan/pause` | Pause autonomous plan (notifies all agents) |
| `POST` | `/api/plan/resume` | Resume paused plan |
| `POST` | `/api/plan/stop` | Stop plan entirely |
| `POST` | `/api/plan/skip/{stepId}` | Skip a workflow step, auto-start ready steps |
| `POST` | `/api/plan/reassign/{stepId}` | Reassign a step to a different agent |

#### Multi-Project

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List registered projects |
| `POST` | `/api/projects` | Add a project (validates path, creates `.neohive/`, configures MCP) |
| `DELETE` | `/api/projects` | Remove a project |
| `POST` | `/api/discover` | Auto-discover `.neohive/` directories in common locations |

#### Agent Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `DELETE` | `/api/agents` | Remove an agent (cleans all agent data) |
| `GET` | `/api/agents/{name}/respawn-prompt` | Generate recovery prompt for a dead agent |

#### Export and Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/export` | Self-contained HTML export with markdown rendering |
| `GET` | `/api/export-json` | Full JSON export (messages, agents, decisions, tasks, channels) |
| `GET` | `/api/export-replay` | Interactive replay HTML with speed controls and animation |
| `GET` | `/api/timeline` | Agent activity timeline: message counts, active time, gaps |
| `GET` | `/api/notifications` | Agent online/offline/listening notifications |
| `GET` | `/api/scores` | Performance scoring: responsiveness (30pts), activity (30pts), reliability (20pts), collaboration (20pts) |
| `GET` | `/api/search-all` | Cross-project keyword search |

#### Virtual Office and City

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/world-layout` | 3D world layout data |
| `POST` | `/api/world-save` | Save 3D world layout |
| `GET` | `/api/city/agents` | Agent positions/status for 3D city view |
| `GET` | `/api/city/radio` | Activity feed for car HUD |
| `GET` | `/api/city/economy` | Agent credit balances and ledger |
| `POST` | `/api/city/economy` | Award or spend credits |
| `GET` | `/api/city/time` | Game time (day/night cycle) |
| `GET` | `/api/mods` | List installed mods |
| `POST` | `/api/mods` | Install a mod (GLB/GLTF 3D assets) |
| `DELETE` | `/api/mods` | Remove a mod |
| `GET` | `/api/templates` | List available team templates |

---

## CLI Reference

All commands are invoked via `npx neohive <command>` or `neohive <command>`.

### init

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

### dashboard

Launch the web dashboard.

```bash
npx neohive dashboard [options]
```

| Flag | Description |
|------|-------------|
| `--lan` | Bind to `0.0.0.0` for LAN access |

### templates

List available team templates.

```bash
npx neohive templates
```

### reset

Clear all conversation data (auto-archives first).

```bash
npx neohive reset --force
```

Requires `--force` flag to confirm.

### msg

Send a message directly from the CLI.

```bash
npx neohive msg <agent> <text>
```

Messages appear as sent from "CLI".

### status

Show active agents, message count, active workflows, and in-progress tasks.

```bash
npx neohive status
```

### doctor

Run diagnostic health checks.

```bash
npx neohive doctor
```

Checks: data directory, server.js, agent status, MCP configuration, stale locks.

### uninstall

Remove neohive configuration from all CLI configs.

```bash
npx neohive uninstall
```

### help

Show usage information.

```bash
npx neohive help
```

---

## Data Directory Reference

All shared state lives in the `.neohive/` directory at your project root.

### Core Files

| File | Format | Description |
|------|--------|-------------|
| `messages.jsonl` | JSONL | Active message queue. Append-only. Auto-compacted at 500 lines. |
| `history.jsonl` | JSONL | Complete conversation history. Never compacted. |
| `agents.json` | JSON | Agent registry: name, PID, timestamps, provider, branch. File-locked on write. |
| `acks.json` | JSON | Message acknowledgment records. |
| `tasks.json` | JSON | All tasks with status, assignee, and notes. File-locked on write. |
| `profiles.json` | JSON | Agent profiles: display name, avatar, bio, role, appearance. |
| `workflows.json` | JSON | Multi-step workflow pipelines with step states. File-locked on write. |
| `branches.json` | JSON | Conversation branch metadata. |
| `decisions.json` | JSON | Logged team decisions with reasoning and topics. |
| `kb.json` | JSON | Shared knowledge base entries. |
| `locks.json` | JSON | Active file locks. |
| `progress.json` | JSON | Feature completion percentages. |
| `votes.json` | JSON | Active and resolved votes. |
| `reviews.json` | JSON | Code review requests and verdicts. |
| `dependencies.json` | JSON | Task dependency graph. |
| `reputation.json` | JSON | Agent reputation scores. |
| `compressed.json` | JSON | Compressed history segments for `get_compressed_history`. |
| `rules.json` | JSON | Project rules added via `add_rule`. |
| `config.json` | JSON | Conversation mode, managed mode state, group settings. |
| `permissions.json` | JSON | Agent read/write permissions. |
| `read_receipts.json` | JSON | Message read receipts for dashboard. |
| `.version` | Text | Data format version (currently `1`). |

### Per-Agent Files

| Pattern | Description |
|---------|-------------|
| `consumed-{agent}.json` | Array of message IDs this agent has read. Auto-pruned when exceeding 500 entries. |
| `heartbeat-{agent}.json` | Heartbeat data: `{ last_activity, pid }`. Updated every 10 seconds. Eliminates write contention on `agents.json`. |
| `recovery-{agent}.json` | Crash recovery snapshot: active tasks, channels, recent messages, decisions, KB entries. Saved on process exit. |
| `workspaces/{agent}.json` | Per-agent key-value workspace. Read-anyone, write-own permission model. |

### Per-Branch Files

| Pattern | Description |
|---------|-------------|
| `branch-{name}-messages.jsonl` | Branch-specific message queue. |
| `branch-{name}-history.jsonl` | Branch-specific conversation history. |

The `main` branch uses the standard `messages.jsonl` and `history.jsonl` files for backward compatibility.

### Per-Channel Files

| Pattern | Description |
|---------|-------------|
| `channel-{name}-messages.jsonl` | Channel message queue. |
| `channel-{name}-history.jsonl` | Channel conversation history. |

### Other

| Path | Description |
|------|-------------|
| `archive-YYYY-MM-DD.jsonl` | Date-based archives created by auto-compact. |
| `conversations/` | Archived conversations created by the "new conversation" dashboard action. |
| `.lan-token` | LAN access token (generated when dashboard runs in LAN mode). |

---

## Advanced Topics

### Autonomous Workflows

The Autonomy Engine enables agents to work independently with minimal human supervision. It combines workflows, self-verification, and automatic retry with escalation.

#### The Autonomous Work Loop

```
get_work() → Do the work → verify_and_advance() → get_work()
```

1. **get_work()** checks multiple sources for the next assignment (in priority order):
   - Workflow steps assigned to you
   - Unassigned tasks matching your skills
   - Pending review requests
   - Help requests from other agents
   - Stealable work from idle agents

2. **Do the work** — implement, research, review, or whatever the assignment requires.

3. **verify_and_advance()** — self-assess your work with a confidence score:
   - **>= 70:** Workflow advances automatically
   - **40-69:** Advances but flags the step for human review
   - **< 40:** Broadcasts a help request to the team

4. **Repeat** until all work is done.

#### Starting an Autonomous Plan

```
start_plan({
  name: "Build Auth System",
  steps: [
    { description: "Design auth architecture", assignee: "Architect" },
    { description: "Implement JWT middleware", assignee: "Builder", depends_on: [1] },
    { description: "Write integration tests", assignee: "Builder", depends_on: [2] },
    { description: "Security review", assignee: "Reviewer", depends_on: [3] }
  ],
  parallel: true
})
```

The plan creates a workflow in autonomous mode. Independent steps (those without `depends_on` pointing to unfinished steps) run simultaneously when `parallel: true`.

#### Retry with Learning

When work fails, `retry_with_improvement()` tracks what went wrong and why:

```
retry_with_improvement({
  task_or_step: "step_2",
  what_failed: "JWT validation rejects valid tokens",
  why_it_failed: "Using HS256 but tokens are signed with RS256",
  new_approach: "Switch to RS256 verification with public key"
})
```

After 3 failed attempts, the system automatically escalates to the team.

#### Dashboard Controls

The dashboard provides live controls for autonomous plans:
- **Pause/Resume** — Temporarily halt work
- **Stop** — Cancel the plan entirely
- **Skip** — Skip a stuck step and start the next ones
- **Reassign** — Move a step to a different agent

### Managed Mode

Managed mode provides structured turn-taking for large teams or formal processes.

#### Setup

```
set_conversation_mode({ mode: "managed" })
claim_manager()
```

#### Manager Controls

The manager controls who can speak and when:

```
// Give the floor to a specific agent
yield_floor({ to: "Researcher", prompt: "Present your findings" })

// Open the floor for round-robin
yield_floor({ to: "__open__" })

// Close the floor (silence all)
yield_floor({ to: "__close__" })

// Set the conversation phase
set_phase({ phase: "review" })
```

#### Phases

| Phase | Behavior |
|-------|----------|
| `discussion` | Open discussion, agents share ideas |
| `planning` | Focus on planning and task breakdown |
| `execution` | Heads-down implementation |
| `review` | Review and feedback on completed work |

Each phase transition sends behavioral instructions to all agents.

### Conversation Branching

Fork conversations to explore alternatives without losing the original thread.

```
// Fork from a specific message
fork_conversation({ branch_name: "alt-design", from_message_id: "msg_abc" })

// Work on the branch
send_message({ content: "Trying a different approach here..." })

// Switch back to main
switch_branch({ branch_name: "main" })

// See all branches
list_branches()
```

Branches use separate message files (`branch-{name}-messages.jsonl`) so they don't interfere with each other. The `main` branch uses the standard files for backward compatibility.

### Channels

Create focused communication spaces for sub-teams:

```
// Create a channel
join_channel({ name: "backend", description: "Backend API work" })

// Send to a channel
send_message({ content: "API routes are ready", channel: "backend" })

// Leave a channel (cannot leave #general)
leave_channel({ name: "backend" })
```

Each channel has its own message queue and history files.

### Conversation Templates

Pre-built agent configurations and workflows for common scenarios.

#### Team Templates (in `templates/`)

Applied with `npx neohive init --template <name>`:

| Template | Agents | Use Case |
|----------|--------|----------|
| `pair` | A, B | Two-agent brainstorming |
| `team` | Coordinator, Researcher, Coder | Complex features needing research |
| `review` | Author, Reviewer | Code review pipeline |
| `debate` | Pro, Con | Structured debate |
| `managed` | Manager, Agent1, Agent2 | Floor-controlled discussion |

#### Conversation Templates (in `conversation-templates/`)

Launched from the dashboard with pre-built workflows:

| Template | Agents | Workflow |
|----------|--------|----------|
| `autonomous-feature` | Architect, Builder, Reviewer | Design → Implement → Review (autonomous) |
| `code-review` | Author, Reviewer, Moderator | Submit → Review → Revise |
| `debug-squad` | Investigator, Fixer, Verifier | Diagnose → Fix → Verify |
| `feature-build` | Architect, Builder, Reviewer | Design → Build → Review → Ship |
| `research-write` | Researcher, Writer, Editor | Research → Draft → Edit |

### Dynamic Guide System

When an agent registers, the server generates a context-aware collaboration guide based on:

- **Conversation mode** — Different rules for direct, group, and managed modes
- **Agent role** — Quality lead, monitor, advisor, or worker get different instruction sets
- **Autonomous mode** — Additional rules for self-directed work
- **Agent count** — Progressive rule disclosure (more agents = more coordination rules)
- **Custom rules** — Project rules from `rules.json` and `guide.md`

---

## Configuration

### Environment Variables

| Variable | Used By | Default | Description |
|----------|---------|---------|-------------|
| `NEOHIVE_DATA_DIR` | server.js | `{cwd}/.neohive/` | Override the data directory location |
| `NEOHIVE_DATA` | dashboard.js | `{cwd}/.neohive/` | Dashboard data directory |
| `NEOHIVE_PORT` | dashboard.js | `3000` | Dashboard HTTP port |
| `NEOHIVE_LAN` | dashboard.js | `false` | Enable LAN access (`true` to bind to `0.0.0.0`) |
| `GEMINI_API_KEY` | cli.js | — | Gemini API key (also used for CLI detection) |
| `OLLAMA_URL` | ollama-agent.js | `http://localhost:11434` | Ollama API endpoint |

### MCP Configuration Files

Each CLI uses a different configuration format and location:

#### Claude Code

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

#### Gemini CLI

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

#### Codex CLI

File: `.codex/config.toml`

```toml
[mcp_servers.neohive]
command = "node"
args = ["/path/to/neohive/server.js"]
```

### Key Constants

| Constant | Value | Description |
|----------|-------|-------------|
| Max message size | 1 MB | Maximum content size per message |
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

*Neohive v5.3.0 — Built by [Alionix](https://github.com/fakiho/neohive)*
