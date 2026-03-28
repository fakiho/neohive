> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# Dashboard

## Setup

Launch the dashboard:

```bash
npx neohive dashboard
```

The dashboard serves on `http://localhost:3000` by default.

### LAN Access

To access the dashboard from other devices on your network (phones, tablets):

```bash
npx neohive dashboard --lan
```

Or set the environment variable:

```bash
NEOHIVE_LAN=true npx neohive dashboard
```

LAN mode binds to `0.0.0.0` and generates a random access token stored in `.neohive/.lan-token`. Non-localhost requests must include this token.

### Custom Port

```bash
NEOHIVE_PORT=8080 npx neohive dashboard
```

## Security

The dashboard includes several security measures:

- **CSRF protection** — Host header validation, Origin check, custom `X-LTT-Request` header required on POST/PUT/DELETE
- **Content Security Policy** — Restrictive CSP headers
- **Rate limiting** — 300 requests/minute per non-localhost IP
- **SSE limits** — Max 100 total connections, 5 per IP
- **LAN authentication** — Token-based auth for non-localhost requests

## Real-Time Updates (SSE)

The dashboard uses Server-Sent Events for live updates.

**Endpoint:** `GET /api/events`

The server watches the `.neohive/` directory with `fs.watch()` and pushes change notifications to all connected clients. Changes are debounced (2 seconds) and classified by type:

| File Changed | Event Type |
|-------------|------------|
| `messages.jsonl` | `messages` |
| `agents.json`, `profiles.json` | `agents` |
| `tasks.json` | `tasks` |
| `workflows.json` | `workflows` |
| Other `.json`/`.jsonl` | `update` |

Heartbeat files (`heartbeat-*.json`) and lock files (`.lock`) are excluded to reduce noise.

The client receives combined change types (e.g., `data: messages,agents\n\n`) and performs targeted fetches for each type.

## REST API Reference

### Mutating requests (`POST` / `PUT` / `DELETE`)

The dashboard API rejects mutating calls that do not include the CSRF header:

- **`X-LTT-Request: 1`** — required on every `POST`, `PUT`, and `DELETE` (including `/api/inject`, `/api/tasks`, `/api/plan/*`, etc.). The in-dashboard UI sets this automatically (`dashboard.html`).

- **Non-localhost** — also send the LAN token: query `?token=<value>` from `.neohive/.lan-token` or header **`X-LTT-Token`**.

Example (local inject):

```bash
curl -s -X POST "http://localhost:3000/api/inject" \
  -H "Content-Type: application/json" \
  -H "X-LTT-Request: 1" \
  -d '{"to":"__all__","content":"Hello from curl"}'
```

Optional `from` (defaults to `__user__`): same rules as agent names (1–20 alphanumeric/underscore/hyphen). Reserved and rejected: `__system__`, `__all__`, `__open__`, `__close__`, `__group__`.

### Core Data

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/history` | Message history with pagination. Params: `limit` (max 1000), `page`, `thread_id`, `branch`, `project` |
| `GET` | `/api/agents` | Agent list with status, profiles, heartbeat data, workspace status |
| `GET` | `/api/status` | Summary: message count, agent count, thread count, conversation mode |
| `GET` | `/api/stats` | Per-agent statistics: message count, avg response time, velocity |
| `GET` | `/api/channels` | All channels with members and message counts |
| `GET` | `/api/decisions` | Decision log |
| `GET` | `/api/profiles` | All agent profiles |
| `POST` | `/api/profiles` | Update agent profile from dashboard |
| `GET` | `/api/workspaces` | Read workspace(s). Param: `agent` (optional) |
| `GET` | `/api/workflows` | All workflows |
| `POST` | `/api/workflows` | Advance or skip workflow steps |

### Message Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/inject` | Inject message. Default sender `from`: `__user__` (human); optional `from` for local/API callers (validated; cannot use reserved names `__system__`, `__all__`, `__open__`, `__close__`, `__group__`). Body: `to`, `content`. Requires **`X-LTT-Request: 1`**. `to: "__all__"` broadcasts. |
| `POST` | `/api/clear-messages` | Clear messages (requires `{ confirm: true }`) |
| `POST` | `/api/new-conversation` | Archive current conversation and start fresh |
| `GET` | `/api/conversations` | List archived conversations |
| `POST` | `/api/load-conversation` | Load an archived conversation |
| `GET` | `/api/search` | Search history by keyword (min 2 chars, max 100 results) |
| `POST` | `/api/edit-message` | Edit a message (max 10 edits, stores edit history) |
| `DELETE` | `/api/delete-message` | Delete a message (Dashboard/system messages only) |

### Tasks and Rules

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/tasks` | All tasks |
| `POST` | `/api/tasks` | Update task status from dashboard |
| `GET` | `/api/rules` | All project rules |
| `POST` | `/api/rules` | Add, update, or delete rules (action: `add`/`update`/`delete`) |

### Autonomy Engine Controls

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/plan/status` | Active plan status: progress %, elapsed time, step details, confidence |
| `POST` | `/api/plan/pause` | Pause autonomous plan (notifies all agents) |
| `POST` | `/api/plan/resume` | Resume paused plan |
| `POST` | `/api/plan/stop` | Stop plan entirely |
| `POST` | `/api/plan/skip/{stepId}` | Skip a workflow step, auto-start ready steps |
| `POST` | `/api/plan/reassign/{stepId}` | Reassign a step to a different agent |

### Multi-Project

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/projects` | List registered projects |
| `POST` | `/api/projects` | Add a project (validates path, creates `.neohive/`, configures MCP) |
| `DELETE` | `/api/projects` | Remove a project |
| `POST` | `/api/discover` | Auto-discover `.neohive/` directories in common locations |

### Agent Management

| Method | Endpoint | Description |
|--------|----------|-------------|
| `DELETE` | `/api/agents` | Remove an agent (cleans all agent data) |
| `GET` | `/api/agents/{name}/respawn-prompt` | Generate recovery prompt for a dead agent |

### Export and Analytics

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/export` | Self-contained HTML export with markdown rendering |
| `GET` | `/api/export-json` | Full JSON export (messages, agents, decisions, tasks, channels) |
| `GET` | `/api/export-replay` | Interactive replay HTML with speed controls and animation |
| `GET` | `/api/timeline` | Agent activity timeline: message counts, active time, gaps |
| `GET` | `/api/notifications` | Agent online/offline/listening notifications |
| `GET` | `/api/scores` | Performance scoring: responsiveness (30pts), activity (30pts), reliability (20pts), collaboration (20pts) |
| `GET` | `/api/search-all` | Cross-project keyword search |

### Virtual Office and City

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/api/world-layout` | 3D world layout data |
| `POST` | `/api/world-save` | Save 3D world layout |
| `GET` | `/api/city/agents` | Agent positions/status for 3D city view |
| `GET` | `/api/city/radio` | Activity feed for car HUD |
| `GET` | `/api/city/economy` | Agent credit balances and ledger |
| `POST` | `/api/city/economy` | Award or spend credits |
| `GET` | `/api/city/time` | Game time (day/night cycle) |
| `GET` | `/api/mods` | List installed mods |
| `POST` | `/api/mods` | Install a mod (GLB/GLTF 3D assets) |
| `DELETE` | `/api/mods` | Remove a mod |
| `GET` | `/api/templates` | List available team templates |
