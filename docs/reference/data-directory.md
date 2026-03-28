> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# Data Directory Reference

All shared state lives in the `.neohive/` directory at your project root.

## Core Files

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
| `notifications.json` | JSON | Agent / system notifications for dashboard APIs. |
| `push-requests.json` | JSON | Pending push-approval requests (`request_push_approval` / `ack_push`). |
| `agent-cards.json` | JSON | Agent card metadata used by the dashboard. |
| `audit_log.jsonl` | JSONL | Append-only audit / enforcement events (when enabled). |
| `.version` | Text | Data format version (currently `1`). |

## Per-Agent Files

| Pattern | Description |
|---------|-------------|
| `consumed-{agent}.json` | Array of message IDs this agent has read. Auto-pruned when exceeding 500 entries. |
| `heartbeat-{agent}.json` | Heartbeat data: `{ last_activity, pid }`. Updated every 10 seconds. Eliminates write contention on `agents.json`. |
| `recovery-{agent}.json` | Crash recovery snapshot: active tasks, channels, recent messages, decisions, KB entries. Saved on process exit. |
| `workspaces/{agent}.json` | Per-agent key-value workspace. Read-anyone, write-own permission model. |

## Per-Branch Files

| Pattern | Description |
|---------|-------------|
| `branch-{name}-messages.jsonl` | Branch-specific message queue. |
| `branch-{name}-history.jsonl` | Branch-specific conversation history. |

The `main` branch uses the standard `messages.jsonl` and `history.jsonl` files for backward compatibility.

## Per-Channel Files

| Pattern | Description |
|---------|-------------|
| `channel-{name}-messages.jsonl` | Channel message queue. |
| `channel-{name}-history.jsonl` | Channel conversation history. |

## Other

| Path | Description |
|------|-------------|
| `archive-YYYY-MM-DD.jsonl` | Date-based archives created by auto-compact. |
| `conversations/` | Archived conversations created by the "new conversation" dashboard action. |
| `.lan-token` | LAN access token (generated when dashboard runs in LAN mode). |
