---
name: plan
description: Create a multi-agent workflow plan from a natural language description. Breaks down the task into steps, assigns to agents, and creates the workflow. Use when the user describes a feature or task they want the team to build.
argument-hint: [task description]
disable-model-invocation: true
---

Create a workflow plan for the multi-agent team.

1. Call `list_agents` to see available agents and their roles/skills
2. Analyze $ARGUMENTS to identify the steps needed
3. Assign each step to the best-suited agent based on their skills
4. Call `create_workflow` with the plan:
   - name: derived from the task description
   - steps: array of {description, assignee, depends_on}
   - autonomous: false (let Coordinator manage)
5. Call `create_task` for each immediate step
6. Send messages to assigned agents with their first task
7. Display the created plan in a clean format
