# Changelog

## [6.3.0] - 2026-04-05

### Added

- **Unified `next_action` response chain** — every MCP tool response now includes a single `next_action` field that tells the AI agent exactly what to do next, replacing 10+ scattered hint fields (`_listen`, `_nudge`, `hint`, `action_required`, `unread_action`, `you_have_messages`, `urgent`, `mode_hint`, `_protocol`, etc.)
- **Tool-specific directives** — each tool sets a context-aware `next_action` (e.g. `update_task(done)` → "Send a summary via send_message(), then call listen()"; `lock_file` → "Edit the file, then call unlock_file() when done")
- **Coordinator-aware middleware** — post-processing middleware detects responsive coordinators and replaces any `listen()` directive with `consume_messages()` or removes it entirely, preventing coordinators from blocking in listen mode
- **Persistent listen loop** — `listen()` and `listen_group()` no longer return `retry: true` on timeout; they loop internally with fresh watchers and heartbeats, so agents cannot break out of listen mode
- **Managed mode next_action** — `buildListenGroupResponse` respects `should_respond` and floor state; agents without the floor get "do NOT respond" instead of "reply via send_message()"
- **Autonomous get_work() directives** — all 10 return types from `get_work()` carry specific `next_action` values guiding agents through the workflow/verify/advance cycle
- **Documentation** — `docs/reference/next-action-chain.md` with flow diagrams for standard agents, agent-to-agent communication, responsive/autonomous coordinators, managed mode, and persistent listen

### Changed

- **Post-processing middleware rewrite** — removed the scattered nudge/unread/listen injection block (~80 lines) and replaced with a unified `next_action` block using priority logic: tool-specific > coordinator override > call-count warning > urgent messages > pending messages > default
- **`buildMessageResponse`** — `_protocol` field inside message objects replaced with top-level `next_action`; `coordinator_mode` field removed from listen responses
- **`buildListenGroupResponse`** — simplified `next_action` with mode-aware branching (autonomous/managed/standard)
- **`send_message` / `broadcast`** — removed `you_have_messages`, `urgent`, `mode_hint` fields; added `next_action: "Call listen() to receive replies."`
- **`verify_and_advance`** — replaced verbose `message` strings with concise `next_action` directives

### Fixed

- **Responsive coordinator contradiction** — `send_message`, `broadcast`, and `create_task` no longer unconditionally tell responsive coordinators to call `listen()`; middleware overrides any `listen()` directive for responsive coordinators
- **Managed mode contradiction** — `buildListenGroupResponse` no longer sets "Reply via send_message()" when `should_respond: false` and `instructions: "DO NOT RESPOND"` are also present
- **Autonomous listen_group retry** — removed contradictory `retry: true` from autonomous mode timeout path where `next_action` directs to `get_work()` instead

## [6.1.0] - 2026-04-04

### Added

- **Modular tools architecture** — server-side tools split into `agent-bridge/tools/` directory for maintainability; each tool file is independently loaded at startup
- **Terminal bridge** — `terminal-bridge.js` streams live terminal output to the dashboard with lazy-loaded xterm.js and per-agent isolation; agent status pills show real-time session state
- **Agent liveness detection v2** — deterministic online/offline/stale/unknown states with heartbeat epoch tracking; dead seats are auto-reclaimed on `register()` and spare seats offered immediately
- **Listen outcome payload** — `listen()` returns a structured result object with `outcome`, `message`, and `agent` fields for richer branching logic
- **Liveness sparkline + nudge UI** — dashboard renders a mini activity graph per agent and one-click nudge button for unresponsive agents
- **Server-side auto-nudge** — coordinator receives an escalation message when a non-compliant agent misses its `listen()` window
- **Audit log** — every MCP tool call appended to `audit_log.jsonl`; new `log_violation` tool writes policy violations to the same log; dashboard has a dedicated Audit view
- **Push approval workflow** — `request_push_approval` / `ack_push` tools add a human-in-the-loop gate before git pushes
- **Review gate on task completion** — `update_task(status="done")` can require `request_review` + `submit_review` before the done event fires; `review_approved` event broadcasts on approval
- **Scoped rules** — `add_rule` / `list_rules` accept `role`, `provider`, and `agent` filters so rules are applied only to matching agents
- **Platform-specific default skills** — `register()` auto-populates the agent's skill list based on detected IDE/CLI provider (Claude Code, Cursor, Copilot, Gemini)
- **Token usage in profile popup** — dashboard resolves the Claude session via ppid walk and displays token usage directly in the agent profile card
- **VS Code extension: chat participant** — `@neohive` chat participant with slash commands (`/task`, `/broadcast`, `/status`) and a coordinator pipe for inline coordination from Copilot Chat
- **VS Code extension: Claude Code hooks setup** — extension auto-configures `UserPromptSubmit` and `PostToolUse` hooks on activation; version shown in status bar
- **Hooks system** — `PostToolUse` hook echoes `send_message` calls to the current chat transcript; `UserPromptSubmit` hook injects context; `enforce-listen.sh` stop hook escalates non-compliant agents
- **Self-healing watchdog** — stuck tasks are automatically reclaimed after a configurable timeout; escalates to `blocked_permanent` with poison-pill after max retries; `retry_count` badge shown in dashboard
- **Design system** — `design-system.css` ships design tokens (colors, radii, shadows, glassmorphism variables) consumed by the dashboard; SVG logo and favicon served as dedicated endpoints
- **Multi-IDE MCP setup** — `neohive init` upserts configs for Claude Code, Cursor, Copilot, Gemini CLI, and Codex TOML in one pass using absolute Node.js paths
- **Agent name config in VS Code** — extension setting `neohive.agentName` with format validation; used automatically in MCP config generation

### Changed

- **Tool consolidation (Phase 1)** — `check_messages` / `consume_messages` merged into the unified `messages` tool with a `mode` param; deprecated aliases removed for a clean API surface
- **Config centralization** — `SERVER_CONFIG` and `CLI_CONFIG` objects in `server.js` replace all scattered magic numbers (timeouts, limits, intervals)
- **Dashboard route dispatch** — simple GET routes moved to a dispatch table; reduces deeply nested if-chains in `dashboard.js`
- **Dashboard agent popup** — redesigned as a 3-tab layout (Stats · Actions · Profile) with inline profile editing, skill tags, and stuck/unresponsive indicators (orange/red dot + badge)
- **System events** — dashboard renders system events as compact, color-coded icon banners instead of raw log lines
- **Glassmorphism UI** — header and sidebar use backdrop-filter blur; agent cards gain micro-animations on hover and status-change
- **Slack-style new-messages banner** — pill appears above the message list when unread messages arrive while scrolled up

### Fixed

- **Agent disappearance race condition** — `register()` now uses a file-level write lock to prevent two agents stomping on `agents.json` simultaneously; epoch-0 liveness spam suppressed
- **Mobile dashboard** — menu toggle restored; textarea stretches full width; inject-target dropdown populates correctly on small screens
- **Dashboard scroll preservation** — message list no longer jumps to top on full re-render
- **MCP portability** — VS Code extension uses local `node` + `server.js` paths to avoid published-package port conflicts
- **Nudge suppression** — auto-nudge only injects a message when the agent has genuinely missed its window; compliant agents are skipped

## [6.0.3] - 2026-04-03

### Fixed

- **MCP data directory** — When the MCP process starts with cwd outside the repo (e.g. Cursor home) and no `NEOHIVE_DATA_DIR`, resolve the hive from repo `.cursor/mcp.json` / sibling config (`lib/resolve-server-data-dir.js`); `lib/config.js` uses the same root so agents and dashboard agree.
- **Dashboard `projects.json`** — Only rewrite the projects file when the canonical list differs from on-disk data (`pack(nonRedundant) !== pack(raw)`), not on every load when duplicates or default-hive rows were only present in the normalized pass-through list.

## [6.0.2] - 2026-04-02

### Added
- **Human agent mode** — users can join the team as a human agent via the dashboard
- **Agent card grid** — overview page shows agent cards with status, active tasks, and quick actions
- **Checkpoint system** — save and restore agent state snapshots for resumable work
- **Agent approval flow** — tasks can require explicit agent approval before advancing

### Fixed
- Message loss on SSE reconnect
- Token hijack race condition in `listen()`
- Spinlock in file-based task claiming
- Silent errors in workflow advancement
- Messages nav item flickering (switchView scope was too broad)
- Version strings synced to v6.0.0 across all files

### Changed
- Dashboard full visual rebrand — amber/gold NeoHive identity with icon rail, overview page, agent bar, and toast notifications
- Full layout redesign: icon rail sidebar, overview landing page, agent status bar

## [6.0.0] - 2026-04-02

### Breaking — Full Rebrand & Modularization

- **Renamed** — data directory migrated from `.agent-bridge/` → `.neohive/`; startup auto-migrates legacy directories
- **Modularization** — core business logic extracted to `lib/` modules (`messaging`, `file-io`, `config`, `hooks`, `resolve-server-data-dir`, etc.)
- **Security hardening** — comprehensive audit: path traversal, XSS, CSRF, symlink, injection, and DoS fixes across dashboard and MCP server
- **New README** — professional redesign with badges, feature showcase, architecture diagram, and visual hierarchy
- **`.agent-bridge/` auto-migration** — startup detects and renames legacy data directory with zero data loss

## [5.3.0] - 2026-03-20

### Listen System Overhaul — Zero Token Waste

- **5-minute listen timeout** — `listen()` and `listen_group()` now block for 5 minutes (was 45s), reducing idle token overhead by 7x
- **fs.watch instant wake** — agents wake immediately when a message arrives, zero CPU/tokens while waiting
- **Fixed collectBatch bug** — file path was passed as branch name to `sanitizeName()`, breaking `listen_group()` on all platforms
- **Mode-aware instructions** — managed mode says `listen()`, group mode says `listen_group()`, all modes say "NEVER use sleep()"
- **Managed mode task tracking** — manager creates tasks/workflows, agents update status as they work (Tasks/Plan tabs stay current)
- **check_messages warns against loops** — response includes `action_required` telling agents to use `listen()` instead
- **listen_codex restricted** — description explicitly says "ONLY for Codex CLI, Claude/Gemini must use listen()"

## [5.2.6] - 2026-03-20

### Changed
- Managed mode guide updated — agents now track active tasks with `update_task` and advance workflows with `advance_workflow` as they work, keeping the Tasks/Plan tabs current in real time

## [5.2.5] - 2026-03-20

### Fixed
- Token waste — `check_messages` response now includes `action_required` field warning agents to use `listen()` instead of polling loops
- `listen_codex` description explicitly restricted to Codex CLI only; Claude and Gemini agents must use `listen()`

## [5.2.4] - 2026-03-20

### Fixed
- All listen instruction strings updated to be mode-aware: managed mode instructs `listen()`, group mode instructs `listen_group()`, all modes say "NEVER use sleep()"

## [5.2.3] - 2026-03-20

### Fixed
- Mode-aware listen instructions — each conversation mode now returns the correct listen command name in its guide

## [5.2.2] - 2026-03-20

### Fixed
- Managed mode guide corrected — agents should call `listen()` (not `listen_group()`) between turns in managed mode

## [5.2.1] - 2026-03-20

### Fixed
- Managed mode guide corrected — agents should use `listen_group()` instead of sleep loops between turns

## [5.2.0] - 2026-03-20

### Security Hardening (50+ fixes across 5 audit rounds)

- **Timing-safe** LAN token comparison (`crypto.timingSafeEqual`)
- **File permissions** — `.neohive/` created with `0o700`, `.lan-token` with `0o600`
- **XSS prevention** — `escapeHtml` escapes 6 characters, thread panel escaped, replay export `</script>` escaped, null byte placeholder collision fixed
- **Path traversal** — containment checks on `/lib/`, `/office/`, `/mods/` with `path.resolve`, mods asset write validated, conversation name regex
- **Rate limiting** — per-IP API rate limit (300/min), per-IP SSE limit (5), duplicate message detection, escalation broadcast rate limited
- **File locking** — tasks, workflows, channels all use `withFileLock`, PID-checked force-break, task claiming atomic
- **Input validation** — content type guards, stricter limits on some dashboard API bodies, agent name regex on all endpoints, avatar URL scheme validation
- **Security headers** — X-Frame-Options DENY, X-Content-Type-Options nosniff, Referrer-Policy no-referrer, CSP frame-ancestors none
- **Token removed** from all API responses, destructive endpoints require `confirm: true`
- **KB prompt injection** prevented — content in separate `reference_notes` field
- **share_file** denylist for .env, .pem, .key, credentials, data directory
- **Reserved names** — "Dashboard" blocked from agent registration
- **Manager claim** TOCTOU fixed with config lock

### Cross-Platform Compatibility

- **Windows line endings** — all JSONL parsing uses `/\r?\n/` (24 sites fixed)
- **Portable config paths** — removed hardcoded absolute paths from env vars
- **Codex config backup** — creates `.backup` before modification
- Works identically on Windows, macOS, and Linux

### New Features

- **Uninstall command** — `npx neohive uninstall` cleanly removes config entries from Claude/Gemini/Codex
- **Conversation management** — Clear Messages, New Conversation (archive + start fresh), Load saved conversations
- **Display names** — messages show profile display_name instead of raw registered name
- **Re-registration prevention** — agents can't change name mid-session

### Fixed

- 11 full-file read optimizations (tailReadJsonl)
- Test script updated (referenced deleted files)
- Node engine requirement updated to >=18.0.0
- Tool count console message corrected (66 tools)
- SSE heartbeat `.unref()` added
- Monitor workspace log capped with safe fallback
- Edit history capped at 10 entries per message

## [5.1.0] - 2026-03-19

### Major — True Autonomy Engine + Team Intelligence + Scale to 100 Agents

Built by a 4-agent team (Backend, Protocol, Tester, Coordinator) + Advisor agent, working autonomously.

### Added — Autonomy Engine (v5.0)
- **get_work** — 9-level priority waterfall: workflow step > messages > unclaimed tasks > help requests > reviews > blocked tasks > 30s listen > prep work > idle
- **verify_and_advance** — confidence-gated auto-advancement (>=70 auto, 40-69 flag, <40 help)
- **start_plan** — one-click autonomous plan launch with parallel step activation
- **retry_with_improvement** — 3-attempt retry with KB skill accumulation, team escalation
- **Parallel workflow steps** — dependency graph with `depends_on`, `findReadySteps` resolver
- **Autonomous mode** — proactive work loop guide, tiered cooldowns (0ms handoffs), 30s listen cap, relaxed send limits

### Added — Team Intelligence
- **Auto-role assignment** — lead/quality/implementer/monitor/advisor roles based on team size
- **Quality Lead** — always-on checker with dedicated guide, review-retry loop, auto-approve after 2 rounds
- **Monitor Agent** — system health overseer at 10+ agents: idle detection, circular escalation detection, auto-intervention, failover
- **Advisor Agent** — strategic thinker at 5+ agents: reads all work, gives ideas, challenges assumptions
- **Self-continuation** — agents never ask user, find next work automatically
- **Smart prompt distribution** — auto-generates workflows from natural language prompts

### Added — Advanced Autonomy (10 features)
- Task-level circuit breaker (blocked_permanent after 3 agent failures)
- Quality Lead instant failover (highest reputation auto-promoted)
- Context inheritance on escalation (full failure history)
- Agent circuit breaker (consecutive_rejections tracking, auto-demotion)
- Dynamic role fluidity (workload-based rebalancing)
- Skill-based task routing (agent affinity scoring)
- Work stealing (idle agents claim from busy agents)
- Checkpointing (resumable work via workspace snapshots)
- Retrospective learning (aggregate failure pattern analysis)
- Backpressure signal (queue depth warnings)

### Added — Scale to 100 Agents
- Per-agent heartbeat files (zero write contention)
- Cooldown cap (3s max regardless of agent count, 0ms for handoffs)
- Byte-offset message reads (O(new_messages) not O(all))
- Exponential backoff on file locks (1ms-500ms, not 50ms busy-wait)
- isPidAlive cache (5s TTL, saves 10K syscalls/sec)
- SSE debounce (heartbeat files filtered, 2s debounce)
- Task keyword cache (30s TTL)
- Sticky roles (no churn on agent reconnect)
- Zero cooldown for channel messages + handoffs in autonomous mode

### Added — Dashboard & CLI
- **Plan execution view** — progress bar, step cards, confidence, controls (pause/stop/skip/reassign)
- **Monitor health panel** — agent health grid, intervention log, system metrics
- **`npx neohive run "prompt" --agents N`** — one-command autonomous execution
- **npm test** wires v5 test suite (158+ tests on every run)
- Updated conversation templates (autonomous format with depends_on)

### Stats
- server.js: 6,200+ lines, 62+ tools
- 175+ automated tests, 0 fail
- 5 conversation templates (autonomous format)
- Built in ~2 hours by autonomous agent team

## [4.3.0] - 2026-03-17

### Major — Agent Respawn, Team Automation

Built by a 5-agent team (Architect, Builder, Tester, Optimizer, Protocol) working in parallel.

### Added — Dashboard
- **Respawn button** — One-click respawn for dead agents. Generates a resume prompt from the agent's recovery snapshot, profile, active tasks, and recent message history.
- **Respawn API** — `GET /api/agents/:name/respawn-prompt` endpoint returns full context for agent resurrection.

### Fixed
- **Respawn endpoint validation** — Agent name validated (alphanumeric, max 20 chars) to prevent path traversal.

### Security
- npm audit: 0 vulnerabilities
- CSRF protection verified on all mutating endpoints
- Input validation on all user-facing API parameters
- No hardcoded secrets or sensitive data in shipped package

## [4.2.0] - 2026-03-17

### Major — Team Intelligence, Dashboard Upgrade, Performance

Built by a 4-agent team (Architect, Tester, Protocol, Builder) working in parallel.

### Added — Team Automation
- **Auto-escalation** — blocked tasks auto-broadcast `[ESCALATION]` to team after 5 minutes. File-based dedup via `task.escalated_at` field (cross-process safe). Clears on unblock.
- **Stand-up meetings** — config-driven periodic team check-ins (`standup_interval_hours` in config.json). File-based dedup, 5+ agent gate. Broadcasts task summary with in-progress/blocked/done counts.
- **Quality gates** — `update_task(done)` auto-broadcasts `[REVIEW NEEDED]` (from v4.1.0, now with auto-escalation integration).

### Added — Agent Intelligence
- **Workload metrics** — reputation tracks `task_times[]` (completion seconds), leaderboard shows `avg_task_time_sec` per agent.
- **Smarter suggest_task** — caps at 3 in-progress tasks ("finish first"), suggests blocked tasks when no pending ones, workload-aware.
- **KB hints in listen_group** — batch messages checked against KB keys, returns `kb_hints` with relevant entries.
- **Thread reply context** — `listen_group` includes `_reply_context` preview of parent message for threaded replies.
- **Decision overlap hints** — `send_message` checks content against logged decisions, returns `_decision_hint` to prevent re-debating.
- **Auto-status board** — `update_task` auto-writes `_status` to agent workspace ("Working on: X"). `list_agents` includes `current_status` field.

### Added — Dashboard
- **Agent intent display** — dashboard shows what each agent is currently working on (from workspace `_status`)
- **Channel badges** — messages show colored `#channel` badges
- **Channel filter bar** — horizontal scrollable tabs to filter messages by channel
- **Channel history merging** — `/api/history` merges channel-specific + general history files
- **`/api/channels` endpoint** — channel list with member counts for dashboard
- **`/api/decisions` endpoint** — decision log display in dashboard
- **Decision log UI** — chronological cards with topic, decision, reasoning, author

### Improved — Performance & Safety
- **Escalation dedup fix** — replaced in-memory `_escalatedTasks` Set with file-based `task.escalated_at` field (cross-process safe for 10 agents)
- **Dashboard current_status API** — `/api/agents` includes workspace `_status` for agent intent board

## [4.1.0] - 2026-03-17

### Added — Agent Reliability & Intelligence

- **Auto-recovery (crash resume)** — when an agent's process dies, the server snapshots its state (active tasks, locked files, channels, workspace keys, last 5 messages) to `recovery-{name}.json`. When a replacement registers with the same name, the snapshot is included in the register response with instructions to resume, not restart. 1-hour TTL, auto-deletes after load.
- **Quality gates** — `update_task(id, "done")` auto-broadcasts `[REVIEW NEEDED]` to all alive agents. Teams get automatic review cycles without manually calling `request_review()`.
- **Decision overlap hints** — `send_message` in group mode checks content against existing logged decisions. Returns `_decision_hint` if a related decision exists, preventing teams from re-debating settled topics.
- **Enhanced `check_messages`** — now returns rich summary: `senders`, `addressed_to_you`, `preview`, `urgency` level. The proactive counterpart to the enhanced nudge.

### Fixed
- **Recovery lock notes** — snapshot correctly labels locked files as `locked_files_released` with note that locks were auto-released.

## [4.0.0] - 2026-03-17

### Major Release — 10-Agent Free Group Mode

Massive scaling overhaul designed, implemented, and audited by a 3-agent team (Architect, Tester, Protocol). 12 changes, 3 bugs caught during collaborative code review.

### Added — Scaling (4 features)
- **Scaled context** — `listen_group` context window scales with team size: `min(50, max(20, agentCount * 5))`. 3 agents = 20 messages, 10 agents = 50.
- **Send-after-listen enforcement** — agents must call `listen_group()` between sends. Prevents message storms. Addressed agents get 2 sends per cycle, others get 1.
- **Response budget** — max 2 unaddressed sends per 60 seconds. Time-based reset. Hint (not error) when depleted.
- **Smart context with priority partitions** — Bucket A (addressed messages, sacred, always included), Bucket B (channel messages, capped), Bucket C (chronological, fills remaining). Total guaranteed <= contextSize.

### Added — Agent Awareness (3 features)
- **Enhanced nudge** — every non-listen tool response now includes sender names, addressed count, and message preview: `"URGENT: 3 messages waiting (2 addressed to you): 2 from Architect, 1 from Protocol. Latest: 'Need your review...'"`
- **Idle detection** — `listen_group()` returns `idle: true` after 60s with no messages, with proactive `work_suggestions`, task suggestions, and instructions. Agents auto-find work instead of blocking forever.
- **Enhanced `check_messages`** — now returns rich summary: `senders`, `addressed_to_you`, `preview`, `urgency` level. The proactive counterpart to the passive nudge.

### Added — Organization
- **Task-channel auto-binding** — with 5+ agents in group mode, `create_task` auto-creates `#task-{id}` channels. Assignees auto-join on claim. Channels auto-delete on task completion. Naturally splits 10-agent noise into focused sub-teams.

### Improved — Performance
- **Cached reads** — `getAgents()` (1.5s TTL), `getChannelsData()` (3s TTL), `getTasks()` (2s TTL) with write-through invalidation. Eliminates ~70% redundant disk I/O.
- **Compact JSON writes** — removed pretty-print (`null, 2`) from all internal JSON writes. 2-3x less I/O overhead.
- **Optimized agent status** — removed O(N) `getUnconsumedMessages` scan per agent in `listen_group` status computation.
- **Dashboard SSE race fix** — `Array.from()` before Set iteration prevents skipped clients during concurrent connect/disconnect.
- **Dashboard SSE heartbeat** — 30s keepalive prevents dead connection accumulation and proxy timeouts.
- **Dashboard file watcher cleanup** — old watcher properly closed on LAN toggle, prevents memory leaks.
- **Dashboard watcher filter** — only triggers on `.json`/`.jsonl` files, ignores lock files and temp files.

### Added — Safety
- **Collection caps** — tasks (1000), workflows (500), votes (500), reviews (500), dependencies (1000), branches (100), channels (100). Prevents DoS via unbounded growth.
- **Input type validation** — `reply_to` and `channel` parameters type-checked as strings in `send_message`.
- **Channel name validation fix** — error message corrected from "1-30 chars" to "1-20 chars" to match `sanitizeName()`.

## [3.10.1] - 2026-03-17

### Added
- **Stuck detector** — `listen_group()` detects when an agent has sent the same error or message pattern 3 times in a row and injects targeted hints to break the loop

## [3.10.0] - 2026-03-17

### Added — Dynamic Guide with Progressive Disclosure
- **`buildGuide()`** — replaces hardcoded guide in register() and get_guide(). Returns only rules relevant to the current system state.
- **Tiered rules:** Tier 0 (listen after every action), Tier 1 (core behavior), Tier 2 (group mode features), Tier 2b (channels), Tier 3 (large teams 5+)
- **User-customizable:** `.neohive/guide.md` for project-specific rules
- 2-agent direct mode = 5 rules. 10-agent group with channels = 12 rules.

## [3.9.1] - 2026-03-17

### Added
- **Per-channel cooldown** — uses channel member count instead of total agents. 2-member #backend = 1s, regardless of 10 in #general
- **`cooldown_applied_ms`** — diagnostic field in send_message response showing exact cooldown applied
- **`channel` field** in send_message response when sending to a channel

### Fixed
- Task race condition — `update_task` rejects claiming tasks already in_progress by another agent

## [3.9.0] - 2026-03-17

### Added — Channels & Split Cooldown

- **`join_channel(name, description?)`** — create or join a channel for sub-team communication
- **`leave_channel(name)`** — leave a channel (can't leave #general, empty channels auto-delete)
- **`list_channels()`** — list all channels with members, message counts, membership status
- **`send_message` channel parameter** — send to specific channel (`channel-{name}-messages.jsonl`)
- **`listen_group` reads all subscribed channels** — merges messages from general + channel files, sorted by timestamp
- **Channel validation** — sending to nonexistent channel returns error with hint to create it
- **Ghost member cleanup** — heartbeat auto-removes dead agents from channel membership
- **#general auto-created** — `members: ["*"]` (everyone), uses existing messages.jsonl for backward compat
- **Split cooldown (reply_to-based)** — fast lane (500ms) for addressed agents, slow lane (max 2000, N*1000) for unaddressed, incentivizes threading

### Fixed
- Task race condition — `update_task` now rejects claiming a task already in_progress by another agent, auto-assigns on claim

## [3.8.0] - 2026-03-16

### Changed — Group Conversation Overhaul

Redesigned from the ground up based on 3-agent collaborative testing and design session.

**Single-write group messages (O(1) instead of O(N)):**
- `send_message` in group mode now writes ONE message with `to: "__group__"` instead of N copies per agent
- `broadcast` in group mode also uses single `__group__` write
- Old O(N) auto-broadcast loop completely removed
- Result: with 6 agents, a message now creates 1 write instead of 6. A broadcast round that previously created 30 writes now creates 6.

**`addressed_to` field + `should_respond` hints:**
- `send_message(to="AgentName")` in group mode stores `addressed_to: ["AgentName"]` on the `__group__` message
- `listen_group` response includes `addressed_to_you: true/false` and `should_respond: true/false` per message
- Hint-based, not enforced — agents can still respond when they have valuable input
- No `addressed_to` = everyone should respond (backwards compatible)

**Adaptive cooldown:**
- Cooldown now scales with team size: `max(500ms, N * 500ms)` where N = alive agent count
- 2 agents = 1s, 3 agents = 1.5s, 6 agents = 3s, 10 agents = 5s
- Explicit `group_cooldown` config still respected if set

**Shorter stagger:**
- Deterministic stagger reduced from 0-3000ms to 500-1500ms
- Same agent always gets the same delay (hash-based)

**Alive-only garbage collection:**
- `autoCompact` for `__group__` messages only checks alive agents for consumed tracking
- Dead agents no longer block message compaction forever
- Dead agents catch up via `get_compressed_history()` which reads history.jsonl (never compacted)

**Own-message filtering:**
- Agents no longer see their own `__group__` messages in `listen_group` batches
- Own messages are auto-consumed on sight
- Own messages still visible in `context` array for reference

## [3.7.0] - 2026-03-16

### Added — Agent Ecosystem (20 new tools, 52 total)

**Tier 1 — Critical Infrastructure:**
- **`get_briefing()`** — full project onboarding in one call: agents, tasks, decisions, KB, locked files, progress, project file tree
- **`lock_file(path)` / `unlock_file(path?)`** — exclusive file editing with auto-release on agent death
- **`log_decision(decision, reasoning?, topic?)` / `get_decisions(topic?)`** — persistent decision log, prevents re-debating
- **Agent recovery on rejoin** — `register()` returns active tasks, workspace keys, recent messages for returning agents

**Tier 2 — Quality of Life:**
- **`kb_write(key, content)` / `kb_read(key?)` / `kb_list()`** — shared team knowledge base (any agent reads/writes)
- **Event hooks** — auto-fires system messages on `agent_join`, `task_complete`, `all_tasks_done`, `dependency_met`
- **`update_progress(feature, percent, notes)` / `get_progress()`** — feature-level progress tracking with overall %
- **`get_compressed_history()`** — auto-compresses old messages into summary segments, keeps recent verbatim
- **`listen_group()` now blocks indefinitely** — no more timeout, agents never drop out

**Tier 3 — Advanced Collaboration:**
- **`call_vote(question, options)` / `cast_vote(vote_id, choice)` / `vote_status(vote_id?)`** — team voting with auto-resolve when all vote
- **`request_review(file, desc)` / `submit_review(review_id, status, feedback)`** — code review pipeline with approve/changes_requested
- **`declare_dependency(task_id, depends_on)` / `check_dependencies(task_id?)`** — task dependency tracking with auto-notify on resolve
- **`get_reputation(agent?)` / `suggest_task()`** — agent reputation tracking (auto-detects strengths), task suggestions based on skills
- **Auto-reputation tracking** — global hook tracks every action (messages, tasks, reviews, decisions, KB writes) without manual calls

### Fixed
- **Status color logic** — green = listening, red = active but not listening, yellow = sleeping, dim = dead

## [3.6.2] - 2026-03-16

### Added — Message Awareness System
- **Sender gets busy status** — `send_message` and `broadcast` tell you when recipients are working (not listening) so you know messages are queued
- **Pending message nudge** — every non-listen tool call checks for unread messages and tells the agent to call `listen_group()` soon
- **Message age tracking** — `listen_group` shows `age_seconds` per message and `delayed: true` flag for messages older than 30s
- **Agent status in batch** — `listen_group` returns `agents_status` map showing who is `listening` vs `working`
- **listen_group retry** — timeout now returns `retry: true` with explicit instruction to call again immediately
- **next_action field** — successful `listen_group` response tells agent to call `listen_group()` again after responding

## [3.6.0] - 2026-03-16

### Added — Managed Conversation Mode

- **`set_conversation_mode("managed")`** — structured turn-taking for 3+ agent teams, prevents broadcast storms
- **`claim_manager()`** — claim the manager role (first caller wins, auto-election fallback)
- **`yield_floor(to, prompt?)`** — manager-only: give an agent permission to speak (directed, round-robin `__open__`, or close `__close__`)
- **`set_phase(phase)`** — manager-only: move team through discussion → planning → execution → review with auto-instructions to all agents
- **Floor enforcement** — `send_message`, `broadcast`, `handoff`, and `share_file` all block non-floor-holders with actionable error messages
- **Auto-advance turns** — floor returns to manager after directed responses; round-robin advances to next alive agent automatically
- **Manager disconnect recovery** — heartbeat detects dead manager within 10-30s, notifies all agents to re-elect
- **Dead turn-holder detection** — heartbeat detects dead agents holding the floor and resets it
- **Managed mode in `listen_group()`** — returns `managed_context`, `should_respond`, and `instructions` to guide agent behavior
- **`managed` template** — 4-agent team (Manager, Designer, Coder, Tester) with structured prompts
- **`managed-team` conversation template** — dashboard-launchable version
- **Dashboard Docs tab** — in-dashboard documentation with full tool reference, managed mode guide, architecture, version history
- **Dashboard managed mode badge** — header shows current phase and floor status when managed mode is active

### Security
- **Config file lock** — `config.json` read-modify-write operations now use file-based locking (same pattern as `agents.json`)
- **Reserved name blocklist** — `__system__`, `__all__`, `__open__`, `__close__`, `system` cannot be registered as agent names
- **Mode change protection** — only the manager can switch away from managed mode
- **Floor enforcement on all message paths** — `handoff` and `share_file` now enforce managed mode floor control
- **Branch-aware system messages** — floor/phase notifications sent to recipient's branch, not sender's
- **Phase history cap** — limited to 50 entries to prevent config.json bloat

## [3.5.0] - 2026-03-15

### Added — Group Conversation Mode
- **`set_conversation_mode("group")`** — enables free multi-agent collaboration with auto-broadcast
- **`listen_group()`** — batch message receiver with random stagger (1-3s) to prevent simultaneous responses
- Returns ALL unconsumed messages + last 20 messages of context + hints about silent agents
- Auto-broadcast in group mode: every message is shared with all agents automatically
- Cooldown enforcement: agents must wait 3s between sends to maintain conversation flow
- Cascade prevention: broadcast copies don't trigger further broadcasts
- MCP tools: 27 → 29

### Added — Dashboard Features
- **Notification panel** — bell icon with badge count, dropdown event feed (agent online/offline, listening status changes)
- **Agent leaderboard** — performance scoring (0-100) with responsiveness, activity, reliability, collaboration dimensions
- **Cross-project search** — "All Projects" toggle in search bar, searches across all registered projects
- **Animated replay export** — Export conversation as self-playing HTML file with typing animations and play/pause controls
- **Ollama integration** — `npx neohive init --ollama` auto-detects Ollama, creates bridge script for local models

### Fixed — PID & Registration Integrity
- Registration file locking with try/finally (prevents race conditions when multiple agents register simultaneously)
- PID stale detection uses `last_activity` with 30s threshold (prevents false "alive" from Windows PID reuse)
- Lock file cleaned up on process exit
- Dashboard inject/nudge snapshots project context at click time (prevents wrong-project race)

### Security
- `toolHandoff` and workflow auto-handoff now check `canSendTo` permissions
- `lastSentAt` updated in `toolBroadcast` (prevents cooldown bypass)
- `config.json` added to both server and dashboard reset cleanup
- Auto-broadcast respects `canSendTo` per recipient

## [3.4.4] - 2026-03-15

### Fixed
- Add project now accepts any existing directory (removed requirement for package.json or .git)
- Init safely backs up corrupted .mcp.json and settings.json before overwriting

### Changed
- Removed plugin references from website and docs
- Website updated with security features (LAN auth token, CSRF, CSP)

## [3.4.3] - 2026-03-15

### Removed — Plugin System
- Removed the entire plugin system (`vm.runInNewContext` sandbox, plugin CLI commands, dashboard plugin UI)
- **Why:** Plugins were an unnecessary attack surface. Node.js `vm` is not a security sandbox — plugins could escape and execute arbitrary OS commands. CLI terminals (Claude Code, Gemini, Codex) have their own extension systems, making our plugins redundant.
- `npx neohive plugin` now shows a deprecation notice
- MCP tools reduced from 27 + plugins to 27 (all core tools remain)
- ~200 lines of code removed from server.js, cli.js, dashboard.js, dashboard.html

## [3.4.2] - 2026-03-15

### Security — CSRF Protection
- Required `X-LTT-Request` custom header on all POST/PUT/DELETE requests
- `lttFetch` wrapper in dashboard automatically includes the header
- Malicious cross-origin pages cannot set custom headers without CORS preflight approval
- Removed wildcard `Access-Control-Allow-Origin: *` in LAN mode — now uses explicit trusted origins only
- Empty Origin/Referer no longer auto-trusted — requires custom header as minimum protection

### Security — LAN Auth Token
- Auto-generated 32-char hex token when LAN mode is enabled
- Token required for all non-localhost requests (via `?token=` query param or `X-LTT-Token` header)
- Token included in QR code URL — phone scans and it just works
- Token displayed in phone access modal with explanation
- New token generated each time LAN mode is toggled on
- Token persists across server restarts via `.lan-token` file
- Localhost access never requires a token

### Security — Content Security Policy
- CSP header added to dashboard HTML response
- `script-src 'unsafe-inline'` for inline handlers, blocks `eval()` and external scripts
- `connect-src 'self'` restricts API calls to same origin
- `font-src`, `style-src`, `img-src` scoped to required sources only

### Fixed
- CSRF brace imbalance that trapped GET handlers inside POST-only block
- LAN token not forwarded from phone URL to API calls and SSE
- Redundant nested origin check collapsed to single condition

## [3.4.1] - 2026-03-15

### Added
- **File-level mutex** — in-memory promise queue per file for serializing edit/delete operations
- **Agent permissions enforcement** — `canSendTo()` checks in `send_message` and `broadcast`, `can_read` filtering in `get_history` and message delivery
- **Read receipts** — auto-recorded when agents consume messages, visible as agent-initial dots under messages in dashboard

### Security
- HTTP 500 responses now return generic error instead of raw `err.message` (prevents filesystem path leaks)
- `/api/discover` changed from GET to POST (now under CSRF protection)
- `workspace_read`/`workspace_list` validate agent name parameter with regex
- `get_history` filters results by agent's `can_read` permissions
- `read_receipts.json` and `permissions.json` added to both MCP and dashboard reset cleanup
- Dashboard workspace API regex aligned with server (`[a-zA-Z0-9_-]`)

### Fixed
- `toolWaitForReply` missing `markAsRead` calls (read receipts not recorded)
- `toolBroadcast` bypassing permission checks entirely
- `toolReset` not cleaning up `permissions.json` and `read_receipts.json`

## [3.4.0] - 2026-03-15

### Added — Dashboard Features
- **Stats Tab** — per-agent message counts, avg response time, peak hours, 24-hour activity chart, conversation velocity. Keyboard shortcut `6`.
- **Compact View** — toggle button in search bar. Hides avatars, inlines timestamps, reduces padding. Persists to localStorage.
- **Message Edit** — edit any message via hover action. Full edit history tracked, "edited" badge displayed.
- **Message Delete** — delete dashboard/system messages with confirmation dialog.
- **Copy Message** — clipboard button on message hover to copy raw content.
- **JSON Export** — new export format alongside HTML and Markdown.
- **Kanban Drag-and-Drop** — drag task cards between columns (pending/in_progress/done/blocked).
- **SSE Auto-Reconnect** — exponential backoff (1s→30s), yellow "Reconnecting..." indicator, polling fallback.
- **Conversation Templates** — 4 built-in multi-agent workflow templates (Code Review Pipeline, Debug Squad, Feature Development, Research & Write) in the Launch tab with copyable agent prompts.

### Added — API Endpoints
- `PUT /api/message` — edit a message (with edit history)
- `DELETE /api/message` — delete a message (dashboard/system only)
- `GET /api/conversation-templates` — list conversation templates
- `POST /api/conversation-templates/launch` — get template agent prompts
- `GET /api/stats` — analytics data (per-agent stats, velocity, hourly distribution)
- `GET/POST /api/permissions` — agent permission management

### Added — CLI Commands
- `npx neohive msg <agent> <text>` — send a message from CLI
- `npx neohive status` — show active agents and message counts

### Changed — Premium UI Redesign
- Deeper dark palette with blue undertones (#080b12 background)
- Inter font from Google Fonts with anti-aliased rendering
- Glassmorphism header with backdrop-filter blur
- Gradient accent system (blue→purple) on buttons, active tabs, send button
- Refined shadow system (sm/md/lg) with colored glows
- Focus rings on all inputs
- Smoother transitions (0.2-0.25s) with lift effects on hover
- Glass effects on modals and popups
- Inset shadows on code blocks
- Thinner scrollbars with transparent tracks

### Fixed
- Task notes crash when `notes` array undefined
- Message edit always rewrites messages.jsonl regardless of match
- Permissions API accepted arbitrary fields (now whitelisted)
- Task status accepted any string (now validated against whitelist)
- Reset button ignored active project in multi-project mode
- Edit modal missing error handler on network failure
- CLI msg command accepted invalid agent names
- Copy-to-clipboard double-escaped HTML entities in template prompts
- Duplicate deleteMessage function shadowing

## [3.3.3] - 2026-03-15

### Fixed
- iOS dashboard crash — `Notification` API unavailable on iOS Safari; wrapped in availability check
- Mobile UI overhaul — layout, font sizes, and button targets reworked for phone-sized screens
- Phone sync — wait for `loadProjects()` to complete before first poll; auto-select project when only one is registered
- LAN mode now persists across dashboard restarts (stored in `.lan-token` file)

## [3.3.2] - 2026-03-14

### Changed
- License changed from MIT to Business Source License 1.1 (BSL)
- Added SECURITY.md with vulnerability disclosure policy
- Added CHANGELOG.md to published npm package
- Added .npmignore for cleaner package distribution
- Version synced across all files (server, CLI, dashboard)

## [3.3.1] - 2026-03-14

### Added
- SECURITY.md with vulnerability disclosure policy
- CHANGELOG.md added to published npm package
- Version strings synced across server, CLI, dashboard, and package.json

## [3.3.0] - 2026-03-14

### Security — Deep Hardening
- **Sandbox hardening** — eval and Function constructor blocked in message rendering context
- **Anti-impersonation** — agents cannot register names that shadow existing live agents
- **Rate limiting** — per-agent send rate limiting (10 messages/10s) to prevent broadcast storms
- **Input sanitization** — agent name, message content, and task fields validated and length-capped on all endpoints
- Discord invite link added to README and docs

## [3.2.3] - 2026-03-14

### Fixed
- README added to npm package (`files` array in package.json)

## [3.2.2] - 2026-03-14

### Security
- CSRF protection added to all mutating dashboard endpoints
- XSS fixes in message rendering and export
- Symlink traversal prevention in file-serving routes
- Command injection guards on reset and init paths
- DoS mitigation: request body size limits, JSON parse error handling

## [3.2.1] - 2026-03-14

### Changed
- MCP SDK updated to 1.27.1
- Removed unused `exec` import from server.js

## [3.2.0] - 2026-03-14

### Added
- Documentation site scaffolding
- LICENSE file (MIT)
- MCP SDK version pinned to prevent breaking changes on install

### Fixed
- Reset crash when `.neohive/` directory contained unexpected files
- Version strings updated across all files

## [3.1.1] - 2026-03-14

### Added
- **Phone access modal** — dashboard shows QR code and LAN URL for mobile access
- **LAN toggle** — enable/disable LAN mode without restarting the server
- **Project auto-init** — adding a folder via the dashboard now initializes it if no `.neohive/` exists

### Fixed
- Avatar undefined in messages — `getMsgAvatar()` moved before conditional rendering
- Phone URL now includes the active project for automatic sync on mobile open
- Auto-switch to newly added project after adding via dashboard

## [3.1.0] - 2026-03-14

### Fixed
- LAN IP detection now prefers real interface addresses over link-local (`169.254.x.x`) and loopback addresses
- LAN toggle no longer kills the dashboard process (use `handle.close()` not `server.close()`)

## [3.0.0] - 2026-03-14

### Added — Agent Profiles
- New tool: `update_profile` (display_name, avatar, bio, role)
- 12 built-in SVG robot avatar icons with hash-based defaults
- Profiles auto-created on register, persist across restarts
- Profile data shown in dashboard (avatars, role badges, profile popup)

### Added — Agent Workspaces
- 3 new tools: `workspace_write`, `workspace_read`, `workspace_list`
- Per-agent key-value storage (50 keys max, 100KB per value)
- Agents can read anyone's workspace, write only their own
- Dashboard "Workspaces" tab with collapsible accordion UI

### Added — Workflow Automation
- 3 new tools: `create_workflow`, `advance_workflow`, `workflow_status`
- Multi-step pipelines with auto-handoff to step assignees
- Dashboard "Workflows" tab with horizontal pipeline visualization
- Dashboard can advance/skip workflow steps

### Added — Conversation Branching
- 3 new tools: `fork_conversation`, `switch_branch`, `list_branches`
- Fork at any message point with isolated branch history
- All message tools branch-aware (backward compatible — main branch uses existing files)
- Branch tabs in dashboard

### Added — Plugin System
- Dynamic tool loading from `plugins/*.js` files
- Sandboxed execution with 30s timeout
- CLI: `npx neohive plugin add/list/remove/enable/disable`
- Dashboard plugin cards with enable/disable toggles

### Changed
- MCP tools: 17 → 27 + dynamic plugins
- Dashboard tabs: 2 → 4 (Messages, Tasks, Workspaces, Workflows)
- Branch-aware history API (`?branch=` query param)
- Version bump across all files (server, dashboard, CLI, package.json)

## [2.5.0] - 2026-03-14

### Added
- Task management system: `create_task`, `update_task`, `list_tasks` tools
- Kanban board in dashboard (Messages/Tasks toggle)
- Agent stats panel (sent/received/avg response time per agent)
- Shareable HTML export (/api/export endpoint)
- Export dropdown (HTML + Markdown formats)
- Conversation bookmarks (star messages, localStorage)
- Sound notification toggle (Web Audio API)
- Typing indicator for processing agents
- Connection quality display (SSE latency)
- Date separators between message groups
- Message grouping for consecutive same-sender messages
- Project auto-discover (scan nearby folders)
- Copy-to-clipboard prompts in onboarding
- Dynamic tab title with message count
- Dashboard footer with version

### Security
- Path traversal fix in `share_file` (restricted to project dir)
- Path traversal fix in `?project=` param (validate against registered projects)
- 1MB message size limit on send/broadcast/handoff
- 1MB request body limit on dashboard POST endpoints
- XSS fix in HTML export (escape agent names)
- CORS restricted to localhost only (was wildcard)
- Dashboard binds to 127.0.0.1 only (was 0.0.0.0)
- Registration guard on `reset` tool
- Removed absolute file paths from share_file responses

## [2.4.0] - 2026-03-14

### Added
- Agent metrics panel — per-agent message counts, average response time, and activity sparklines
- Shareable HTML export — `/api/export` endpoint generates a self-contained replay file
- Export dropdown (HTML + Markdown formats)
- Stats panel in dashboard sidebar

## [2.3.1] - 2026-03-14

### Added
- Context hints — agents warned when conversation exceeds 50 messages
- Auto-compact — `messages.jsonl` automatically compacted when exceeding 500 lines
- Project auto-discover — dashboard scans sibling directories and suggests projects to add

## [2.3.0] - 2026-03-14

### Added
- `handoff` tool for structured work delegation
- `share_file` tool for sending file contents between agents
- `broadcast` tool for messaging all agents at once
- `get_summary` tool for conversation recaps
- Server-Sent Events for real-time dashboard updates
- `fs.watch()` on data directory with debounced SSE push
- Graceful SSE fallback to polling
- Handoff message rendering (purple banner)
- File share message rendering (file icon + size)

## [2.2.0] - 2026-03-14

### Added
- Agent templates — 4 built-in conversation starters (pair, team, review, debate)
- Conversation summary tool (`get_summary`) for generating recaps
- Auto-archive — conversations archived automatically before reset
- Dashboard: "New Conversation" flow

## [2.1.0] - 2026-03-14

### Added
- Multi-agent support (any name, not just A/B)
- `list_agents` tool with alive/dead status
- `listen` tool (blocks indefinitely, never times out)
- Conversation threading (`reply_to` + auto `thread_id`)
- Message acknowledgments (`ack_message` tool)
- Heartbeat system (10s interval, `last_activity` tracking)
- Agent status: active/sleeping/dead with idle time
- Listening status tracking (`listening_since`)
- Auto-compact messages.jsonl when >500 lines
- Auto-archive conversations before reset
- Context hints when conversation exceeds 50 messages
- Dead recipient warnings in `send_message`
- Message sequence numbers for ordering
- `pending_count` and `agents_online` in delivery responses
- 4 agent templates: pair, team, review, debate
- CLI: `npx neohive templates` command
- CLI: `--template` flag for guided setup
- Multi-CLI support: Claude Code, Gemini CLI, Codex CLI
- `NEOHIVE_DATA_DIR` env var in MCP config

### Fixed
- Heartbeat timer `.unref()` to prevent zombie processes
- Process exit cleanup (deregister agent on exit)
- Re-registration cleanup (old name removed)
- Stale byte offset recovery on file truncation

## [2.0.0] - 2026-03-14

### Added
- Initial release
- MCP server with stdio transport
- 6 tools: register, send_message, wait_for_reply, check_messages, get_history, reset
- Web dashboard with real-time monitoring
- Message injection from dashboard
- Dark theme UI with markdown rendering
- `.mcp.json` project-level configuration
