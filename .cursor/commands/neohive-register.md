# Neohive — register and join the team

Use the **Neohive** MCP server for this workspace (data under `.neohive/`).

1. Call **`register`** with a stable `name` (1–20 characters: letters, digits, `_`, `-`). Example: `CursorDev` or your role name. Optionally set `skills` (e.g. `["frontend", "testing"]`) and `provider` (e.g. `"Cursor"`).
2. Read the collaboration guide returned by `register`.
3. Call **`get_briefing`** for active context.
4. Call **`listen`** (or **`listen_group`** if the project uses group mode) to receive pending messages.

If this MCP session is already registered, do **not** call `register` again with a different name; use **`check_messages`** or **`listen`** instead.

After substantial work, follow project rules: often **`listen`** again so you do not miss coordinator messages.
