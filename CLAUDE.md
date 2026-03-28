# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**Neohive** — an MCP server + web dashboard that lets multiple AI CLI terminals (Claude Code, Gemini CLI, Codex CLI) communicate with each other. Each terminal spawns its own server process via stdio; all processes read/write to a shared `.neohive/` directory on disk.

## Commands

```bash
# Install in any project (auto-detects CLI type)
npx neohive init
npx neohive init --all     # Configure for all CLIs
npx neohive init --template team  # Init with team template

# Launch the web dashboard
npx neohive dashboard

# List available agent templates
npx neohive templates

# Plugin management
npx neohive plugin list/add/remove/enable/disable

# Reset conversation data
npx neohive reset

# Run MCP server directly (normally launched automatically by CLI)
npm start
```

No tests, linter, or build step. Raw Node.js (CommonJS).

## Architecture

**Core files:**
- `server.js` — MCP server (70+ built-in tools, StdioServerTransport, heartbeat system)
- `lib/` — Shared modules (`config`, `messaging`, `file-io`, …); prefer adding logic here and requiring from `server.js`
- `dashboard.js` — HTTP server for web dashboard (multi-project, message injection, SSE real-time, tasks/workflows/workspaces API)
- `dashboard.html` — Single-page frontend (markdown rendering, agent monitoring, profiles, workspaces, workflows, responsive)
- `cli.js` — CLI entry point with multi-CLI auto-detection

**Multiple MCP server processes, one shared filesystem:**
- Each CLI terminal spawns its own `server.js` process
- In-memory state: `registeredName`, `lastReadOffset`, `heartbeatInterval`, `messageSeq`
- Shared disk state in `.neohive/`:
  - `messages.jsonl` / `history.jsonl` — messages and conversation history (append-only)
  - `agents.json` — agent registration, heartbeats, PID tracking
  - `acks.json` — message acknowledgments
  - `tasks.json` — task management
  - `consumed-{agent}.json` — per-agent read tracking
  - `profiles.json` — agent profiles (display_name, avatar, bio, role)
  - `workspaces/{agent}.json` — per-agent key-value workspace storage
  - `workflows.json` — multi-step workflow pipelines
  - `branches.json` — branch metadata
  - `branch-{name}-messages.jsonl` / `branch-{name}-history.jsonl` — per-branch message files
  - `plugins.json` — plugin registry
  - `plugins/*.js` — plugin code files
- Dashboard reads the same directory for real-time monitoring via SSE

**Data directory resolution (server.js + dashboard.js):**
1. `$NEOHIVE_DATA_DIR` / `$NEOHIVE_DATA` env var
2. `{cwd}/.neohive/` (project-local, default)
3. Legacy fallback: `{__dirname}/data/`

## Code & Commit Rules

When committing changes, you MUST ALWAYS follow the Conventional Commits format:
`<type>(<optional scope>): <description>`
Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

## Neohive Agent Rules (when acting as an agent)

When operating as a neohive agent (after calling `register()`):

**YOU MUST call `listen()` as the LAST tool call of every response.** No exceptions.

- After `send_message(...)` → immediately call `listen()`
- After `update_task(..., status="done")` → immediately call `listen()`
- After `advance_workflow(...)` → immediately call `listen()`

Workflow loop:
```
register → get_briefing → listen → do work → send_message(summary) → listen
                                                                        ↑ always
```

If `listen()` times out with `retry: true` — call `listen()` again immediately.

## Available Neohive MCP Tools

### 1. Agent Lifecycle & Messaging
`register`, `list_agents`, `send_message`, `broadcast`, `wait_for_reply`, `listen`, `listen_group`, `check_messages`, `consume_messages`, `get_notifications`, `get_history`, `share_file`

### 2. Autonomy & Workflows (Proactive Engine)
`start_plan`, `get_work`, `verify_and_advance`, `retry_with_improvement`, `create_workflow`, `advance_workflow`, `workflow_status`

### 3. Task Management
`create_task`, `update_task`, `list_tasks`

### 4. Profiles & Workspaces
`update_profile`, `workspace_write`, `workspace_read`, `workspace_list`

### 5. Chat Branching & Managed Modes
`fork_conversation`, `switch_branch`, `list_branches`, `set_conversation_mode`, `claim_manager`, `yield_floor`, `set_phase`

### 6. Sub-channels
`join_channel`, `leave_channel`, `list_channels`

### 7. File Safety & Auditing
`lock_file`, `unlock_file`, `log_violation`

### 8. Shared Knowledge & Decision Tracking
`kb_write`, `kb_read`, `kb_list`, `log_decision`, `get_decisions`, `get_compressed_history`, `get_briefing`

### 9. Team Governance (Voting, Reviews, Feedback)
`request_review`, `submit_review`, `call_vote`, `cast_vote`, `vote_status`, `request_push_approval`, `ack_push`

### 10. Dependencies & Progress
`declare_dependency`, `check_dependencies`, `update_progress`, `get_progress`, `get_reputation`

## Key Design Decisions

- **Append-only writes** for messages/history (no file locking)
- **Per-agent consumed tracking** — each agent writes only its own consumed file
- **PID-based stale detection** + process exit cleanup for instant status
- **Heartbeat** — 10s interval updates `last_activity`, `.unref()` prevents zombie processes
- **Flexible agent names** — any alphanumeric (1-20 chars), validated by `sanitizeName()`
- **Auto-routing** — `to` optional with 2 agents, required with 3+
- **Threading** — `reply_to` auto-computes `thread_id`
- **Acknowledgments** — `ack_message` in `acks.json`, shown in history
- **Multi-CLI** — init auto-detects Claude Code, Gemini CLI, Codex CLI
- **Multi-project dashboard** — monitor multiple project folders from one dashboard
- **SSE real-time** — `fs.watch()` on data dir pushes updates via Server-Sent Events
- **Auto-compact** — messages.jsonl compacted when exceeding 500 lines
- **Auto-archive** — conversations archived before reset
- **Context hints** — warns agents when conversation exceeds 50 messages
- **Task management** — structured task creation, assignment, and tracking between agents
- **Profiles** — separate `profiles.json` to avoid heartbeat write conflicts with `agents.json`
- **Workspaces** — per-agent files (`workspaces/{agent}.json`) to avoid write conflicts, read-anyone/write-own permission model
- **Workflows** — step statuses: pending/in_progress/done, auto-handoff on advance
- **Branching** — `main` branch uses existing files for backward compatibility, branch-aware file resolution via `getMessagesFile(branch)`/`getHistoryFile(branch)`
- **Plugins** — sandboxed execution context with 30s timeout, tools appear as `plugin_{name}` in MCP

## Debugging and fix attempts

- **Temporary logs:** When debugging, add only the logging needed to confirm behavior. **Remove or trim that logging** once the issue is understood or fixed—do not leave ad-hoc debug prints in the tree unless they match intentional, documented logging (e.g. MCP stderr lines).
- **Failed fixes:** If the user says a change **did not** fix the problem, **revert** that attempt before trying something else (`git restore` / undo the diff). **Do not stack** speculative fixes; revert first, then apply one minimal, well-motivated change.
