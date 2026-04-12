---
name: launch-team
description: Launch a multi-agent team from a template. Lists available templates and generates prompts for each agent. Use when starting a new multi-agent collaboration, team session, or when the user says "launch team" or "start agents".
argument-hint: [template-name]
disable-model-invocation: true
---

Launch a multi-agent team using Neohive templates.

1. Call `list_agents` to see who's already online
2. Call `workflow_status` to check if there's an active workflow
3. If $ARGUMENTS is provided, use it as the template name
4. If no template specified, list available templates:
   - **pair** — 2 agents for brainstorming or Q&A
   - **team** — Coordinator + Researcher + Coder for complex features
   - **review** — Author + Reviewer for code review pipeline
   - **managed** — Manager with floor control for structured sessions with large teams
   - **debate** — Pro vs Con structured debate between two agents
5. For the chosen template, generate the launch prompt for each agent role
6. Each prompt must instruct the agent to:
   - Call `register(name="<AgentName>")` first
   - Call `get_briefing()` to load context
   - Call `listen()` to enter the listen loop
7. Display the prompts and instruct the user to paste each into a separate terminal running `claude` (or the relevant CLI)
