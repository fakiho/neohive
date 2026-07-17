# Reliability Contract & Acceptance Matrix — agent-bridge

_Produced by QualityLead as workflow step 1. Gates all implementation in the reliability sprint._
_Rev 5: withFileLock fail-open gap documented in I-4; I-7/I-8 replaced with explicit session-epoch/fencing invariant I-7; AC-13/AC-14 added._

---

## 1. Scope

This contract covers the shared-filesystem state layer of `agent-bridge`. The write paths exist in **both** the library modules and in `server.js` directly — both are in scope.

| Path | Role |
|------|------|
| `server.js` | MCP server — contains its own `saveAgents` (line 406), `appendFileSync` calls (lines 227, 228, 253, 255, 805), and direct `writeFileSync` for profiles, workflows, branches, workspaces, read-receipts |
| `lib/file-io.js` | JSON read/write helpers, advisory file-locking |
| `lib/agents.js` | Agent registration, heartbeat, profile writes (may duplicate server.js paths) |
| `lib/messaging.js` | JSONL append helpers |
| `lib/state.js` | In-process state helpers |
| `.neohive/` | Shared data directory (multi-process, single host) |

Out of scope for this sprint: network transport, MCP protocol correctness, dashboard HTTP layer.

---

## 2. Invariants (must hold at all times)

### I-1 — No silent data loss on crash (JSON files)
A process crash at any point during a write to a JSON file must not silently discard committed data. Either the old value or the new value must survive; a partial/corrupt file is a violation.

**Violated in:**
- `server.js:409` — `saveAgents` calls `fs.writeFileSync(AGENTS_FILE, data)` directly (no temp-and-rename)
- `server.js:782` — compaction writes `writeFileSync(tmpFile, newContent)` then renames, but `tmpFile` is not unique per-process (could collide under concurrent compaction)
- `server.js:862, 962, 980, 995, 1231` — profiles, workspaces, workflows, branches, read-receipts all use direct `writeFileSync`
- `lib/file-io.js:82` — `writeJsonFile` writes directly to target, no atomic rename

**Required fix:** write to `<target>.<pid>.tmp` in the same directory, then `fs.renameSync` to target. `rename(2)` is atomic on POSIX same-filesystem. This guards against OS crash (power-loss durability requires `fsync` before rename; out of scope for this sprint — documented as known gap).

### I-2 — `agents.json` is always valid JSON after any write
A corrupt `agents.json` prevents all agent registration on next start.

**Violated in:** `server.js:409` (same direct write as I-1). Additionally, `server.js:1730` reads `agents.json` with `JSON.parse` + no try/catch — a corrupt file crashes the process.

### I-3 — JSONL files contain only complete lines (cross-process)
Every line in `messages.jsonl`, `history.jsonl`, and branch-specific variants must be a complete, parseable JSON object. Incomplete lines are silently dropped by readers.

**Violated in:**
- `server.js:227, 228, 253, 255, 805` — `appendFileSync` calls with no inter-process lock
- `lib/messaging.js:52, 75, 163` — same pattern
- `tools/tasks.js:296, 297` — workflow handoff message appended to `messages.jsonl` and `history.jsonl` without any inter-process lock

**Note on O_APPEND atomicity:** POSIX guarantees that `write(2)` with `O_APPEND` on a regular file positions the offset and writes atomically at the kernel level — but only within the boundary of a single `write(2)` syscall. Node's `appendFileSync` with a string argument may emit one or more `write(2)` calls depending on the buffer size and kernel; there is no POSIX guarantee the entire JSON line lands in a single syscall. (The `PIPE_BUF` atomicity guarantee applies only to pipes and FIFOs, not regular files.) On Linux ext4/xfs the underlying `write` for small strings typically does complete atomically in practice, but this is a filesystem implementation detail, not a POSIX contract. The safe guarantee requires an inter-process file lock or serialization through a single file descriptor.

**Required fix:** wrap every `appendFileSync` in `withFileLock` on a per-file lock, or adopt a dedicated lock file per JSONL file. A process-local queue does not protect against concurrent writes from other server processes.

### I-4 — Lock acquisition is always paired with release; lock must be fail-closed
Any code path that acquires a file lock must release it in all exit paths, including exceptions. Additionally, if lock acquisition fails (e.g. another process wins the unlink/re-create race), the protected mutation must **not** run — the lock must be fail-closed, never fail-open.

**Partially violated:** `withFileLock` (`lib/file-io.js:152`) has a fail-open path: after the stale-lock break, if the `writeFileSync(lockPath, ..., { flag: 'wx' })` reacquisition throws (another process wins the `wx` race), the code falls through to `return fn()` — executing the mutation without owning the lock. This means two processes can enter the critical section simultaneously if both detect a stale lock and race on reacquisition.

**Required fix:** if reacquisition throws, `withFileLock` must return `null` (or throw), not call `fn()`. The mutation must only run when `process.pid` owns the lock file.

**Separate risk:** `server.js:409` (`saveAgents`) is called at line 1508 outside any lock block. If a second agent is registered concurrently, the write races with the locked `registerAgent` path.

### I-5 — Stale lock force-break requires dead-PID confirmation
A lock must not be force-broken unless the owning PID is confirmed dead.

**Partially met:** `withFileLock` (`lib/file-io.js:146-152`) checks PID liveness before breaking. `lockAgentsFile` (`lib/file-io.js:113`) force-breaks on timeout alone without PID check — gap under high-load scenarios.

### I-6 — Heartbeat writes do not block the event loop detectably
`touchHeartbeat` is called on a recurring timer. Its `writeFileSync` is synchronous and will block the Node.js event loop for the duration of the syscall. While exceptions are swallowed, a slow disk or NFS mount will stall the entire process during every heartbeat tick.

**Current state:** Exceptions swallowed silently — no log, no metric. Blocking is real but typically sub-millisecond on local SSD. On slow mounts it becomes a latency hazard.

**Required:** Log at `debug` level on error. Document the blocking nature as a known architectural constraint; async migration is a follow-on task.

### I-7 — Session-epoch fencing: stale-owner operations are rejected
Every agent registration establishes a **session epoch**: a monotonically advancing token (currently the agent's `registered_at` timestamp recorded in `agents.json`) that identifies the live owner of a given agent name. After ownership transfers (re-registration, crash-and-restart, or unregister+register), any operation — `send_message`, `update_task`, `listen` — carrying an implicit or explicit reference to the prior epoch must be rejected with a structured error, not silently executed or dropped.

**Current state:** There is no fencing mechanism. A stale process (crashed but not yet reaped, or a zombie that regained network access) that calls `send_message` after its name has been re-registered by a new process will succeed — its messages will appear in `messages.jsonl` interleaved with the new owner's, with no way to distinguish them.

**Required:** Assign a per-registration epoch token (UUID or monotonic counter stored in `agents.json` per agent). MCP handlers that mutate shared state must verify the caller's epoch matches the current registered epoch for that agent name. If not, return a structured `{ error: 'stale_session', ... }` response.

**Delivery durability note:** `appendFileSync` on disk-full or permission error propagates an uncaught exception; the MCP handler does not catch it, so the caller receives an unstructured crash rather than a structured error. This is addressed by fix pattern 5 and AC-12.

**Startup integrity note:** `server.js:384-386` returns `{}` on `existsSync` failure but line 1730 has no equivalent guard for a corrupt file — a corrupt `agents.json` causes a process crash rather than clean reinitialisation. Addressed by fix pattern 4 and AC-10.

---

## 3. Acceptance Matrix

Each row is a test scenario. Implementation is accepted only when all PASS criteria are observable.

| ID | Scenario | How to trigger | PASS criterion | FAIL criterion |
|----|----------|---------------|----------------|----------------|
| AC-1 | Crash between temp write and rename (atomic write path) | After the fix is applied: use `strace -e inject=rename:error=EIO` or a deterministic fault-injection wrapper that calls `process.kill(process.pid, 'SIGKILL')` immediately after the `writeFileSync(tmp)` call and before `renameSync`. **Do not use `setTimeout(process.exit, 0)` — `writeFileSync` is synchronous and the event loop cannot fire during it, so the timer fires after the write, not during.** | Target file contains either the old valid JSON or the new valid JSON on next start; the `.tmp` file (if present) is safely ignored | Target file is corrupt / zero bytes / invalid JSON |
| AC-2 | Two processes register simultaneously | Run `scripts/test-registration-race.js` with 2+ processes pointing at the same `.neohive/` dir | Both agents appear in `agents.json`; no entry lost or corrupt | One entry missing, or file is corrupt JSON |
| AC-3 | Two processes append a message at the same instant | Spawn 2 server processes on the same data dir, both call `send_message` concurrently | (a) Every line in `messages.jsonl` is independently parseable via `JSON.parse`; (b) line count increases by exactly 2 (record `wc -l` before and confirm `+2` after) | Any line is a byte-interleaved fragment of two messages, or line count is not exactly +2 |
| AC-4 | Server crashes while holding agents lock | Inject `process.exit()` inside `lockAgentsFile` critical section | Next server process acquires lock within 5 s (stale-lock break) and `agents.json` is valid | Next process hangs indefinitely or reads corrupt file |
| AC-5 | Disk full during JSONL append | Mount a loopback device filled to capacity; trigger `send_message` | MCP returns a structured error to the caller; no partial line in `messages.jsonl`. Verify: `{ while IFS= read -r line; do printf '%s\n' "$line"; done; [[ -n "$line" ]] && printf '%s\n' "$line"; } < .neohive/messages.jsonl \| while IFS= read -r line; do echo "$line" \| jq . >/dev/null \|\| echo "BAD: $line"; done` (the `[[ -n "$line" ]]` branch catches a final unterminated line that the plain `read` loop would silently miss) | Process crashes uncaught, or any line (including a final unterminated fragment) fails `jq .` |
| AC-6 | EACCES on the data directory during atomic write | After the fix is applied (temp+rename): make the **containing directory** non-writable (`chmod 000 .neohive/`) before triggering a `register` call, so that `openSync(<target>.<pid>.tmp, 'w')` fails with EACCES. (Chmod-ing only the target file tests the old direct-write path, not temp creation or rename.) | MCP returns a structured error; server process does not crash | Uncaught exception / process exit |
| AC-7 | `messages.jsonl` offset regression on file shrink | Simulate compaction (truncate file to shorter content) while an agent is reading | `readNewMessagesFromFile` returns `{ messages:[], newOffset:0 }` without throwing; next read recovers correctly | Negative offset, process crash, or silent duplicate delivery |
| AC-8 | `lockAgentsFile` PID-check before force-break | Lock file owner PID is alive but slow (add `Atomics.wait` or `sleep` in critical section) | Lock is NOT force-broken while owner PID is alive; breaks only after PID exits | Lock broken while owner PID is still running |
| AC-9 | Concurrent profile writes from two agents | Two agents call `update_profile` simultaneously (server.js:962 path) | Both profiles present and valid in `profiles.json` | One profile overwritten, or file is corrupt JSON |
| AC-10 | Cold start on corrupt `agents.json` | Write `{broken` to `agents.json`, start server | Server starts, logs a warning, initialises with empty agents state | Server crashes on startup with unhandled JSON parse exception |
| AC-11 | Atomic temp file name collision | Two server processes compact simultaneously | Each uses a unique temp path (`<file>.<pid>.tmp`); no collision, final file is valid | Processes overwrite each other's temp file, producing corrupt output |
| AC-12 | Disk-full delivery error is surfaced, not swallowed | Same disk-full setup as AC-5, targeting `send_message` | Caller receives a structured MCP error response with a human-readable message; no unhandled exception propagates | `send_message` returns no response or the process crashes |
| AC-13 | `withFileLock` is fail-closed on reacquisition race | Two processes simultaneously detect a stale lock and race on `writeFileSync(lockPath, ..., { flag: 'wx' })` reacquisition; simulate by having a test stub throw on the reacquisition `writeFileSync` | The process that loses the race returns `null` (or throws); its `fn()` is **not** called; only the winner executes the mutation | Both processes execute `fn()` concurrently (confirmed by observing two simultaneous entries in a shared file) |
| AC-14 | Stale-session write is rejected after re-registration | Register agent "A", record its epoch token. Kill process A. Re-register "A" in a new process (new epoch). Then replay a `send_message` call from the old process (old epoch) | Server returns `{ error: 'stale_session', ... }`; the stale message does not appear in `messages.jsonl` | Stale message is written to `messages.jsonl` and delivered to recipients |

---

## 4. Key files and line references

| File | Lines | Gap |
|------|-------|-----|
| `server.js` | 409 | `saveAgents` — direct `writeFileSync`, no temp+rename, no lock at call site |
| `server.js` | 227, 228, 253, 255, 805 | `appendFileSync` — no inter-process lock |
| `server.js` | 782 | Compaction temp file — not process-unique, collides under concurrent compaction |
| `server.js` | 862, 962, 980, 995, 1231 | Direct `writeFileSync` for profiles, read-receipts, workspaces, workflows, branches |
| `server.js` | 1730 | `JSON.parse(readFileSync(...))` with no try/catch — crash on corrupt file |
| `lib/file-io.js` | 82 | `writeJsonFile` — direct write, no atomic rename |
| `lib/file-io.js` | 113 | `lockAgentsFile` force-break — no PID liveness check |
| `lib/file-io.js` | 152 | `withFileLock` reacquisition — fail-open: calls `fn()` if `wx` create throws after stale-lock break |
| `lib/agents.js` | 75 | `saveAgents` (lib copy) — direct `writeFileSync`, no lock |
| `lib/agents.js` | 100 | `touchHeartbeat` — synchronous `writeFileSync`, swallows errors silently, no log |
| `lib/agents.js` | 119 | `saveProfiles` — direct `writeFileSync`, no atomic rename (called inside `withFileLock`, so write contention is guarded, but crash-safety is not) |
| `lib/messaging.js` | 52, 75, 163 | `appendFileSync` — no inter-process lock |
| `tools/tasks.js` | 296, 297 | Workflow handoff `appendFileSync` — no inter-process lock |

---

## 5. Recommended fix patterns

1. **Atomic write** (`server.js`, `lib/file-io.js`): write to `<target>.<pid>.tmp` in the same directory, then `fs.renameSync(tmp, target)`. Ensures unique temp names per process (AC-11). `rename(2)` is atomic on POSIX; power-loss durability (`fsync` before rename) is documented as a known gap, not required this sprint.

2. **Inter-process JSONL append guard** (`server.js`, `lib/messaging.js`): wrap every `appendFileSync` in `withFileLock` on a per-file lock, or adopt a dedicated lock file per JSONL file. A process-local queue does not protect against concurrent writes from other server processes.

3. **PID check in `lockAgentsFile`** (`lib/file-io.js:113`): before force-breaking, confirm the lock file's stored PID is dead, mirroring the existing logic in `withFileLock` (lines 146-152).

4. **Startup integrity check** (`server.js` init path): wrap `JSON.parse(readFileSync(AGENTS_FILE))` in try/catch; log and reinitialise from heartbeat files if corrupt (addresses AC-10 and line 1730).

5. **Disk-full / EACCES handling**: wrap all `appendFileSync` / `writeFileSync` calls in try/catch; surface as MCP structured error, not uncaught exception (addresses I-7, AC-5, AC-12).

6. **Heartbeat log**: in `touchHeartbeat` catch block, add `log.debug('heartbeat write failed:', e.message)` so silent failures become observable without disrupting the timer loop.

---

_This document is the gate artifact for the reliability sprint. Implementation PRs must reference specific AC-IDs in their test plans._
