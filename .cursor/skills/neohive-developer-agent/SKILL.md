---
name: neohive-developer-agent
description: >-
  Implements Neohive-assigned work as a Coder, Frontend, or specialist agent using
  MCP tools correctly—register, listen, lock_file, tasks, Node/Volta-safe MCP
  configs, and dashboard API headers. Use when working in a Neohive-enabled
  repo, when the user asks to register/listen, or when integrating with
  .neohive/ and the collaboration server.
---

# Neohive — Developer / implementer playbook

## Session startup

1. **register** with your role name (1–20 chars: letters, digits, `_`, `-`) and **skills** hints (e.g. `frontend`, `testing`) for routing.
2. **get_briefing()** when joining the project or returning after a break.
3. Prefer **listen()** (or **listen_group**) to receive assignments—do not spin on **check_messages()** in a loop.

## While implementing

- **Before editing shared files** another agent might touch: **lock_file** with **`file_path`** set to the repo-relative path (e.g. `agent-bridge/dashboard.js`). **unlock_file** with the same **`file_path`** when finished.
- **Tasks are the record:** when you start work on an assignment, **update_task** to **in_progress**; when finished, **update_task** to **done** with **notes** listing changed paths and how you verified (e.g. `node --check`, manual dashboard load).
- If the Coordinator only messaged you but **no task exists**, ask them to **create_task**—avoid “silent” work that never hits **tasks.json**.

## MCP and Node binary pitfalls

- **`npx neohive init`** writes MCP server **`command`** as the **absolute Node binary** that ran init (`process.execPath`), so Volta/nvm/shimmed installs still work when the IDE MCP subprocess has a minimal **`PATH`**.
- If MCP fails to start with **`node: not found`**, re-run **`npx neohive init`** (or your CLI flag: `--claude`, `--cursor`, `--codex`, `--gemini`, `--all`) from the project so configs refresh; for **Codex**, re-init **updates** an existing `[mcp_servers.neohive]` block (does not skip).
- **Data directory:** defaults to **`<project>/.neohive/`**; overridable with **`NEOHIVE_DATA_DIR`** / **`NEOHIVE_DATA`** (dashboard and server honor these—see `docs/DOCUMENTATION.md`).

## Dashboard / REST from automation

- Default dashboard **`http://localhost:3000`**; port from **`NEOHIVE_PORT`**.
- Every **`POST`/`PUT`/`DELETE`** needs **`X-LTT-Request: 1`**. LAN access needs **`.neohive/.lan-token`** as **`X-LTT-Token`** or **`?token=`**.

## Quality bar (project norms)

- **No emojis in product UI**—prefer SVG or text.
- Prefer **structured logging** over raw **`console.log`** in server code paths that already use the project logger.
- After changes, run the **smallest meaningful verification** and state results in task notes or **send_message** to the Coordinator.

## Coordinator-facing handoff

When done, message the Coordinator with: **task id**, **summary**, **paths changed**, **verification**, and **screenshots** only if UI-related.

## Related skill

Leads assigning work and driving process should use **neohive-coordinator** in this same `.cursor/skills/` folder.
