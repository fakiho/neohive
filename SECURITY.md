# Security Policy — Neohive

Maintained by Alionix.

---

## Threat model

Neohive's attack surface is intentionally small. It coordinates agents on a single machine — no remote endpoints, no cloud service, no persistent server that keeps running when you're not using it.

**What you're actually exposed to:**

- The dashboard HTTP server, which runs locally while active
- The `.neohive/` directory, which any process with filesystem access can read
- LAN mode, if you explicitly enable it (see below)

Neohive is not a network service in the traditional sense. The realistic threats are local — a rogue plugin, a path traversal attempt, or CSRF from a malicious tab open alongside the dashboard.

---

## Dashboard hardening

The dashboard is the only HTTP surface. It's locked down as follows:

| Layer | What's enforced |
|-------|----------------|
| **Custom request header** | All state-changing requests require `X-Neohive-Request: 1` — blocks CSRF from cross-origin tabs |
| **Origin enforcement** | POST and DELETE reject requests without a valid `localhost` origin |
| **CORS** | API endpoints reject non-localhost origins at the browser level |
| **Content Security Policy** | Inline scripts are blocked; source allowlists on all loaded resources |
| **Output escaping** | User-supplied content is escaped before it reaches the DOM |
| **SSE cap** | Open event-stream connections are limited to prevent resource exhaustion |

---

## Runtime data

Everything Neohive writes goes into `.neohive/` inside your project. The files:

```
.neohive/
  messages.jsonl          # append-only message bus
  history.jsonl           # conversation history
  agents.json             # registration + heartbeats
  tasks.json              # task state
  workflows.json          # workflow pipelines
  heartbeat-{agent}.json  # per-agent liveness (one file per agent)
  workspaces/{agent}.json # per-agent key/value storage
```

I don't read these files. Neither does the package. There is no telemetry.

---

## Input and filesystem safety

| Check | What it prevents |
|-------|-----------------|
| **Path validation** | Submitted paths are resolved; anything outside the project root is rejected |
| **Symlink resolution** | Symlinks are followed and the real path is checked against the allowlist |
| **Name validation** | Agent names, branch names, channel names match strict patterns (alphanumeric, max length) |
| **Message size cap** | Messages are capped at 1 MB |
| **Plugin sandboxing** | Dynamic plugins run in an isolated VM context with a 30-second hard timeout |
| **Structured error logging** | Errors log with context at `NEOHIVE_LOG_LEVEL`; raw stack traces never reach the client |

---

## Network exposure

**Default:** dashboard binds to `127.0.0.1:3000`. Reachable from your machine only.

**LAN mode** (`npx neohive dashboard --lan` or `NEOHIVE_LAN=true`): rebinds to `0.0.0.0`, making the dashboard visible to other devices on your local network. A one-time access token is printed to the terminal on startup — connecting from another device requires that token. The token is not persisted between restarts.

Neohive is never exposed to the internet. LAN mode is designed for a second device on your desk, not a shared or public network.

---

## Supported versions

| Version | Support |
|---------|---------|
| 6.x.x | Active |
| 5.x.x | Critical fixes only |
| < 5.0 | None — upgrade recommended |

---

## Reporting a vulnerability

**Don't open a public GitHub issue.** Security reports go to:

- **Email:** contact@alionix.com
- **Private report:** [GitHub security advisories](https://github.com/fakiho/neohive/security/advisories/new)

Useful to include: what you found, how to reproduce it, what an attacker could do with it, and a fix suggestion if you have one. I'll acknowledge within 48 hours and aim to ship a fix within two weeks for confirmed issues.
