---
title: Safe Message Delivery and Coalesced Wake Signals — Epic Breakdown
status: final
stepsCompleted:
  - step-01-validate-prerequisites
  - step-02-design-epics
  - step-03-create-stories
  - step-04-final-validation
inputDocuments:
  - _bmad-output/planning-artifacts/prds/prd-safe-message-wake-delivery-2026-07-18/prd.md
  - _bmad-output/planning-artifacts/architecture-safe-message-wake-delivery-2026-07-18/ARCHITECTURE-SPINE.md
---

# agent-bridge - Epic Breakdown

## Overview

This document decomposes the safe-message delivery PRD and architecture spine
into implementable stories. The slice is internal-tool scale and has no UX
design contract.

## Requirements Inventory

### Functional Requirements

- **FR-1:** Append every accepted direct message to the recipient-visible store
  regardless of tmux mapping or wake outcome.
- **FR-2:** Route accepted dashboard direct injections through the same
  recipient-visible store and make them retrievable through `listen()`.
- **FR-3:** Store informational watchdog and automatic nudge content under the
  same message semantics.
- **FR-4:** Preserve one history record per message without wake-induced
  duplicates.
- **FR-5:** Preserve group, channel, broadcast, managed-responder, and non-tmux
  queue behavior without a new message schema.
- **FR-6:** Request a wake only after content has a durable queue path.
- **FR-7:** Use one fixed minimal wake meaning only “messages are pending; call
  `listen()`.”
- **FR-8:** Exclude all sender-, message-, task-, and watchdog-derived content
  from the wake payload.
- **FR-9:** Use one shared wake policy for agent messages, dashboard inject, and
  watchdog callers.
- **FR-10:** Preserve `attemptTmuxDelivery` and `sendKeysToPane` compatibility
  through adapters while closing arbitrary payload injection.
- **FR-11:** Wake only a live, verified tmux mapping that passes the shared
  conservative live safety gate.
- **FR-12:** Do not terminal-wake an agent blocked in `listen()`.
- **FR-13:** Send no terminal input to busy, permission-blocked, stale, unmapped,
  unverifiable, or otherwise uncertain panes.
- **FR-14:** Keep non-tmux recipients queue-only.
- **FR-15:** Expose useful wake outcome separately from authoritative queue
  success.
- **FR-16:** Keep recipient-scoped state that permits at most one pending wake.
- **FR-17:** Coalesce repeated direct, dashboard, and watchdog wake requests
  while a wake is pending.
- **FR-18:** Clear pending wake state at an acknowledgement point that safely
  permits a later wake.
- **FR-19:** Make coalescing safe across server and dashboard processes and fail
  closed without suppressing content storage.
- **FR-20:** Keep wake metadata additive and avoid breaking existing message or
  agent data.
- **FR-21:** Return success to `send_message` when queueing succeeds regardless
  of optional wake outcome.
- **FR-22:** Preserve `/api/inject` request shape and add only backward-compatible
  queue/wake status.
- **FR-23:** Route watchdog callers through the shared queue-and-wake policy.
- **FR-24:** Keep dashboard and agent status readers compatible with absent wake
  metadata and older state.

### NonFunctional Requirements

- **NFR-1 — Zero content injection:** No message-derived value can reach tmux
  `send-keys` on any delivery path.
- **NFR-2 — Provider agnosticism:** Correct delivery is independent of Cursor,
  Claude, Codex, tmux, and provider-specific pane rendering.
- **NFR-3 — Idempotence:** Repeated requests while a wake is pending have the
  terminal effect of one request.
- **NFR-4 — Fail-safe behavior:** Missing, stale, malformed, or contended wake
  state degrades to queue-only.
- **NFR-5 — Backward compatibility:** Existing APIs, functions, on-disk
  messages, dashboard callers, watchdogs, and clients require no coordinated
  migration.
- **NFR-6 — Healthy-agent quietness:** Listening, working, or content-free agents
  are not spuriously woken.
- **NFR-7 — Concurrency:** Concurrent producers neither bypass coalescing nor
  lose queued content.
- **NFR-8 — Observability:** Queue success and sent, suppressed, coalesced, or
  failed wake outcomes are distinguishable without logging content as input.
- **NFR-9 — Focused verification:** Unit and entry-point integration tests do
  not require restarting the dashboard.

### Additional Requirements

- Adopt a queue-first, advisory-wake paradigm: queue failure is delivery failure;
  wake failure is not.
- Introduce one shared direct-delivery boundary for `send_message`, dashboard
  `/api/inject`, and direct system/watchdog messages.
- Make the wake payload a module-owned constant; legacy caller payload arguments
  are ignored and cannot cross the tmux boundary.
- Require positive live evidence: live recipient, mapped pane, no
  `listening_since`, verified PID-to-pane mapping, and affirmative live safety
  check.
- Store recipient wake claims in an additive project-local file and claim them
  atomically under the existing file-lock convention so server and dashboard
  processes coalesce together.
- Leave successful claims pending until the recipient begins `listen()`; release
  only a matching claim on definite send failure; clear obsolete claims on new
  session identity.
- Do not re-arm successful claims by time alone because an earlier wake may still
  be buffered.
- Preserve existing response/request shapes and add reason-coded wake metadata
  without message content.

### UX Design Requirements

None. Dashboard UX changes beyond backward-compatible delivery/wake metadata are
out of scope.

### FR Coverage Map

- **FR-1–FR-5:** Epic 1 — authoritative queue and history delivery across
  existing recipient types.
- **FR-6–FR-10:** Epic 1 — fixed content-free wake contract and unified caller
  policy.
- **FR-11–FR-15:** Epic 1 — conservative wake safety and independent wake
  outcomes.
- **FR-16–FR-20:** Epic 1 — recipient-scoped, cross-process wake coalescing and
  acknowledgement.
- **FR-21–FR-24:** Epic 1 — backward-compatible API, dashboard, watchdog, and
  status behavior.

## Epic List

### Epic 1: Reliable Queued Messaging with Safe Coalesced Wake

Recipient agents receive one authoritative stored message stream through
`listen()`, while safely idle tmux agents may receive at most one fixed,
content-free wake. Busy or uncertain agents receive no pane input, and all
existing send, dashboard, watchdog, provider, and non-tmux entry points remain
compatible.

**FRs covered:** FR-1–FR-24.

**Dependency:** Existing message store, `listen()` lifecycle, file-lock helper,
and tmux mapping/safety checks.

**Implementation note:** This is one end-to-end epic because queueing, wake
policy, coalescing, and caller migration share the same core delivery boundary.
Its stories are ordered so each leaves the system in a testable, non-regressed
state without depending on a future epic.

## Epic 1: Reliable Queued Messaging with Safe Coalesced Wake

Recipient agents receive one authoritative stored message stream through
`listen()`, while safely idle tmux agents may receive at most one fixed,
content-free wake. Busy or uncertain agents receive no pane input, and all
existing entry points remain compatible.

### Story 1.1: Queue Agent Messages Before One Safe Wake

As a recipient agent,
I want direct agent messages stored before any optional terminal wake,
So that I can retrieve every accepted message through `listen()` without raw
payloads entering my CLI input queue.

**Requirements:** FR-1, FR-4, FR-6–FR-21, FR-24; NFR-1–NFR-8.

**Acceptance Criteria:**

**Given** a direct `send_message` accepted for a registered recipient
**When** the shared direct-delivery policy runs
**Then** it appends the message exactly once to the recipient-visible message
store and exactly once to history before evaluating any wake
**And** queue failure is reported as delivery failure while wake failure does
not reverse queue success.

**Given** a recipient pane that is busy, blocked in `listen()`, a permission
prompt, stale, unmapped, non-tmux, managed-responder, or unverifiable
**When** a direct message is accepted
**Then** the pane receives zero keystrokes
**And** the complete message remains retrievable through `listen()`.

**Given** a live recipient with a verified mapping, no active
`listening_since`, and an affirmative live pane-safety result
**When** a direct message is queued
**Then** the only text passed to tmux is the fixed module-owned instruction
meaning “messages are pending; call `listen()`”
**And** no sender, message, task, reply instruction, or other caller-controlled
text reaches `send-keys`.

**Given** two or more concurrent or repeated messages for one recipient
**When** wake requests race across Neohive processes
**Then** an atomic recipient-scoped claim permits at most one successful
pending wake
**And** every accepted message is still independently queued.

**Given** a successful pending wake claim
**When** that recipient begins `listen()`
**Then** the matching claim is cleared before queued-content checks
**And** a later genuinely new message may request a new wake.

**Given** a claimed wake whose tmux send definitely fails
**When** the failure is handled
**Then** only the matching claim is released
**And** the already queued message remains successful and retrievable.

**Given** existing code calls
`attemptTmuxDelivery(dataDir, recipient, legacyPayload)`
**When** the compatibility adapter executes
**Then** the call remains source-compatible but ignores `legacyPayload`
**And** focused tests prove arbitrary values cannot cross the fixed-wake
boundary.

### Story 1.2: Queue Dashboard Injects Through the Shared Wake Policy

As a dashboard operator,
I want accepted direct `/api/inject` messages stored before any optional wake,
So that dashboard messages and nudges cannot corrupt an agent's CLI input queue.

**Requirements:** FR-2, FR-4–FR-22, FR-24; NFR-1–NFR-9.

**Acceptance Criteria:**

**Given** an existing valid direct `/api/inject` request
**When** the dashboard accepts it
**Then** the request shape and validation contract remain unchanged
**And** the message is appended exactly once to the recipient-visible store and
exactly once to history before any wake request.

**Given** an accepted dashboard inject targets a busy, listening, unsafe, stale,
unmapped, managed-responder, or non-tmux recipient
**When** delivery runs
**Then** the target pane receives zero keystrokes
**And** the complete dashboard-supplied content is retrievable through
`listen()`.

**Given** a dashboard inject targets a positively verified wakeable pane
**When** the shared wake policy runs
**Then** only the fixed content-free wake may be sent
**And** neither `body.content`, `body.from`, nor a generated reply instruction
can reach the tmux sender.

**Given** repeated dashboard nudges or a mix of dashboard and agent messages for
one recipient
**When** a wake claim is already pending
**Then** all later wake requests are coalesced across dashboard and server
processes
**And** at most one wake remains pending while every accepted message is queued.

**Given** an accepted inject succeeds in queueing
**When** the endpoint builds its response
**Then** existing success and message-id fields remain compatible
**And** additive metadata distinguishes authoritative queue delivery from
`sent`, `coalesced`, `suppressed`, or `failed` wake status.

**Given** broadcast injects, managed responders, and existing dashboard status
readers
**When** the change is exercised with absent legacy wake metadata
**Then** their existing behavior remains compatible
**And** focused API tests validate the behavior without restarting the running
dashboard.

### Story 1.3: Route System and Watchdog Nudges Through Safe Delivery

As a coordinated agent,
I want direct system and watchdog nudges to use the same stored-message and
coalesced-wake path,
So that automatic reminders cannot stack raw prompts or bypass message delivery
guarantees.

**Requirements:** FR-3–FR-24; NFR-1–NFR-9.

**Acceptance Criteria:**

**Given** a watchdog or other direct informational system message for an agent
**When** it is accepted for delivery
**Then** its content is appended exactly once to the recipient-visible store and
history through the shared direct-delivery boundary
**And** the content is retrievable through `listen()`.

**Given** watchdog soft and hard nudge paths request attention
**When** the recipient is busy, listening, unsafe, unmapped, non-tmux, or
unverifiable
**Then** watchdog code sends no terminal input
**And** no watchdog-derived text can reach tmux `send-keys`.

**Given** repeated watchdog nudges or a mix of watchdog, dashboard, and agent
messages for one recipient
**When** the recipient already has a pending wake claim
**Then** the later requests produce no additional queued wake
**And** all accepted informational content remains independently retrievable.

**Given** a healthy agent is blocked in `listen()`, actively working, or has no
newly queued content
**When** compliance and watchdog checks run
**Then** the agent is not spuriously terminal-woken
**And** existing queue, liveness, reputation, and reassignment behavior remains
compatible.

**Given** wake state or wake metadata is absent, older, malformed, or contended
**When** direct delivery runs
**Then** it fails closed to queue-only without a schema migration or content
loss
**And** observability uses content-free reason codes for queued, sent,
coalesced, suppressed, and failed outcomes.

**Given** the completed epic
**When** focused regression suites run
**Then** they cover agent-to-agent `send_message`, dashboard `/api/inject`,
direct system/watchdog messages, active `listen()`, tmux and non-tmux recipients,
concurrent wake requests, and absent legacy metadata
**And** they prove the provider-agnostic invariants “a busy pane never receives
message content,” “repeated nudges produce at most one queued wake,” and
“content is always retrievable via `listen()`” without restarting the dashboard.

<!-- Related Task: task_mrq79g5n45a7ac5c2723 -->

<!-- Related Task: task_mrq7bvy28cfb81d58323 -->

<!-- Related Task: task_mrq7coh70dc4fa1e3fdb -->
