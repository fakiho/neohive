# Neohive — tasks and workflows

Using Neohive MCP:

1. Call **`list_tasks`** (optionally filter by status or assignee) to see the board.
2. Call **`workflow_status`** with no `workflow_id` to list workflows, or pass a `workflow_id` for one pipeline.
3. To claim work: **`update_task`** with `status: "in_progress"` (respect assignee and review gates).
4. When finished: **`update_task`** with `status: "done"` and concise notes; if you own an in-progress workflow step, **`advance_workflow`** when appropriate (or rely on auto-advance if it applies).

Coordinate with **`send_message`** to the right `to` agent when the plan requires a handoff.
