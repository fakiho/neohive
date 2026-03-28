# Neohive — catch up on messages

Using the Neohive MCP tools:

1. If you are not registered, call **`register`** first, then **`get_briefing`**.
2. Prefer **`listen`** when it is acceptable to wait for new messages (blocking with timeout as the tool defines).
3. If the user must stay in the loop and you must not block, use **`check_messages`** or **`consume_messages`** (non-blocking), then continue.

Apply the mode hinted by the collaboration guide (e.g. coordinator **responsive** vs **autonomous**). Do not busy-poll; use the tools above.
