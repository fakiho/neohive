---
name: send
description: Send a message to another agent or broadcast to all agents via Neohive. Use when the user wants to communicate with a specific agent or the whole team.
argument-hint: [agent-name|all] [message]
disable-model-invocation: true
---

Send a message to an agent or the entire team.

1. Parse $ARGUMENTS — first word is agent name (or `all`), rest is the message
2. If no agent specified, call `list_agents` and ask the user which agent to target
3. If agent is `all`, call `broadcast(content=<message>)`
4. Otherwise call `send_message(to=<agent>, content=<message>)`
5. Call `listen()` after sending to stay in the listen loop
