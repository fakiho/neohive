---
title: node-pty Agent Launcher
status: draft
created: 2026-07-19
updated: 2026-07-19
---

# PRD: node-pty Agent Launcher

## 0. Document Purpose

This PRD is for Ali (project owner), the multi-agent Neohive team (CursorLead, Opus, claude), and downstream architecture/story owners. It specifies replacing the tmux-based agent launcher (`lib/tmux-cli-launcher.js`) with a node-pty–based launcher that owns the PTY for each spawned CLI process. All coordination-layer terms follow §3 Glossary. Assumptions are tagged `[ASSUMPTION]` inline and indexed in §9. Opus's Zellij research (`_bmad-output/planning-artifacts/prds/prd-agent-bridge-2026-07-19/` sibling file) and the existing architecture docs in `CLAUDE.md` are foundational inputs.

## 1. Vision

Neohive today launches AI CLI agents (Claude Code, Gemini CLI, opencode, Codex) inside tmux panes. The dashboard connects to those panes via a tmux `capture-pane` poll and a WebSocket bridge (`lib/terminal-ws.js`). This works for monitoring but it cannot intercept an agent's stdout *before* it hits the terminal scrollback — so replies the agent types in plain text instead of calling `send_message()` appear only in the pane, never on the dashboard.

The node-pty launcher places a thin PTY wrapper **between** the CLI process and the terminal display. Because node-pty owns the master side of the PTY pair, the Node.js process reads every byte the agent writes before it is echoed anywhere. This is the correct architectural layer for reliable, low-latency stdout/stderr routing to the Neohive dashboard — a capability multiplexers (tmux, Zellij) fundamentally cannot provide, as Opus's research confirmed.

The launcher must preserve full interactive TUI fidelity: Claude Code's rich UI, Gemini's prompts, opencode's diff viewer must all render correctly. tmux stays available as the optional session container when the user wants windowed grouping; node-pty handles process lifecycle and stream routing regardless.

## 2. Target User

### 2.1 Jobs To Be Done

- **Neohive operators (Ali, team leads):** see agent stdout/stderr on the dashboard in near-real-time without depending on agents voluntarily calling `send_message()`.
- **Agent processes (Claude Code, Gemini, opencode, Codex):** run in a PTY that fully emulates the terminal they expect, so interactive features (readline, mouse, colour, alternate-screen) keep working.
- **Dashboard consumers:** receive a live stream of agent output correlated to agent names, enabling detection of unrouted replies and stall patterns.

### 2.2 Non-Users (v1)

- External CI/CD pipelines running agents headlessly (no PTY, no dashboard stream needed in v1). [ASSUMPTION: headless batch mode is out of scope; CI agents use the existing stdio MCP path]
- Windows native (CMD/PowerShell without WSL). [ASSUMPTION: Linux and macOS are the only supported platforms for v1]

### 2.3 Key User Journeys

- **UJ-1. Ali launches a Claude Code agent from the dashboard and sees its output stream.**
  - **Persona + context:** Ali, project owner, running the Neohive dashboard on his dev machine.
  - **Entry state:** Dashboard open at `http://localhost:4000`, no agent running for the current project.
  - **Path:** (1) Clicks "Launch agent", selects "claude" from the runtime dropdown, clicks "Launch". (2) Dashboard fires `POST /api/launch-agent`. (3) node-pty launcher spawns `claude` in a PTY; stdout bytes stream to the dashboard SSE feed. (4) Dashboard terminal pane shows Claude Code's interactive UI in real time. (5) When the agent calls `send_message()`, the message also appears in the chat panel.
  - **Climax:** Ali sees Claude's TUI rendering correctly *and* its plain-text output in the dashboard stream, from the first byte.
  - **Resolution:** Agent is listed in the agents panel with status `online`; Ali can send messages to it via the dashboard.
  - **Edge case:** If `claude` binary is not on PATH, launcher returns a structured error; dashboard shows "binary not found" rather than a silent hang.

- **UJ-2. CursorLead detects an unrouted reply from another agent via the dashboard.**
  - **Persona + context:** CursorLead agent watching the dashboard for coordination signals.
  - **Entry state:** Another agent (Opus) has responded in plain terminal text instead of via `send_message()`.
  - **Path:** (1) node-pty intercepts Opus's stdout; pattern-matching layer detects unrouted-reply heuristic (text looks like a message, no `send_message()` within 45 s). (2) Advisory broadcast fires on the Neohive channel. (3) CursorLead receives the broadcast via `listen()` and can prompt Opus to re-route.
  - **Climax:** CursorLead is notified without polling and without reading tmux scrollback.
  - **Resolution:** Coordination continues; unrouted reply is surfaced and recoverable.

## 3. Glossary

- **PTY (Pseudo-Terminal)** — A kernel-provided pair of file descriptors (master/slave) that emulate a serial terminal. The process on the slave side (the CLI agent) believes it is attached to a real terminal. The owner of the master side (the launcher) reads/writes all bytes.
- **node-pty** — npm package `node-pty` exposing a Node.js API to spawn a process inside a PTY. The `IPty` object emits `data` events for every byte the child writes.
- **Launcher** — The Node.js module (`lib/pty-cli-launcher.js`) responsible for spawning CLI agent processes via node-pty, routing their output, and managing their lifecycle.
- **CLI agent / Agent process** — One of: `claude`, `gemini`, `codex`, `opencode`, or any runtime registered in the Launcher's `CLI_BINS` map.
- **TUI (Terminal User Interface)** — Interactive full-screen applications that use ANSI escape sequences, alternate-screen mode, or mouse input (e.g., Claude Code's diff viewer, Gemini's prompts).
- **Dashboard stream** — The SSE endpoint (`/api/events`) that the Neohive dashboard subscribes to for real-time updates. Agent stdout bytes are published here under an `agent_output` event type.
- **Unrouted reply** — Text an agent writes to its own stdout (visible in the terminal) rather than calling `send_message()`; invisible to other agents and the dashboard without interception.
- **Session container** — An optional tmux session used for windowed grouping of panes. The Launcher remains responsible for PTY ownership; the session container only provides a display surface. [ASSUMPTION: tmux session container is opt-in, not required]
- **tmux-cli-launcher.js** — The existing launcher module being replaced. It spawns agents as tmux windows and polls panes via `capture-pane`.

## 4. Features

### 4.1 PTY-based Agent Spawn

**Description:** The Launcher spawns each CLI agent process via node-pty instead of tmux `new-window`. It holds the PTY master fd, giving it read access to all stdout/stderr before any terminal display. The child inherits a PTY slave as its stdin/stdout/stderr, so TUI features (alternate-screen, colour, mouse, readline) work unmodified. The Launcher writes the PTY's dimensions (columns × rows) at spawn time and relays resize events from the dashboard connection so TUIs reflow correctly. Realizes UJ-1.

**Functional Requirements:**

#### FR-1: Spawn CLI agent in PTY

The Launcher can spawn any registered CLI agent (claude, gemini, codex, opencode) in a PTY given: agent name, working directory, environment variables (including `NEOHIVE_DATA_DIR`), and optional model override.

**Consequences (testable):**
- The spawned process's `isatty(STDOUT_FILENO)` returns true inside the child.
- Claude Code's TUI renders without garbling when connected through the PTY.
- The Launcher's `data` event fires within 50 ms of the child writing a byte. [ASSUMPTION: 50 ms latency budget is sufficient for interactive use]

**Out of Scope:**
- Spawning agents without a PTY (headless batch mode) — use the existing stdio MCP path.

#### FR-2: PTY resize relay

When the dashboard client reports a terminal resize (rows × cols), the Launcher calls `pty.resize(cols, rows)` within one dashboard frame.

**Consequences (testable):**
- Resizing the dashboard terminal pane causes the agent's TUI to reflow within one render cycle.
- No SIGWINCH is needed from the outside; node-pty handles it automatically on resize.

#### FR-3: Binary not found — structured error

If the requested CLI binary is not on PATH, the Launcher rejects the spawn request with a structured error `{ code: 'BIN_NOT_FOUND', bin: '<name>' }` before any PTY is opened.

**Consequences (testable):**
- Dashboard receives an error SSE event with `code: 'BIN_NOT_FOUND'` within 500 ms.
- No zombie PTY processes are left open.

### 4.2 Stdout/Stderr Interception and Dashboard Routing

**Description:** Every byte emitted by the agent's PTY is captured by the Launcher and published to the dashboard stream as an `agent_output` SSE event (with `agent` name and `data` fields). This provides the dashboard with a complete, real-time copy of the agent's terminal output without polling. The existing unrouted-reply heuristic (capture-pane + 45 s idle) is replaced by the PTY data event as the authoritative source. Realizes UJ-1, UJ-2.

**Functional Requirements:**

#### FR-4: Publish PTY data to SSE

Each `data` event from `IPty` is published as an SSE event on `/api/events` with type `agent_output`, keyed by agent name, within 100 ms.

**Consequences (testable):**
- Dashboard receives `agent_output` events within 100 ms of the agent writing a byte.
- Event payload includes: `{ agent: string, data: string, ts: number }`.

#### FR-5: Unrouted-reply detection via PTY stream

The Launcher feeds PTY data to the existing unrouted-reply heuristic (text analysis + 45 s idle window). When triggered, it fires the advisory broadcast via the Neohive messaging API. The tmux `capture-pane` polling path for unrouted-reply detection is retired.

**Consequences (testable):**
- Unrouted reply broadcasts fire within 45 s + 100 ms of an agent typing a plain-text reply.
- No tmux capture-pane invocations occur during unrouted-reply detection after migration.

#### FR-6: Per-agent output buffer (ring buffer, bounded)

The Launcher maintains a bounded ring buffer (≤ 1 MB) of PTY output per agent. New dashboard connections receive the last N lines on subscribe so they can display current agent state without waiting for fresh output.

**Consequences (testable):**
- A dashboard client that connects mid-session sees the last ≤ 1 MB of agent output immediately on SSE connect.
- Buffer does not grow unboundedly; old bytes are dropped once the limit is reached.

### 4.3 Agent Lifecycle Management

**Description:** The Launcher tracks each agent process's PID, exit code, and restart policy. It integrates with the existing `agents.json` heartbeat and watchdog systems. When an agent exits (clean or crash), the Launcher updates `agents.json` status and publishes an `agent_exit` SSE event. Realizes UJ-1.

**Functional Requirements:**

#### FR-7: PID registration on spawn

On successful PTY spawn, the Launcher writes the agent's PID to `agents.json` via the existing registry API.

**Consequences (testable):**
- `agents.json` contains the correct PID within 200 ms of spawn.
- The watchdog's stale-detection logic works unchanged (it reads PID from `agents.json`).

#### FR-8: Exit detection and cleanup

When the PTY child exits, the Launcher fires `agent_exit` on the SSE feed, removes the agent from `agents.json`, and releases the PTY fd.

**Consequences (testable):**
- `agent_exit` SSE event fires within 500 ms of child process exit.
- No fd leaks after exit: `lsof` shows no open PTY fds for the dead agent.

#### FR-9: Optional tmux window as display surface

[ASSUMPTION: this feature is opt-in and not required for v1 — included for operator UX continuity] When `terminal.tmux_session` is configured and tmux is available, the Launcher can additionally connect the PTY slave to a tmux window via `script`/`socat`/pipe so operators using tmux directly still see output in their pane. The PTY ownership remains with node-pty; tmux is the display surface only.

**Consequences (testable):**
- With tmux configured, agent output appears in the tmux pane AND in the dashboard stream simultaneously.
- Without tmux configured, agent output appears only in the dashboard stream; no tmux dependency at runtime.

**Out of Scope:**
- tmux as the primary output routing path (that is the old model being retired).

### 4.4 Input Forwarding

**Description:** The dashboard terminal widget can send keyboard input to the running agent. The Launcher receives input via the existing WebSocket bridge (`lib/terminal-ws.js`) and writes it to the PTY master fd. This maintains full interactivity: the operator can type commands, answer prompts, or interrupt the agent from the dashboard. Realizes UJ-1.

**Functional Requirements:**

#### FR-10: Write input bytes to PTY master

Input received on the terminal WebSocket connection is written to `pty.write(data)` without modification.

**Consequences (testable):**
- Typing in the dashboard terminal pane produces the correct character in the agent's readline prompt.
- Ctrl-C (`\x03`) sent from the dashboard terminates the agent's current operation (SIGINT to child).

## 5. Non-Goals (Explicit)

- **Replacing the stdio MCP transport** — agents still communicate with Neohive via the MCP stdio server; the Launcher wraps the terminal, not the MCP protocol.
- **Windows native support (v1)** — node-pty has a Windows backend but it is not tested in this scope.
- **Containerized agents** — spawning agents inside Docker/Podman is out of scope for v1.
- **Agent-to-agent output routing** — agents read from each other via `messages.jsonl`, not via PTY tapping.
- **Recording / replay** — no session recording (asciinema-style) in v1.
- **Sandboxing / security isolation** — the PTY runs with the same OS user as the dashboard process; privilege isolation is out of scope.

## 6. MVP Scope

### 6.1 In Scope

- `lib/pty-cli-launcher.js` — new module implementing FR-1 through FR-9 (FR-9 marked opt-in).
- Update `dashboard.js` launch endpoint to call `pty-cli-launcher.js` instead of `tmux-cli-launcher.js`.
- SSE `agent_output` event type published from the PTY data stream.
- SSE `agent_exit` event type on process exit.
- Bounded per-agent ring buffer (1 MB) for late-joining dashboard clients.
- Terminal resize relay via the existing WebSocket bridge.
- Retire tmux `capture-pane` polling in the unrouted-reply detection path.
- `lib/tmux-cli-launcher.js` kept in the codebase but soft-deprecated (its launch path is no longer called by default). [ASSUMPTION: no hard delete of the tmux launcher in v1 — allows rollback]

### 6.2 Out of Scope for MVP

- FR-9 (tmux window as display surface) — deferred to v2 if demand exists. [NOTE FOR PM: some operators may miss the tmux window; add a config flag if feedback comes in]
- Windows support.
- Containerized agent spawn.
- node-pty native binary pre-compilation / distribution (npm install compiles it).

## 7. Success Metrics

**Primary**
- **SM-1:** Dashboard receives first `agent_output` byte within 100 ms of agent spawn for all supported runtimes. Validates FR-1, FR-4.
- **SM-2:** Zero TUI-breaking regressions — Claude Code, Gemini CLI, and opencode render their interactive UI correctly through the PTY in manual testing on Linux and macOS. Validates FR-1.

**Secondary**
- **SM-3:** Unrouted-reply advisory broadcasts fire within 46 s of an unrouted reply in integration testing. Validates FR-5.
- **SM-4:** No fd leaks after 10 agent spawn+exit cycles (lsof check). Validates FR-8.

**Counter-metrics (do not optimize)**
- **SM-C1:** PTY interception latency — do not optimize at the expense of TUI correctness. A 50 ms latency is acceptable; garbled TUI output is not.

## 8. Open Questions

1. **node-pty native module distribution** — `node-pty` requires a native C++ addon compiled for the host's Node.js version. How should neohive distribute this? Options: (a) `npm install` builds it at install time; (b) pre-compiled binaries via `node-pre-gyp`; (c) fallback to the tmux launcher if `node-pty` is unavailable. Recommend (a) for MVP with (c) as the graceful-degradation path.
2. **PTY columns/rows defaults** — What are the default dimensions when the dashboard client hasn't reported a size yet? [ASSUMPTION: 220 cols × 50 rows as a reasonable default for wide TUIs]
3. **Multiple dashboard clients per agent** — If two browser tabs open the dashboard simultaneously, both subscribe to SSE. Should each get the PTY stream independently, or does one connection own the input channel? [ASSUMPTION: all SSE subscribers get output; only the last WebSocket connection sending input wins]
4. **Graceful degradation when node-pty build fails** — Should the dashboard surface a warning and fall back to tmux, or hard-block the launch? Recommend: warn + fallback to `tmux-cli-launcher.js` if node-pty is not available.
5. **`script`/`socat` for optional tmux display surface (FR-9)** — Which pipe mechanism is most portable for connecting the PTY slave to a tmux pane without requiring root?
6. **Process durability across dashboard restarts** — [CRITICAL] node-pty children are parented to the dashboard process. When `dashboard.js` restarts (which happens on every edit to dashboard.js/server.js), all running agent PTYs are killed. tmux did not have this problem (agents live in a separate daemon). Options to resolve: (a) detach/reparent the PTY child via double-fork/setsid — but the master fd is lost when the parent dies, breaking capture; (b) run the launcher as a separate long-lived daemon that the dashboard communicates with over a socket (PTYs survive dashboard restarts) — cleanest path; (c) accept the limitation and document it (poor UX); (d) revisit a PTY-tee topology inside tmux which sidesteps the issue entirely. **This is a gating architecture decision before implementation.** See Opus's design brief at `.neohive/artifacts/Opus/pty-design-input.md`.

## 9. Assumptions Index

- §2.2 / FR-1: Headless batch agent spawn (no PTY) is out of scope for v1.
- §2.2: Windows native (CMD/PowerShell without WSL) is not a v1 target platform.
- §3 / FR-9: tmux session container integration (FR-9) is opt-in, not required for v1.
- FR-1: 50 ms latency budget for PTY data events is sufficient for interactive use.
- FR-10 / OQ-3: All SSE subscribers receive PTY output; last WebSocket connection wins for input.
- §6.1: `lib/tmux-cli-launcher.js` is soft-deprecated in v1, not hard-deleted (allows rollback).
- OQ-2: Default PTY dimensions: 220 cols × 50 rows.
