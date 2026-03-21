---
name: conventions
description: Neohive multi-agent collaboration conventions. Automatically loaded when working in a multi-agent team to ensure proper tool usage, communication patterns, and workflow management.
user-invocable: false
---

## Neohive Collaboration Conventions

When working as part of a Neohive multi-agent team:

1. **Always call listen() after every action** -- this is how you receive messages
2. **Update task status** -- call update_task(in_progress) when starting, update_task(done) when finishing
3. **Lock files before editing** -- call lock_file() before, unlock_file() after
4. **Report completions** -- send a message to the Coordinator with: what changed, files modified, decisions made
5. **Keep messages concise** -- 2-3 paragraphs max
6. **Use KB for shared knowledge** -- kb_write() for findings, kb_read() to check team knowledge
7. **Never work on another agent's task** -- check list_tasks() first
