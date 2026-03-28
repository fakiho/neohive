---
name: neoHive
description: Neohive multi-agent coordination rules — applied when using neohive MCP tools
tools: vscode/getProjectSetupInfo, vscode/installExtension, vscode/memory, vscode/newWorkspace, vscode/resolveMemoryFileUri, vscode/runCommand, vscode/vscodeAPI, vscode/extensions, vscode/askQuestions, execute/runNotebookCell, execute/testFailure, execute/getTerminalOutput, execute/awaitTerminal, execute/killTerminal, execute/createAndRunTask, execute/runInTerminal, read/getNotebookSummary, read/problems, read/readFile, read/viewImage, read/terminalSelection, read/terminalLastCommand, agent/runSubagent, edit/createDirectory, edit/createFile, edit/createJupyterNotebook, edit/editFiles, edit/editNotebook, edit/rename, search/changes, search/codebase, search/fileSearch, search/listDirectory, search/searchResults, search/textSearch, search/usages, web/fetch, web/githubRepo, browser/openBrowserPage, neohive/ack_message, neohive/add_rule, neohive/advance_workflow, neohive/broadcast, neohive/call_vote, neohive/cast_vote, neohive/check_dependencies, neohive/check_messages, neohive/claim_manager, neohive/consume_messages, neohive/create_task, neohive/create_workflow, neohive/declare_dependency, neohive/distribute_prompt, neohive/fork_conversation, neohive/get_briefing, neohive/get_compressed_history, neohive/get_decisions, neohive/get_guide, neohive/get_history, neohive/get_notifications, neohive/get_progress, neohive/get_reputation, neohive/get_summary, neohive/get_work, neohive/handoff, neohive/join_channel, neohive/kb_list, neohive/kb_read, neohive/kb_write, neohive/leave_channel, neohive/list_agents, neohive/list_branches, neohive/list_channels, neohive/list_rules, neohive/list_tasks, neohive/listen, neohive/listen_codex, neohive/listen_group, neohive/lock_file, neohive/log_decision, neohive/register, neohive/remove_rule, neohive/request_review, neohive/reset, neohive/retry_with_improvement, neohive/search_messages, neohive/send_message, neohive/set_conversation_mode, neohive/set_phase, neohive/share_file, neohive/start_plan, neohive/submit_review, neohive/suggest_task, neohive/switch_branch, neohive/toggle_rule, neohive/unlock_file, neohive/update_profile, neohive/update_progress, neohive/update_task, neohive/verify_and_advance, neohive/vote_status, neohive/wait_for_reply, neohive/workflow_status, neohive/workspace_list, neohive/workspace_read, neohive/workspace_write, neohive/yield_floor, todo # specify the tools this agent can use. If not set, all enabled tools are allowed.
alwaysApply: true
---

# Neohive Agent — Cursor

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

## Code & Commit Rules

When committing changes, you MUST ALWAYS follow the Conventional Commits format:
`<type>(<optional scope>): <description>`
Types: `feat`, `fix`, `refactor`, `docs`, `chore`, `test`

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
