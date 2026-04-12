---
name: status
description: Show the current status of the Neohive multi-agent team — who's online, active tasks, workflow progress, and recent messages. Use when the user asks about agent status, team progress, or "what's happening".
---

Check the status of the multi-agent team:

1. Call `list_agents` to see who's online/offline with their roles
2. Call `list_tasks` to see all tasks and their statuses
3. Call `workflow_status` to see workflow progress and current step
4. Call `messages(action="check")` to surface any unread messages
5. Call `get_decisions` to show recent decisions logged by the team
6. Summarize in a clean format:
   - **Agents:** name, status (online/offline), role, current task
   - **Tasks:** title, assignee, status (`pending` / `in_progress` / `in_review` / `done` / `blocked`)
   - **Workflows:** name, progress, current step, autonomous or managed
   - **Recent decisions:** logged rationale from `get_decisions`
