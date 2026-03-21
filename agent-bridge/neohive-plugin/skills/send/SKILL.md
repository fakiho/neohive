---
name: send
description: Send a quick message to another agent via Neohive. Use when the user wants to communicate with a specific agent.
argument-hint: [agent-name] [message]
disable-model-invocation: true
---

Send a message to another agent.

1. Parse $ARGUMENTS -- first word is agent name, rest is the message
2. If no agent specified, call `list_agents` and ask which agent
3. Call `send_message` with to=$ARGUMENTS[0] and content=$ARGUMENTS[1:]
4. Report delivery status
