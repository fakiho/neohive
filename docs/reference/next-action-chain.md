> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# next\_action Response Chain

Every MCP tool response includes a `next_action` field — a single, unambiguous instruction telling the AI agent exactly what to do next. This replaces the previous scattered hint system (`_listen`, `_nudge`, `hint`, `action_required`, `unread_action`, etc.) with one consistent signal.

## Why

AI agents cherry-pick fields from JSON responses. When six different fields all suggest different things, the agent ignores most of them. A single top-level `next_action` field is impossible to miss and creates an unbreakable chain of actions — every tool output leads directly to the next tool input.

## How It Works

### Priority Order

When multiple conditions apply, the highest-priority `next_action` wins:

```
1. BLOCKED (15+ calls without listen) → early return, tool not executed
2. Tool-specific next_action           → set by the tool handler itself
3. Warning (10+ calls without listen)  → "WARNING: N calls without listen(). BLOCKED at 15."
4. Urgent pending messages (>2 min)    → "URGENT: N message(s) waiting. Call listen() now."
5. Any pending messages                → "N unread message(s). Call listen()."
6. Default                             → "Call listen() to receive messages."
```

For responsive coordinators, priorities 4–6 are replaced with coordinator-specific logic (see [Coordinator Modes](#coordinator-modes) below).

### Where It's Set

There are two places `next_action` can be set:

1. **Tool handler** (specific) — The tool itself sets `result.next_action` before returning. This is the most precise guidance because the tool knows its own context.

2. **Post-processing middleware** (fallback) — If no `next_action` was set by the tool, the middleware in `server.js` injects a default based on pending message state.

The middleware never overwrites a tool-specific `next_action` (except the 10-call warning override for non-coordinators).

---

## Agent Flow (Standard)

Standard agents (non-coordinator, non-autonomous) follow the `listen()` loop. Every tool response chains back to `listen()`.

```
                    ┌─────────────────────────────────────┐
                    │                                     │
                    ▼                                     │
              ┌──────────┐                                │
              │ listen() │ ◄──── timeout: retry: true     │
              └────┬─────┘       next_action: "Call       │
                   │             listen() again."         │
                   │                                      │
            message received                              │
                   │                                      │
                   ▼                                      │
     ┌─────────────────────────────┐                      │
     │ next_action:                │                      │
     │ "Do what this message asks. │                      │
     │  When finished,             │                      │
     │  send_message(to=<sender>)  │                      │
     │  then call listen()."       │                      │
     └─────────────┬───────────────┘                      │
                   │                                      │
                   ▼                                      │
           ┌──────────────┐                               │
           │  Do the work  │                               │
           │  (edit files,  │                               │
           │   run tests)   │                               │
           └───────┬───────┘                               │
                   │                                      │
                   ▼                                      │
     ┌──────────────────────────┐                         │
     │ update_task(id, "done")  │                         │
     │ next_action:             │                         │
     │ "Send a summary via      │                         │
     │  send_message(), then    │                         │
     │  call listen()."         │                         │
     └────────────┬─────────────┘                         │
                  │                                       │
                  ▼                                       │
     ┌──────────────────────────┐                         │
     │ send_message(to=sender)  │                         │
     │ next_action:             │                         │
     │ "Call listen() to        │─────────────────────────┘
     │  receive replies."       │
     └──────────────────────────┘
```

### Block Protection (Call-Count)

If an agent makes 10+ tool calls without calling `listen()`, the middleware overrides `next_action`:

```
Call 10: next_action: "WARNING: 10 calls without listen(). Tools BLOCKED at 15. Call listen() NOW."
Call 14: next_action: "WARNING: 14 calls without listen(). Tools BLOCKED at 15. Call listen() NOW."
Call 15: BLOCKED — tool is not executed. Agent must send_message() then listen() to unblock.
```

### Persistent Listen (Internal Auto-Restart)

`listen()` never returns empty. Instead of returning `{ retry: true }` on timeout and hoping the agent calls `listen()` again, the server **loops internally** — it restarts the file watcher and keeps waiting. The agent stays blocked inside `listen()` until a real message arrives or the IDE/user interrupts the tool call.

```
  Agent calls listen()
       │
       ▼
  ┌─────────────────────────────┐
  │  Wait for messages          │
  │  (fs.watch + heartbeat)     │
  │                             │
  │  5 min cycle expires:       │
  │  ┌─ touch heartbeat        │
  │  ├─ compact if needed      │
  │  ├─ check for messages     │
  │  │   └─ found? → return    │
  │  └─ restart watcher ───────┤ ← loops back, never returns
  │                             │
  │  Message arrives:           │
  │  └─ return to agent ────────┼──► agent processes message
  └─────────────────────────────┘
```

This guarantees the agent **cannot break out of listen mode** by choosing not to call `listen()` again — it never left in the first place.

**Exceptions:**
- **Codex CLI** — has a hard 120s tool timeout. `listen(mode="codex")` returns `retry: true` after 45s because the platform kills the tool call otherwise.
- **Autonomous mode** — returns on timeout so the agent goes back to the `get_work()` loop instead.

---

## Agent-to-Agent Flow

When Agent A sends work to Agent B (not through a coordinator), the chain must not break for either agent.

```
     Agent A                                         Agent B
     ═══════                                         ═══════

  update_task("done")
  next_action: "send_message()"
        │
        ▼
  send_message(to=B, "results...")
  next_action: "Call listen()."
        │                                         listen()
        │               ┌─────────────────────►  receives message
        │               │                         next_action:
        ▼               │                         "Do what this message asks.
  listen()              │                          When finished,
  (waits for reply)     │                          send_message(to=A)..."
        │               │                              │
        │               │                              ▼
        │               │                         Does the work
        │               │                              │
        │               │                              ▼
        │               │                         send_message(to=A, "done...")
        │               │                         next_action: "Call listen()."
        │               │                              │
  receives reply  ◄─────┘                              ▼
  next_action:                                    listen()
  "Do what this message                           (waits for next message)
   asks..."
        │
        ▼
  (continues work)
```

The key insight: `send_message()` always returns `next_action: "Call listen()"`, and `listen()` always tells the agent to reply to the sender and then listen again. This creates a closed loop.

---

## Coordinator Modes

Coordinators (agents with role `lead`, `manager`, or `coordinator`) have two operational modes that fundamentally change their `next_action` chain.

### Responsive Mode (default)

The coordinator stays with the human user. It does **not** call `listen()` — instead it polls for agent updates non-blockingly with `consume_messages()`.

```
     Human User                    Responsive Coordinator              Worker Agent
     ══════════                    ══════════════════════              ════════════

  "Deploy feature X"
        │
        ▼
                              create_task("Deploy X", agent=Worker)
                              next_action: "Call listen()."
                              ──── OVERRIDDEN by middleware ────
                              (coordinator is responsive, so no
                               default next_action is injected
                               unless agents have pending messages)
                                        │
                                        │  If pending messages exist:
                                        │  next_action: "2 agent update(s)
                                        │   waiting. Call consume_messages()."
                                        │
                                        │  If no pending messages:
                                        │  (no next_action — follows
                                        │   the human's lead)
                                        │
                                        ▼
                              Replies to human: "Task created."
                                                                     listen()
                                                                     receives handoff
                                                                     next_action: "Do this work."
                                                                          │
                                                                          ▼
                                                                     Does the work
                                                                          │
                                                                          ▼
                                                                     send_message(to=Coordinator)
                                                                     next_action: "Call listen()."
                                                                          │
                                                                          ▼
                                                                     listen()

  "How's the deploy going?"
        │
        ▼
                              consume_messages()
                              ──► reads worker's status update
                              next_action: "Process these updates,
                               then respond to the user."
                                        │
                                        ▼
                              Replies to human: "Worker reports..."
```

**Middleware behavior for responsive coordinators:**
- `next_action` from tool handlers is preserved as-is
- If no tool-specific `next_action`: suggests `consume_messages()` only when agents have pending updates
- The 3-call `listen()` warning is **not** applied
- The 5-call block threshold is **not** applied

### Autonomous Mode

The coordinator runs in a `listen()` loop, just like worker agents. It receives agent reports, makes decisions, and delegates — all autonomously.

```
     Autonomous Coordinator                          Worker Agent
     ══════════════════════                          ════════════

  listen()
  receives agent report
  next_action: "Do what this message
   asks. When finished,
   send_message(to=Worker)..."
        │
        ▼
  Reviews report, creates next task
  create_task("Next step", agent=Worker)
  next_action: "Call listen()."
        │
        ▼
  send_message(to=Worker, "instructions")
  next_action: "Call listen()."
        │                                         listen()
        │               ┌─────────────────────►  receives instructions
        ▼               │                         next_action: "Do this work..."
  listen()              │                              │
  (waits for next       │                              ▼
   agent report)        │                         Does the work
        │               │                              │
        │               │                              ▼
        │               │                         update_task(done)
        │               │                         next_action: "send_message()"
        │               │                              │
        │               │                              ▼
        │               │                         send_message(to=Coordinator)
        │               │                         next_action: "Call listen()."
  receives report ◄─────┘                              │
  next_action: "Do what                                ▼
   this message asks..."                          listen()
        │
        ▼
  (cycle repeats)
```

**Middleware behavior for autonomous coordinators:**
- Same as standard agents — always chains back to `listen()`
- The 3-call warning and 5-call block apply normally

---

## Autonomous Workflow (get\_work loop)

Agents in autonomous workflows use `get_work()` instead of `listen()`. The `next_action` chain adapts:

```
  get_work()
  ─── returns one of: ──────────────────────────────────────────┐
  │                                                              │
  ├─ workflow_step     → next_action: "Do this work now.        │
  │                       When done, call verify_and_advance()." │
  │                                                              │
  ├─ claimed_task      → next_action: "Start working on this.   │
  │                       Call verify_and_advance() when done."  │
  │                                                              │
  ├─ messages          → next_action: "Process these messages,   │
  │                       then call get_work() again."           │
  │                                                              │
  ├─ help_teammate     → next_action: "Help your teammate,      │
  │                       then call get_work() again."           │
  │                                                              │
  ├─ review            → next_action: "Review this work,         │
  │                       then call submit_review()."            │
  │                                                              │
  ├─ idle              → next_action: "Call get_work() again     │
  │                       in 90 seconds."                        │
  │                                                              │
  └─ (7 more types)    → each has a specific next_action         │
                                                                 │
  After work:                                                    │
  verify_and_advance()                                           │
  next_action: "Call get_work() for your next assignment."───────┘
```

---

## Tool-Specific next\_action Reference

| Tool | next\_action |
|------|-------------|
| `register` | Dynamic based on mode and recovery state |
| `listen` (message received) | `"Do what this message asks. When finished, send_message(to=<sender>)... then call listen()."` |
| `listen` (timeout) | `"Call listen() again."` |
| `send_message` | `"Call listen() to receive replies."` |
| `broadcast` | `"Call listen() to receive replies."` |
| `create_task` | `"Call listen() to receive updates."` |
| `update_task` (done) | `"Send a summary of what you did via send_message(), then call listen()."` |
| `update_task` (in\_progress) | `"Do the work on <title>, then call update_task(<id>, 'done') when finished."` |
| `update_task` (blocked) | `"Send a message explaining the blocker, then call listen()."` |
| `lock_file` | `"Edit the file, then call unlock_file() when done."` |
| `get_briefing` | `"Call listen() to receive messages and start working."` |
| `get_work` | Varies by return type (see [Autonomous Workflow](#autonomous-workflow-get_work-loop)) |
| `verify_and_advance` | `"Call get_work() for your next assignment."` |
| `create_workflow` | `"Call get_work() for your assignment."` (autonomous) / `"Call listen()."` (standard) |
| `advance_workflow` | `"Call get_work()."` (autonomous) / `"Call listen()."` (standard) |
| `request_review` | `"Call listen() to wait for the review."` |
| `submit_review` (approved) | `"Call listen() to continue."` |
| `submit_review` (changes\_requested) | `"Call listen() — the author will fix and resubmit."` |
| `check_messages` | `"Call listen() to receive and process these messages."` |
| `consume_messages` | *(no override — middleware injects based on context)* |

---

## Files Changed

| File | Changes |
|------|---------|
| `agent-bridge/server.js` | Middleware rewrite, listen responses, send\_message, broadcast, get\_work (10 paths), verify\_and\_advance, buildMessageResponse, buildListenGroupResponse |
| `agent-bridge/tools/tasks.js` | `create_task`, `update_task` (status-dependent) |
| `agent-bridge/tools/workflows.js` | `create_workflow`, `advance_workflow` |
| `agent-bridge/tools/governance.js` | `request_review`, `submit_review` |
| `agent-bridge/tools/knowledge.js` | `get_briefing`, `get_compressed_history` (replaced `hint`) |
| `agent-bridge/tools/safety.js` | `lock_file` |
| `agent-bridge/tools/messaging.js` | `check_messages` (replaced `action_required`) |

### Fields Removed

| Old field | Where | Replaced by |
|-----------|-------|-------------|
| `_listen` | Post-processing middleware | `next_action` |
| `_nudge` | Post-processing middleware | `next_action` |
| `_pending_messages` | Post-processing middleware | `next_action` |
| `_senders` | Post-processing middleware | `next_action` |
| `_addressed_to_you` | Post-processing middleware | `next_action` |
| `_preview` | Post-processing middleware | `next_action` |
| `unread_messages` | Post-processing middleware | `next_action` |
| `unread_preview` | Post-processing middleware | `next_action` |
| `unread_action` | Post-processing middleware | `next_action` |
| `you_have_messages` | `send_message`, `broadcast` | `next_action` |
| `urgent` | `send_message`, `broadcast` | `next_action` |
| `mode_hint` | `send_message` | `next_action` |
| `hint` | `get_briefing`, `get_compressed_history` | `next_action` |
| `action_required` | `check_messages` | `next_action` |
| `_protocol` | `buildMessageResponse` (inside message obj) | `next_action` (top-level) |
| `message` (text) | `verify_and_advance` returns | `next_action` |
