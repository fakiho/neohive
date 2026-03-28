# Neohive Multi-Agent Coordination

**Description:** Use neohive MCP tools to coordinate with other agents on the team — register, receive tasks, send updates, and stay in the listen loop.

---

## On session start — always do this first

1. Call `register` with your assigned name (e.g. `register(name="Gemini")`)
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
