# AI contributor onboarding — Neohive

Use this doc **before** diving into code: it orients you on what the project is, where things live, and what to read next for your task.

---

## What you are working on

**Neohive** is a **local MCP (Model Context Protocol) server** plus a **web dashboard** that lets multiple AI CLI/IDE sessions in the same project behave like a **team**: messaging, tasks, workflows, workspaces, optional autonomy/managed modes, knowledge base, voting, reviews, branching, channels, file locks, and related features.

- **No central server, no database by default.** Coordination uses a project-local **`.neohive/`** directory (JSON + JSONL files).
- Each connected client runs its own **`server.js`** process over **stdio**; processes **do not share memory** — the **filesystem is the message bus**.
- Users install via **`npx neohive init`**; the published package is **`neohive`** on npm (see `agent-bridge/package.json` for the current version).

---

## Repository layout (where to look)

| Goal | Location |
|------|----------|
| **MCP server** (tools, registration, heartbeats, most business logic) | `agent-bridge/server.js` |
| **Shared modules** (preferred place for new low-level code) | `agent-bridge/lib/` (`logger`, `config`, `state`, `file-io`, `agents`, `messaging`, `compact`, `ide-activity`, …) |
| **Dashboard HTTP + SSE** | `agent-bridge/dashboard.js` |
| **Dashboard UI** (single page, large inline JS/CSS) | `agent-bridge/dashboard.html`, `design-system.css` |
| **CLI** (`init`, `dashboard`, `doctor`, …) | `agent-bridge/cli.js` |
| **VS Code extension** (small) | `vscode-extension/` |
| **Team templates** | `agent-bridge/templates/` |
| **Scripts** (portable paths check, optional e2e) | `agent-bridge/scripts/` |
| **Bundled plugin / extra docs** | `agent-bridge/neohive-plugin/` |
| **Reference docs (split)** | `docs/reference/` — MCP tools, dashboard API, data directory, CLI, … |

**Repo root** holds product README, vision, security, and **`docs/`** (this folder).

---

## Documentation reading order

1. **[README.md](../README.md)** — quick start, features, env vars, CLI table.
2. **[docs/documentation.md](./documentation.md)** — short hub; deep dives under **[docs/reference/](./reference/)** (especially **[tools.md](./reference/tools.md)**, **[dashboard.md](./reference/dashboard.md)**, **[data-directory.md](./reference/data-directory.md)**).
3. **[VISION.md](../VISION.md)** — roadmap and intentional direction (modularization, tests, SQLite option, remote agents, etc.).
4. **[SECURITY.md](../SECURITY.md)** — threat model and dashboard/MCP safety notes.
5. **[CONTRIBUTING.md](../CONTRIBUTING.md)** — style and PR expectations (see caveat below).

**Cursor / Neohive workflow (register, listen, tasks, dashboard headers):**

- `.cursor/skills/neohive-developer-agent/SKILL.md`
- `.cursor/skills/neohive-coordinator/SKILL.md`

**IDE-specific repo hints:** `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, `.agent/skills/neohive/SKILL.md`.

---

## Architecture (short)

```
Terminals (Claude / Gemini / Cursor / …)
        │  stdio MCP each
        ▼
  agent-bridge/server.js  (one process per connection)
        │
        ├── read/write  .neohive/*.json, *.jsonl, workspaces/, …
        │
        ▼
  agent-bridge/dashboard.js  →  browser (SSE + REST)
```

- **Messages:** append-only **JSONL** (`messages.jsonl`, `history.jsonl`, branch/channel variants).
- **Structured state:** JSON files with **file locking** (tasks, workflows, agents, …).
- **Per-agent:** consumed IDs, heartbeats, workspaces — reduces write contention.
- **`server.js`** is large; **new shared logic should go in `lib/`** and be required from `server.js` when possible (migration in progress).

---

## Environment and config

- **`NEOHIVE_DATA_DIR`** / **`NEOHIVE_DATA`** — override data directory (server vs dashboard).
- **`NEOHIVE_PORT`**, **`NEOHIVE_LAN`**, **`NEOHIVE_LOG_LEVEL`** — see README and [documentation.md](./documentation.md).

Init writes **absolute paths** to the Node binary for MCP configs (Volta/nvm-safe).

---

## Practical tips for tasks

1. **Find behavior first:** search `server.js` for the tool name (e.g. `toolSendMessage`, `register`) or grep for the user-facing string; check `lib/` for extracted helpers.
2. **Dashboard changes:** often touch both `dashboard.js` (API, SSE) and `dashboard.html` (UI).
3. **CLI / init:** `cli.js` + templates under `agent-bridge/templates/`.
4. **Tests:** `npm test` is currently a placeholder; `package.json` has `check-paths` and an optional Playwright script — see scripts before assuming a full suite exists.
5. **Docs drift:** if README, documentation hub, and VISION disagree on version or paths, trust **`agent-bridge/package.json`** and **this repo’s actual paths** (`agent-bridge/` is the package root, not `neohive/neohive` as an older CONTRIBUTING line may suggest).

---

## Working with a live Neohive project

If the repo (or another project) has **`.neohive/`** active, agents often use MCP: **`register`** → **`get_briefing`** → **`listen`** / task tools. The briefing summarizes online agents, tasks, KB keys, and locks. Respect **file locks** (`lock_file` / `unlock_file`) when editing shared paths the team cares about.

---

## License

Project license: see [LICENSE](../LICENSE) (Business Source License 1.1).

---

*This file is an onboarding map, not a full spec. For behavior details, prefer [documentation.md](./documentation.md) + [reference/](./reference/) and the code.*
