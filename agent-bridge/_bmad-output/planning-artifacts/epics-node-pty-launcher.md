---
title: node-pty Agent Launcher — Epic Breakdown
status: draft
created: 2026-07-19
updated: 2026-07-19
author: Opus
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-agent-bridge-2026-07-19/prd.md
  - _bmad-output/planning-artifacts/architecture/architecture-agent-bridge-2026-07-19/ARCHITECTURE-SPINE.md
---

# node-pty Agent Launcher — Epic Breakdown

## Overview

Decomposition of the node-pty Agent Launcher PRD + Architecture Spine into implementable stories. The migration replaces the tmux `capture-pane` polling path with a PTY the launcher owns, giving the dashboard reliable pre-render output capture — while (per architecture **AD-1**) keeping PTY ownership in a **standalone detached per-agent process** so agents survive dashboard restarts.

## Requirements Inventory

### Functional Requirements

- **FR-1** — Spawn CLI agent in a PTY (real TTY; full interactive TUI fidelity).
- **FR-2** — PTY resize relay.
- **FR-3** — Binary-not-found → structured error.
- **FR-4** — Publish PTY data to SSE (`agent_output`).
- **FR-5** — Unrouted-reply detection via the PTY stream.
- **FR-6** — Per-agent bounded output buffer (1 MB ring buffer) for late-joining clients.
- **FR-7** — PID registration on spawn (into `agents.json`).
- **FR-8** — Exit detection and cleanup (`agent_exit`, fd release, registry removal).
- **FR-9** — Optional tmux window as display surface (opt-in, v2-leaning).
- **FR-10** — Write input bytes to the PTY master.

### NonFunctional Requirements

- **NFR-1 (durability)** — Running agents MUST survive a dashboard restart (dashboard restarts on every code edit). **AD-1.**
- **NFR-2 (latency)** — First `agent_output` byte within 100 ms of spawn; ≤50 ms per-data-event budget (SM-1).
- **NFR-3 (fidelity)** — Zero TUI-breaking regressions for Claude Code / Gemini / opencode on Linux+macOS (SM-2).
- **NFR-4 (no fd leaks)** — No leaked PTY fds after 10 spawn+exit cycles (SM-4).
- **NFR-5 (security)** — Captured stream may contain secrets — redact before persist; `.neohive/` perms + messages retention policy. **AD-7.**

### Additional Requirements (Architecture)

- **AD-1** — PTY master fd held by a standalone detached per-agent owner process, never the dashboard/MCP process.
- **AD-2** — `.neohive/agent-log-{agent}.jsonl` is the durable source of truth (`{ts,agent,data}` per line); consumers tail it. Ring buffer (FR-6) is a latency optimization on top.
- **AD-3** — Live input/resize over per-agent unix socket `.neohive/pty-{agent}.sock`; owner is sole `pty.write()` caller. Stale socket (no live PID in `agents.json`) ignored; owner unlinks on exit.
- **AD-4** — tmux is display-only, never a runtime dependency.
- **AD-5** — Fall back to `tmux-cli-launcher.js` (with warning) if node-pty can't load; never hard-block launch.
- **AD-6** — `agents.json` remains the single liveness authority.
- **AD-7** — Redact known secret patterns before writing the log.
- Reuse existing helpers: `sanitizeName()`, `buildNativeCliEnvArgs`, `getCliSpec`, `findExecutable`.

### UX Design Requirements

None — backend/infrastructure migration, no UX spine. Dashboard rendering reuses the existing terminal widget.

### FR Coverage Map

| FR / NFR | Covered by story |
| --- | --- |
| FR-1, FR-3, NFR-1, NFR-3, AD-1 | 1.1 |
| FR-4, FR-6, AD-2, NFR-2 | 1.1, 1.4 |
| FR-7, FR-8, NFR-4, AD-6 | 1.1 |
| NFR-5, AD-7 | 1.1 |
| launcher interface + AD-5 fallback | 1.2 |
| FR-2, FR-10, AD-3 | 1.3 |
| FR-5, AD-2 | 1.4 |
| FR-9, AD-4 | 1.5 |

## Epic List

1. **Epic 1 — node-pty Agent Launcher** — replace the tmux capture-poll path with a per-agent PTY owner process that reliably captures and routes agent output to the dashboard, without regressing durability or interactivity.

---

## Epic 1: node-pty Agent Launcher

**Goal:** Deliver reliable, pre-render capture of agent terminal output to the dashboard by owning each agent's PTY in a standalone per-agent process — while preserving interactive TUI fidelity, agent durability across dashboard restarts, and a safe fallback to the existing tmux launcher.

**Sequencing:** 1.1 → 1.2 → (1.3, 1.4 in parallel) → 1.5 (opt-in, may defer). 1.1 is the foundation every other story builds on.

**Cross-cutting ACs (apply to every story):** NFR-3 (no TUI regression), AD-5 (never hard-fail a launch), reuse existing launcher helpers rather than duplicating.

### Story 1.1: Per-agent PTY owner process (`lib/pty-owner.js`)

As the Neohive platform,
I want each agent's CLI spawned inside a PTY owned by a standalone detached process that tees output to a durable log,
So that the dashboard reliably captures every byte the agent emits and agents survive dashboard restarts.

**Governing:** FR-1, FR-3, FR-7, FR-8; NFR-1, NFR-3, NFR-4, NFR-5; AD-1, AD-2, AD-6, AD-7. Foundation for all other stories.

**Acceptance Criteria:**

**Given** a request to run a CLI (claude/gemini/codex/cursor/opencode) with env/argv from `buildNativeCliEnvArgs`,
**When** the owner process starts,
**Then** it spawns the CLI via `node-pty` in a real PTY (default 220×50 until a size is reported),
**And** the process detaches from its parent (`setsid`/`.unref()`) so the master fd is NOT held by the dashboard or an MCP process (AD-1),
**And** the spawned CLI renders its interactive TUI correctly — colors, raw mode, alternate screen (FR-1, NFR-3).

**Given** a running owner process and its parent dashboard process,
**When** the dashboard process is killed and restarted,
**Then** the agent CLI keeps running uninterrupted (NFR-1).

**Given** PTY output bytes,
**When** the owner reads them from the master fd,
**Then** it appends `{"ts":"<ISO8601Z>","agent":"<name>","data":"<JSON-escaped bytes>"}` lines to `.neohive/agent-log-{agent}.jsonl` (AD-2),
**And** a redaction pass strips known secret patterns before write (AD-7, NFR-5),
**And** the log file inherits `.neohive/` permissions.

**Given** the owner spawns the CLI,
**When** the PID is known,
**Then** it is written to `agents.json` via the existing registry API within 200 ms (FR-7, AD-6).

**Given** the CLI child exits (clean or crash),
**When** the owner detects exit,
**Then** it fires `agent_exit`, removes the agent from `agents.json`, unlinks `.neohive/pty-{agent}.sock`, and releases the PTY fd with no leak (FR-8, NFR-4, AD-3).

**Given** the CLI binary is not on PATH,
**When** spawn is attempted,
**Then** a structured error is returned rather than a crash (FR-3).

### Story 1.2: PTY launcher module + dashboard integration + fallback (`lib/pty-cli-launcher.js`)

As a dashboard operator,
I want a launcher that spawns the PTY owner behind the same interface as the tmux launcher and falls back to tmux if node-pty is unavailable,
So that launching agents works seamlessly and never hard-fails.

**Governing:** launcher interface parity; AD-5. Depends on 1.1.

**Acceptance Criteria:**

**Given** the existing `tmuxCliLauncher.launchNativeCli({dataDir, projectDir, cli, agentName, prompt, profile, model})` call site in `dashboard.js`,
**When** `pty-cli-launcher.launchNativeCli(...)` is called with the same arguments,
**Then** it returns a compatible result object (agent name, owner PID, log path, socket path) that `dashboard.js` consumes,
**And** it reuses `getCliSpec`, `findExecutable`, `buildNativeCliEnvArgs` rather than duplicating them.

**Given** node-pty cannot load (native addon missing/broken),
**When** a launch is requested,
**Then** the dashboard surfaces a warning and falls back to `lib/tmux-cli-launcher.js`; the launch still succeeds (AD-5),
**And** the fallback is logged, never silent.

**Given** a successful PTY launch,
**When** `dashboard.js` returns its launch response,
**Then** the response indicates `launch_mode: "pty"` (vs the tmux path) so the frontend/API can distinguish.

### Story 1.3: Live input & resize over per-agent socket (`.neohive/pty-{agent}.sock`)

As a dashboard operator,
I want to type into and resize a running agent's terminal from the dashboard,
So that I can answer prompts, interrupt, or drive the agent interactively.

**Governing:** FR-2, FR-10; AD-3, AD-6. Depends on 1.1.

**Acceptance Criteria:**

**Given** a running owner process,
**When** it starts,
**Then** it creates and listens on `.neohive/pty-{agent}.sock`, accepting newline-delimited JSON frames `{type:"input"|"resize", ...}`.

**Given** an `input` frame arriving on the socket,
**When** the owner receives it,
**Then** it writes the bytes unmodified via `pty.write(data)`; a typed character appears at the agent's prompt; `\x03` sends SIGINT (FR-10),
**And** the owner is the sole writer to the PTY master; if two clients connect, the last input connection wins (AD-3).

**Given** a `resize` frame `{cols, rows}`,
**When** the owner receives it,
**Then** it calls `pty.resize(cols, rows)` and the TUI reflows correctly (FR-2).

**Given** the dashboard reconnects after a restart,
**When** it enumerates agents,
**Then** it discovers live owners by scanning `.neohive/pty-*.sock` cross-checked against live PIDs in `agents.json`; sockets with no live PID are ignored as stale (AD-3, AD-6).

### Story 1.4: Retarget output routing + unrouted-reply detection to the log stream

As the Neohive dashboard,
I want output streamed via SSE and unrouted-reply detection driven by the PTY log instead of tmux capture-polling,
So that routing is reliable and low-latency and the tmux poll path is retired.

**Governing:** FR-4, FR-5, FR-6; NFR-2; AD-2. Depends on 1.1.

**Acceptance Criteria:**

**Given** new lines appended to `.neohive/agent-log-{agent}.jsonl`,
**When** the dashboard tails the file,
**Then** it publishes `agent_output` SSE events; a client connecting mid-session receives the last ≤1 MB immediately from the ring buffer (FR-4, FR-6, AD-2),
**And** the first byte reaches the dashboard within 100 ms of spawn (NFR-2).

**Given** the unrouted-reply detector,
**When** it runs,
**Then** it consumes the PTY log stream rather than `tmux capture-pane` polling and fires the advisory broadcast within 46 s of an unrouted reply (FR-5, SM-3),
**And** the tmux capture-poll path in the detector is removed while `tmux-agent-state.js` watchdog/state helpers remain.

### Story 1.5: Optional tmux display surface (opt-in)

As an operator who prefers tmux,
I want the option to also see agent output in a tmux pane,
So that I retain `tmux attach` without making tmux a runtime dependency.

**Governing:** FR-9; AD-4. Opt-in / v2-leaning (PRD §6.2) — may ship after 1.1–1.4.

**Acceptance Criteria:**

**Given** `terminal.tmux_session` is configured and tmux is available,
**When** an agent is launched,
**Then** the owner additionally mirrors output to a tmux window as a display surface only; PTY ownership stays with the owner process (FR-9, AD-4).

**Given** tmux is NOT configured or not installed,
**When** an agent is launched,
**Then** capture, routing, input, and resize all function identically with no tmux dependency (AD-4).

**Given** this story is opt-in,
**When** prioritizing,
**Then** it may ship after 1.1–1.4 without blocking the core migration.
