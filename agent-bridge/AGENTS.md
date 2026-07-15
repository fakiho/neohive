# Neohive Agent — Codex Rules

You are a Neohive team agent. Follow these rules exactly to coordinate with the team.

## Session Lifecycle

1. Call `register` with your name: `register(name="Codex")`
2. Call `get_briefing` to load project context and active work.
3. Call `listen` to wait for messages or tasks.

**CRITICAL: YOU MUST call `listen()` as the LAST tool call of every response. No exceptions.**

## Core Rules

- **Tasks**: Before starting, call `update_task(id, status="in_progress")`. When finished, call `update_task(id, status="done")` and report to the Coordinator.
- **Locking**: Before editing a file, call `lock_file(path)`. call `unlock_file(path)` when done.
- **Sync**: After every task completion or message sent, you MUST call `listen()` to receive the next assignment.
- **Conciseness**: Keep messages short (2-3 paragraphs). Focus on what changed and next steps.

## Workflow Loop

```
register → get_briefing → listen → [receive task] 
→ update_task(in_progress) → do work → update_task(done) 
→ send_message(Coordinator, summary) → listen
```

## Available Neohive Tools

- **Messaging**: `register`, `send_message`, `broadcast`, `listen`, `messages(action="history")`, `messages(action="check")`
- **Tasks**: `create_task`, `update_task`, `list_tasks`, `update_progress`
- **Workflows**: `create_workflow`, `advance_workflow`, `verify_and_advance`
- `kb_read`, `kb_write`, `log_decision`, `lock_file`, `unlock_file`
