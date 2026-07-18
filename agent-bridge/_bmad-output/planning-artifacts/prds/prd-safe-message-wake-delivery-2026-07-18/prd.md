---
title: Safe Message Delivery and Coalesced Agent Wake Signals
status: final
created: 2026-07-18
updated: 2026-07-18
project: agent-bridge
---

# PRD: Safe Message Delivery and Coalesced Agent Wake Signals

## 1. Purpose

This PRD defines an internal reliability fix for Neohive message delivery. Message
content must remain in Neohive's durable message path and be consumed through
`listen()`. Terminal injection may only wake an agent when it is safe to do so; it
must never carry message content.

The change covers agent-to-agent `send_message`, dashboard `/api/inject`, watchdog
nudges, and the shared tmux delivery helpers. It is intentionally limited to
decoupling content from wake-up, coalescing wake attempts, and failing safely to
queue-only delivery. More sophisticated provider-specific idle detection is not
part of the MVP.

## 2. Problem

Neohive currently attempts to reach a tmux-mapped recipient by typing the full
message payload into the recipient's pane. The current safety heuristic can reject
obviously unsafe panes, but it cannot reliably distinguish an agent that is idle at
its prompt from one that is busy mid-turn.

Cursor and Claude buffer terminal input received while busy. Repeated messages or
watchdog nudges therefore accumulate as raw prompts. When the active turn ends,
those prompts are submitted as new user turns before or around the agent's next
`listen()` call. The result is duplicate work, confused context, cross-pane pileups,
and a violation of Neohive's message-store semantics.

The underlying failure is coupling two separate concerns:

1. **Content delivery:** reliable storage and retrieval of the actual message.
2. **Wake-up:** a best-effort hint that an idle agent should call `listen()`.

Pane-state inference is not reliable enough to make terminal input the content
transport. It may still be used conservatively for a minimal wake signal.

## 3. Goals and Non-Goals

### 3.1 Goals

- Make the Neohive message store the single delivery path for all message content.
- Ensure every accepted message is retrievable by its recipient through `listen()`.
- Reserve tmux terminal input for one fixed, content-free wake instruction.
- Emit a wake only when the recipient is conservatively judged idle and wakeable.
- Coalesce repeated wake requests so pending work cannot stack terminal prompts.
- Preserve existing callers and public behavior without a schema-breaking change.
- Work consistently for Cursor, Claude, Codex, tmux, and non-tmux agents.

### 3.2 Non-Goals

- Perfectly infer every provider's prompt, generation, permission, or tool-wait state.
- Guarantee immediate attention from an agent that is busy, disconnected, or not
  safely wakeable.
- Replace `listen()` or the Neohive message store with terminal transport.
- Redesign message schemas, consumed offsets, history retention, or agent lifecycle.
- Restart the running dashboard as part of delivery.

## 4. Users and Stakeholders

- **Recipient agents** need one authoritative stream of messages without synthetic
  user turns being inserted into their CLI.
- **Sending agents and coordinators** need accepted messages to remain available
  until the recipient listens.
- **Human dashboard operators** need `/api/inject` to retain its existing contract
  while no longer risking terminal-input corruption.
- **Neohive maintainers** need one shared policy for send, inject, and watchdog paths
  rather than caller-specific delivery behavior.

## 5. Product Invariants

1. Message content is written to the Neohive message store before or independently
   of any wake attempt.
2. No message content, sender identity, task text, nudge text, or user-provided data
   is ever passed to tmux `send-keys`.
3. A wake is advisory. Failure or suppression of a wake never removes, consumes, or
   invalidates the queued message.
4. At most one wake may be pending for a recipient at a time.
5. Uncertain pane state resolves to no wake, never speculative injection.
6. `listen()` remains the only supported path by which an agent receives content.

## 6. Functional Requirements

### 6.1 Authoritative Queue Delivery

- **FR-1:** Every accepted direct message shall be appended to the recipient-visible
  Neohive message store regardless of tmux mapping or wake outcome.
- **FR-2:** Every accepted dashboard-injected direct message shall use the same
  recipient-visible store and remain retrievable through `listen()`.
- **FR-3:** Watchdog and automatic nudge content shall use the same message-store
  semantics as other messages when they carry information for the recipient.
- **FR-4:** Message history behavior shall remain compatible with current callers,
  without duplicate history records caused by a wake attempt.
- **FR-5:** Existing group, channel, broadcast, managed-responder, and non-tmux queue
  delivery shall continue to work without requiring a new message schema.

### 6.2 Wake Signal Contract

- **FR-6:** Neohive may request a wake only after content has a durable queue path.
- **FR-7:** The tmux wake payload shall be a fixed, minimal instruction whose meaning
  is only “messages are pending; call `listen()`.”
- **FR-8:** The wake payload shall contain no sender-controlled, message-derived,
  task-derived, or watchdog-derived content.
- **FR-9:** All tmux wake attempts shall use one shared delivery policy and helper
  contract across `send_message`, dashboard `/api/inject`, and watchdog callers.
- **FR-10:** Existing `attemptTmuxDelivery` and `sendKeysToPane` callers shall remain
  source-compatible or receive a backward-compatible adapter; no caller may retain
  a route that injects arbitrary payload content.

### 6.3 Conservative Wake Safety

- **FR-11:** A wake shall be attempted only for a live, verified tmux mapping whose
  current state passes the shared conservative wake-safety gate.
- **FR-12:** An agent blocked in a live `listen()` call shall not receive a terminal
  wake because the stored message already wakes or is returned by `listen()`.
- **FR-13:** A pane that is busy, at a permission prompt, stale, unmapped, unverifiable,
  or otherwise uncertain shall receive no terminal input.
- **FR-14:** A non-tmux recipient shall use queue-only delivery.
- **FR-15:** Wake failure shall be reported as a wake outcome where useful for
  observability, but shall not turn a successfully queued message into a delivery
  failure.

### 6.4 Wake Coalescing

- **FR-16:** Neohive shall maintain recipient-scoped wake state sufficient to prevent
  more than one pending wake from being queued for the same agent.
- **FR-17:** Repeated direct messages, dashboard nudges, or watchdog nudges received
  while a wake is pending shall not emit additional terminal wake prompts.
- **FR-18:** The pending-wake state shall clear at a lifecycle point that permits a
  later genuinely new wake without allowing the previous wake to stack.
- **FR-19:** Coalescing shall be safe across the relevant server/dashboard call paths
  and shall fail closed: uncertain state suppresses an extra wake but never suppresses
  message storage.
- **FR-20:** Wake coalescing metadata shall be additive and shall not require a
  breaking change to existing message or agent data.

### 6.5 Compatibility and Responses

- **FR-21:** Existing agent-to-agent `send_message` callers shall continue receiving
  a successful result when their message is queued, independent of wake outcome.
- **FR-22:** Dashboard `/api/inject` shall preserve its accepted request shape and
  distinguish authoritative queue delivery from optional wake status without
  breaking existing consumers.
- **FR-23:** Existing watchdog callers shall route through the shared queue-and-wake
  policy rather than constructing terminal payloads independently.
- **FR-24:** Existing dashboard and agent status views shall continue to function
  with absent wake metadata and older on-disk state.

## 7. Non-Functional Requirements

- **NFR-1 — Zero content injection:** Tests and implementation boundaries shall make
  it impossible for message content to reach tmux `send-keys` on any delivery path.
- **NFR-2 — Provider agnosticism:** Correct content delivery shall not depend on
  Cursor-, Claude-, or Codex-specific pane rendering. Provider heuristics may only
  suppress or permit the optional fixed wake.
- **NFR-3 — Idempotence:** Repeating the same wake request while one is pending shall
  have the same externally visible terminal effect as one request.
- **NFR-4 — Fail-safe behavior:** Missing, stale, malformed, or contended wake state
  shall degrade to queue-only delivery.
- **NFR-5 — Backward compatibility:** Existing APIs, function entry points, on-disk
  message records, dashboard callers, watchdog callers, and agent clients shall not
  require coordinated migration.
- **NFR-6 — Healthy-agent quietness:** Agents already listening, actively working, or
  lacking pending content shall not be spuriously woken.
- **NFR-7 — Concurrency:** Concurrent senders shall not bypass recipient-level wake
  coalescing or lose queued content.
- **NFR-8 — Observability:** Logs or response metadata shall make queue success, wake
  attempted, wake suppressed/coalesced, and wake failed distinguishable without
  logging message content as terminal input.
- **NFR-9 — Focused verification:** Automated tests shall cover the shared policy and
  each compatibility entry point without requiring a live dashboard restart.

## 8. Acceptance Outcomes

The feature is complete when all of the following are demonstrated:

1. A busy pane never receives message content.
2. Repeated nudges produce at most one queued wake for a recipient.
3. Content is always retrievable via `listen()` after an accepted send or inject.
4. An unsafe or unverifiable pane receives no keystrokes and the message remains
   queued.
5. A safely idle pane may receive only the fixed wake instruction.
6. Agents already blocked in `listen()` receive content through the store and are not
   terminal-woken.
7. Existing `send_message`, `/api/inject`, dashboard, watchdog, tmux, and non-tmux
   focused tests remain compatible.

## 9. Success Measures

- Zero test-observed cases where sender-controlled content reaches a pane.
- One or fewer outstanding wake prompts per recipient under burst delivery.
- One retrievable stored record per accepted message, independent of wake outcome.
- No regressions in existing queue delivery and dashboard injection test suites.
- No additional wake for agents with an active `listen()` or a known busy/unsafe pane.

### Counter-metrics

- Messages must not be lost merely to reduce terminal wake volume.
- Queue latency must not be increased by waiting for tmux safety checks.
- Coalescing must not permanently suppress future wakes after the prior pending wake
  has been resolved.

## 10. Risks and Constraints

- Pane safety remains heuristic. The MVP controls this risk by making wake payloads
  fixed and content-free and by treating uncertainty as queue-only delivery.
- A fixed wake is still terminal input. Incorrect pending-state clearing could allow
  repeated wake prompts, so coalescing behavior requires concurrency-focused tests.
- Multiple current entry points contain their own delivery decisions. Leaving any
  legacy direct-injection branch would violate the core invariant; architecture and
  stories must explicitly enumerate and unify them.
- The dashboard process may need a human-controlled restart to run changed code, but
  implementation work must not restart it automatically.

## 11. Delivery Scope

### MVP

- Shared queue-first delivery decision.
- Fixed content-free wake contract.
- Conservative wake-safety gate.
- Recipient-scoped wake coalescing and safe clearing.
- Migration of `send_message`, `/api/inject`, and watchdog/nudge paths.
- Focused unit and integration tests for invariants and compatibility.

### Deferred

- Rich provider adapters that prove idle state more precisely.
- Alternate out-of-band notification transports.
- Persistent wake acknowledgements across unrelated host processes unless MVP
  concurrency evidence shows they are required for correctness.
- Dashboard UX beyond backward-compatible delivery/wake status.

## 12. Open Items for Architecture

These are mechanism decisions, not unresolved product requirements:

- Select the minimal shared queue-and-wake orchestration boundary.
- Define the evidence that establishes “wakeable” for the MVP.
- Choose the recipient-scoped pending-wake representation and atomicity boundary.
- Define when a pending wake is considered drained or eligible to clear.
- Preserve compatibility for legacy helper signatures while preventing arbitrary
  payload injection.
