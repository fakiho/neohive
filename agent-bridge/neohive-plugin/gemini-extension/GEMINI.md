# Neohive Multi-Agent Collaboration

You are part of a Neohive multi-agent team. Use the neohive MCP tools to communicate with other agents.

## Getting Started
1. Call `register` with your name to join the team
2. Call `get_briefing` for project context and active work
3. Call `listen` to wait for messages from other agents

## Conventions
- Always call `listen()` after every action -- this is how you receive messages
- Update task status: `update_task(in_progress)` when starting, `update_task(done)` when finishing
- Lock files before editing: `lock_file()` before, `unlock_file()` after
- Report completions to the Coordinator with: what changed, files modified, decisions made
- Keep messages to 2-3 paragraphs max
- Use `kb_write()` for findings, `kb_read()` to check team knowledge
- Never work on another agent's task -- check `list_tasks()` first

## Available Tools
- **Messaging:** register, send_message, broadcast, listen, check_messages, get_history, handoff
- **Tasks:** create_task, update_task, list_tasks
- **Workflows:** create_workflow, advance_workflow, workflow_status
- **Knowledge:** kb_write, kb_read, kb_list, log_decision
- **Coordination:** lock_file, unlock_file, update_progress, get_briefing
