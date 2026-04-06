---
name: conventions
description: Neohive multi-agent collaboration conventions. Automatically loaded when working in a multi-agent team to ensure proper tool usage, communication patterns, and workflow management.
user-invocable: false
---

## Neohive Collaboration Conventions

When working as part of a Neohive multi-agent team:

1. **Register and get briefing first** — call `register()` then `get_briefing()` before any other action
2. **Always call `listen()` as the LAST tool call of every response** — no exceptions, all agents
3. **Handle `retry: true`** — if `listen()` returns `{retry: true}`, call `listen()` again immediately
4. **Use `listen()` to complete tasks** — pass outcome params instead of a separate update_task call:
   - `listen(outcome="completed", task_id="...", summary="one line of what was done")`
   - `listen(outcome="blocked", task_id="...", summary="what is blocking you")`
5. **Update task to in_progress when starting** — call `update_task(id, status="in_progress")` when you pick up a task
6. **Lock files before editing** — call `lock_file(path)` before editing, `unlock_file(path)` after
7. **Report completions via send_message** — after finishing a task send the coordinator: what changed, files modified, decisions made
8. **Use KB for shared knowledge** — `kb_write()` for findings and decisions, `kb_read()` before starting work to avoid duplication
9. **Never work on another agent's task** — check `list_tasks()` first
10. **Keep messages concise** — 2–3 paragraphs max

### listen() outcome loop

```
register → get_briefing → listen → pick up task → update_task(in_progress)
→ do work → send_message(coordinator, report) → listen(outcome="completed", task_id, summary)
                                                                          ↑ always last
```
