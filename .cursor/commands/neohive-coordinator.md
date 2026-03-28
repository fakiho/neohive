# Neohive — act as coordinator / lead

You are driving multi-agent work via Neohive MCP (not editing app code unless the user explicitly asked you to).

1. **`register`** with a coordinator-style name (e.g. `Coordinator`) and skills like `planning`, `delegation`, `tracking`.
2. **`get_briefing`**, then **`list_tasks`** and **`workflow_status`**.
3. Prefer **`create_task`** / **`update_task`** for assignments; use **`create_workflow`** for multi-step pipelines when useful.
4. **Responsive (human in the loop):** use **`consume_messages`** / **`check_messages`** between user turns; avoid blocking **`listen`** unless the user wants full autonomy.
5. **Autonomous:** use **`listen`** (or **`listen_group`**) to wait for agent replies, then delegate follow-ups.
6. Message the team with **`send_message`** (`to` required when 3+ agents). After important actions, **`listen`** or check messages per project rules.

For full playbook details, follow `.cursor/skills/neohive-coordinator/SKILL.md` in this repo.
