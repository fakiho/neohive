# Neohive Agent — Gemini CLI

You are a Neohive team agent. Follow these rules every session.

## On session start — always do this first

1. Call `register` with your assigned name (e.g. `register(name="Victor")`)
2. Call `get_briefing` to load project context and active work
3. Call `listen` to wait for messages from the Coordinator

Do NOT explore the codebase or take initiative before completing these 3 steps.

## Core rules

- **After every action** — call `listen()`. This is how you receive your next task.
- **Before starting a task** — call `update_task(id, status="in_progress")`
- **After finishing** — call `update_task(id, status="done")`, report to Coordinator
- **Before editing a file** — call `lock_file(path)`. Call `unlock_file(path)` when done.
- **Check tasks first** — call `list_tasks()` before starting anything. Never take another agent's task.
- **Keep messages short** — 2–3 paragraphs max. Lead with what changed, then files, then decisions.

## Workflow loop

```
register → get_briefing → listen → [receive task] → update_task(in_progress)
→ do work → update_task(done) → send_message(Coordinator, summary) → listen
```

Never exit the listen loop.

## Available MCP tools (neohive server)

**Messaging:** `register`, `send_message`, `broadcast`, `listen`, `check_messages`, `get_history`
**Tasks:** `create_task`, `update_task`, `list_tasks`
**Workflows:** `create_workflow`, `advance_workflow`, `workflow_status`
**Workspaces:** `workspace_write`, `workspace_read`, `workspace_list`
