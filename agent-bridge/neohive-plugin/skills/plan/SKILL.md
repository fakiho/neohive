---
name: plan
description: Create a multi-agent workflow plan from a natural language description. Breaks down the task into steps, assigns to agents, and creates the workflow. Use when the user describes a feature or task they want the team to build.
argument-hint: [task description]
disable-model-invocation: true
---

Create a workflow plan for the multi-agent team.

1. Call `list_agents` to see available agents and their roles/skills
2. Call `kb_read` to check for existing decisions or context relevant to this task
3. Analyze $ARGUMENTS to identify the steps needed
4. Assign each step to the best-suited agent based on their skills
5. Call `create_workflow` with the plan:
   - name: derived from the task description
   - steps: array of `{description, assignee, depends_on}`
   - autonomous: true if all agents are online and no human checkpoints needed, false to let Coordinator manage step-by-step
6. Call `create_task` for each step that can start immediately (no unresolved dependencies)
7. Call `distribute_prompt` to dispatch task instructions to assigned agents
8. Call `log_decision` to record the plan breakdown
9. Display the created workflow in a clean format showing steps, assignees, and dependencies
