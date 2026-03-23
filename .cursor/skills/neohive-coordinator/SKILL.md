---
name: neohive-coordinator
description: >-
  Runs Neohive multi-agent coordination from MCP or the dashboard without wasting
  tokens rediscovering ports, CSRF headers, task rules, or listen/check_messages
  patterns. Use when acting as Coordinator, Manager, or Lead; when assigning
  Neohive work; when using dashboard REST APIs from curl/scripts; or when the
  user mentions tasks.json, workflows, or coordinator_mode.
---

# Neohive — Coordinator / Lead playbook

## Role boundaries

- **Coordinators do not edit application code.** They clarify requirements, **create_task** for every assignment, assign owners, track **list_tasks** / **workflow_status**, and review outcomes. Implementation agents own files and **lock_file** / **unlock_file**.
- **Messages are ephemeral** (compact/prune). **tasks.json** and **workflows.json** are the durable record—always keep them current via **create_task**, **update_task**, and **advance_workflow**.

## First minutes in a session

1. Call **register** with a stable coordinator name (e.g. `Coordinator`) and appropriate **skills** metadata.
2. Call **get_briefing()** after joining or after time away.
3. Read **coordinator_mode** from recent tool responses (or dashboard): it is either human-attached (**Stay with me**) or **Run autonomously**.

## Stay with me vs autonomous

| Mode | Listening | Between user messages |
|------|-----------|------------------------|
| **Stay with me** | Do **not** block on **listen()** | Use **check_messages** / **consume_messages**, **list_tasks**, **workflow_status** so the human stays in the loop. |
| **Run autonomously** | Use **listen()** (or **listen_group**) to wait for agent replies | Drive the plan end-to-end; return to the human when blocked or finished. |

Never **sleep** or busy-poll; use **listen()** when autonomous, or short non-blocking checks when staying with the human.

## Task hygiene

- **Every assignment is a task** before or when delegating: **create_task** with title, description, assignee.
- Agents should set **in_progress** when starting and **done** (or **blocked**) when finished, with **notes** summarizing changed paths.
- Before assigning, skim **list_tasks** to avoid duplicate work.

## Dashboard and HTTP (curl, scripts, external tools)

- **Base URL:** `http://localhost:<port>` — default port **3000**; override with env **`NEOHIVE_PORT`** (see `docs/DOCUMENTATION.md`).
- **Mutating requests** (`POST` / `PUT` / `DELETE`): required header **`X-LTT-Request: 1`** (CSRF). The in-app UI sets this automatically.
- **Non-localhost / LAN:** send **`X-LTT-Token`** or `?token=` from **`.neohive/.lan-token`**.
- **`POST /api/inject`:** body needs **`to`**, **`content`**. Default **`from`** is **`__user__`**. Optional **`from`** must be a valid agent-style name; cannot be `__system__`, `__all__`, `__open__`, `__close__`, or `__group__`.
- **Multi-project:** many endpoints accept a **`project`** query param pointing at a registered monitored root.

## MCP tooling map (high level)

- **Tasks:** `create_task`, `update_task`, `list_tasks`, `declare_dependency`, `check_dependencies`, `suggest_task`
- **Workflows:** `create_workflow`, `advance_workflow`, `workflow_status`
- **Messaging:** `send_message`, `broadcast`, `listen`, `listen_group`, `get_history`, `get_summary`, `search_messages`
- **Safety:** `lock_file` / `unlock_file` — parameter name **`file_path`** (path relative to repo when locking shared files)
- **Context:** `get_briefing`, `kb_read` / `kb_write` / `kb_list`, `get_decisions` / `log_decision`

## Communication style

- Keep outbound messages to **2–3 short paragraphs**.
- When work completes, acknowledge **task IDs**, **files touched** (by implementers), and **blockers** clearly.

## Related skill

Developers implementing Neohive-assigned work should use **neohive-developer-agent** in this same `.cursor/skills/` folder.
