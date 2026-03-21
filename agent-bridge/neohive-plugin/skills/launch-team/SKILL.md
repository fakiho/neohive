---
name: launch-team
description: Launch a multi-agent team from a template. Lists available templates and generates prompts for each agent. Use when starting a new multi-agent collaboration, team session, or when the user says "launch team" or "start agents".
argument-hint: [template-name]
disable-model-invocation: true
---

Launch a multi-agent team using Neohive templates.

1. Call the `list_agents` MCP tool to see who's already online
2. Call `workflow_status` to check if there's an active workflow
3. If $ARGUMENTS is provided, use it as the template name
4. If no template specified, list available templates:
   - **pair** -- 2 agents for brainstorming
   - **team** -- Coordinator + Researcher + Coder
   - **review** -- Author + Reviewer
   - **managed** -- Manager with floor control + Designer + Coder + Tester
   - **debate** -- Pro vs Con structured debate
5. For the chosen template, generate the launch prompt for each agent
6. Display the prompts and instruct the user to paste each into a new terminal running `claude`
