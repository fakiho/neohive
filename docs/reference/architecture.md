> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# Architecture

## System Design

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

## Process Model

Each CLI terminal spawns its own `server.js` process via stdio MCP transport. These processes are fully independent — they share no memory. All coordination happens through files in the `.neohive/` directory.

**Per-process in-memory state:**
- `registeredName` — This agent's name
- `lastReadOffset` — Byte offset into messages.jsonl (for efficient polling)
- `channelOffsets` — Per-channel byte offsets
- `heartbeatInterval` — 10-second timer (`.unref()` prevents zombie processes)
- `messageSeq` — Monotonic counter for message ordering
- `currentBranch` — Active conversation branch
- `_cache` — Read cache with configurable TTL (eliminates 70%+ redundant disk I/O)

## Data Flow

### Message Lifecycle

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

### Broker semantics (patterns & scale)

Neohive is not a network message broker; it is a **local blackboard** with **pull-based delivery**. Mapping to common patterns:

| Pattern | How Neohive implements it |
|--------|----------------------------|
| **Blackboard** | Append-only `messages.jsonl` / `history.jsonl`; agents **read** and **filter** for rows relevant to them (plus per-agent `consumed-*.json`). |
| **Pub/sub (topics)** | **Channels** (`join_channel`, channel-specific JSONL) approximate topics; `broadcast` / `to: __group__` is a team-wide “fan-out” with a single stored row in **group** mode. |
| **Orchestrator–worker** | **Direct** `send_message(..., to: "Agent")`, **tasks** / **workflows**, and (in **managed** mode) **floor** / **phase** controls—see [Advanced](./advanced.md#managed-mode). |
| **Durable routing** | Prefer **tasks.json** and **workflows.json** for “who owns what”; chat lines are for coordination and should stay concise (`get_compressed_history` helps). |

**Permissions:** Optional `permissions.json` enforces `can_write_to` / `can_read` between names; `send_message` and `broadcast` skip disallowed edges via `canSendTo()`.

**Scale (20+ live agents):** Delivery filtering becomes stricter for `__group__` rows so terminals are not flooded: an agent still sees system messages, rows **addressed** to them (`addressed_to`), messages on **channels** they joined, lines that mention a **task id** they have **in_progress**, and handoff / workflow-style markers. Unaddressed group chatter may be hidden—**use explicit `to` or `addressed_to` semantics** on large teams.

**Robustness mechanisms (server):** Per-agent rate limits and near-duplicate suppression reduce storms; **group** mode uses adaptive cooldowns; **managed** mode adds turn-taking so orchestration stays orderly at the protocol level.

### File Access Patterns

- **Append-only:** Messages and history use JSONL (one JSON object per line). Multiple processes can safely append without file locking.
- **Locked writes:** Structured JSON files (agents.json, tasks.json, workflows.json) use file locking with exponential backoff.
- **Per-agent files:** Consumed IDs and workspaces use per-agent files to eliminate write contention entirely.

## Data Directory Resolution

The `.neohive/` directory location is resolved in this priority order:

1. `$NEOHIVE_DATA_DIR` environment variable
2. `{current working directory}/.neohive/` (project-local, default)
3. Legacy fallback: `{package directory}/data/`
