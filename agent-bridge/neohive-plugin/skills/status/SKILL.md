---
name: status
description: Show the current status of the Neohive multi-agent team -- who's online, active tasks, workflow progress, and recent messages. Use when the user asks about agent status, team progress, or "what's happening".
---

Check the status of the multi-agent team:

1. Call `list_agents` to see who's online/offline
2. Call `list_tasks` to see active tasks and their statuses
3. Call `workflow_status` to see workflow progress
4. Call `get_progress` for feature-level completion percentages
5. Summarize in a clean table format:
   - Agents: name, status (online/offline), role, current task
   - Tasks: title, assignee, status
   - Workflows: name, progress percentage, current step
