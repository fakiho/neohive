# Neohive MCP Tools: Comprehensive Review & Documentation

> **Canonical reference:** Full MCP tool parameters are in [reference/tools.md](./reference/tools.md). The documentation hub is [documentation.md](./documentation.md). This file is a **high-level tour** (~70+ built-in tools in `server.js`).

## Overview and Review

This document provides a detailed review and documentation of the **Neohive MCP (Model Context Protocol) Tools** developed in this project. Defined primarily in `agent-bridge/server.js`, this framework exposes an extremely rich set of capabilities designed for complex, autonomous, multi-agent collaboration.

### Analytical Review

1. **Unprecedented Autonomy**: The tools natively support autonomous work loops (e.g., `start_plan`, `get_work`, `verify_and_advance`, `retry_with_improvement`). This allows agents to work proactively rather than just reactively, complete with self-correction mechanisms and confidence scoring.
2. **Robust Collaboration Mechanisms**: Unlike typical AI toolsets that focus on single-agent interactions, Neohive supports complex topologies like `group` and `managed` conversation modes. Features like `handoff`, `yield_floor`, `call_vote`, and `share_file` show a highly mature approach to multi-agent synchronization.
3. **Safety and Governance Built-in**: File locking (`lock_file`), push approvals (`request_push_approval`), rule enforcement (`add_rule`, `log_violation`), and code review systems (`request_review`) indicate a framework designed to safely write code to a real file system where merge conflicts or destructive behavior could occur.
4. **State Management**: Knowledge base (`kb_write`), workspaces (`workspace_write`), and contextual histories (`get_history`, `get_compressed_history`) ensure that context window limits are mitigated, allowing agents to selectively pull information they need (progressive disclosure) instead of flooding their memory.

---

## Tool Categories & Detailed Documentation

### 1. Agent Lifecycle & Messaging

Tools for agent onboarding, communication, and synchronization.

* **`register(name, provider, skills)`**: Essential first step. Registers an agent's identity and returns a collaboration guide.
* **`list_agents()`**: Discovers other registered agents and their status.
* **`send_message(content, to, reply_to, channel, priority)`**: Direct messaging capability (auto-routes if only two agents exist). Supports threads and priorities.
* **`broadcast(content)`**: Sends a message to *all* registered agents simultaneously. Useful for team-wide announcements.
* **`wait_for_reply(timeout_seconds, from)`**: A blocking polling mechanism to await specific responses.
* **`listen(mode?, from?)`**: The primary interaction event loop. Blocks and waits for messages. Use `mode="group"` for multi-agent sessions (batched), `mode="codex"` for Codex CLI (90s cap), or omit to auto-detect.
* **`messages(action, ...)`**: Unified message management. `action="check"` (non-blocking inbox peek), `action="consume"` (extract and mark read), `action="history"` (conversation history), `action="search"` (full-text search), `action="ack"` (acknowledge), `action="notifications"` (non-message events).
* **`share_file(file_path, to, summary)`**: Rapidly shares small file contents (up to 100KB) over the message bus.

### 2. Autonomy & Workflows (Proactive Engine)

Tools driving autonomous operations and structured step-by-step pipelines.

* **`start_plan(name, steps, parallel)`**: Initiates an autonomous plan. Once called, agents fall into a `get_work` loop.
* **`get_work(just_completed, available_skills)`**: Agents call this after task completion to automatically pull their next optimal assignment based on priority and skills.
* **`verify_and_advance(workflow_id, summary, verification, confidence, files_changed, learnings)`**: Self-evaluates completed work. Advances automatically if confidence >= 70, flags if lower, or requests help if < 40.
* **`retry_with_improvement(task_or_step, what_failed, why_it_failed, new_approach, attempt_number)`**: Systematic retry mechanism preventing infinite fail-loops (auto-escalates after 3 fails).
* **`create_workflow(name, steps, autonomous, parallel)`**: Creates complex dependency-graphed task pipelines.
* **`advance_workflow(workflow_id, notes)`**: Manually marks a workflow step done and triggers a handoff.
* **`workflow_status(workflow_id?, action?, checkpoint_index?)`**: Monitors workflow progression; optional `action` / `checkpoint_index` for checkpoint operations (see [reference/tools.md](./reference/tools.md)).

### 3. Task Management

Tools for atomic work item tracking.

* **`create_task(title, description, assignee)`**: Creates discrete standalone tasks.
* **`update_task(task_id, status, notes)`**: Updates state (`pending`, `in_progress`, `done`, `blocked`).
* **`list_tasks(status, assignee)`**: Retrieves tasks based on filters.

### 4. Profiles & Workspaces

Tools mapping agent capabilities and providing dedicated key-value storage.

* **`update_profile(display_name, avatar, bio, role)`**: Visually/identifiably updates agent representation on a UI/Dashboard.
* **`workspace_write(key, content)`**: Agent-specific isolated storage. Read-many, write-one (only the owning agent can write).
* **`workspace_read(key, agent)`**: Fetches content from personal or peer workspaces.
* **`workspace_list(agent)`**: Enumerates workspace keys.

### 5. Chat Branching & Conversation Modes

Tools handling complex timeline management and interaction physics.

* **`fork_conversation(branch_name, from_message_id)`**: Creates a parallel branch of history, allowing alternate exploration without affecting main logic.
* **`switch_branch(branch_name)`**: Moves the agent instance to another branch.
* **`list_branches()`**: Returns existing conversational timelines.
* **`set_conversation_mode(mode)`**: Transitions between `direct`, `group`, and `managed` modes.
* **`claim_manager()` / `yield_floor(to, prompt)` / `set_phase(phase)`**: Tools specific to **managed** mode where a primary agent orchestrates turn-taking (e.g. passing the baton using "round-robin").

### 6. Sub-channels

Tools for isolating team chatter.

* **`join_channel(name, description, rate_limit)`**: Subscribes to or spawns a topic-specific comms channel.
* **`leave_channel(name)`**: Unsubscribes from channel noise.
* **`list_channels()`**: Views active channels.

### 7. File Safety & Auditing

Tools preventing race conditions and ensuring adherence to policies.

* **`lock_file(file_path)`**: Claims exclusive rights to modify a code file.
* **`unlock_file(file_path)`**: Releases file lock.
* **`log_violation(type, details)`**: Submits an event to the audit trail (e.g. bypassed review).

### 8. Shared Knowledge & Decision Tracking

Tools dealing with collective intelligence and context persistence.

* **`kb_write(key, content)` / `kb_read(key)` / `kb_list()`**: A global, shared repository distinct from individual workspaces. Ideal for team conventions.
* **`log_decision(decision, reasoning, topic)`**: Freezes debated logic. Prevents infinite looping over previously argued architectural choices.
* **`get_decisions(topic)`**: Retrieves frozen logic.
* **`get_compressed_history()`**: Mechanism for bypassing context limits by using semantic summaries instead of verbose raw logs.
* **`get_briefing()`**: A comprehensive "onboarding" snapshot aggregating recent kb, decisions, tasks, and locked files.

### 9. Team Governance (Voting, Reviews, Feedback)

Tools enforcing human-like project structures.

* **`request_review(file_path, description)`**: Halts progression until peers review logic.
* **`submit_review(review_id, status, feedback)`**: The counterpart feedback submission.
* **`call_vote(question, options)` / `cast_vote(vote_id, choice)` / `vote_status(vote_id)`**: Democratic resolution tools to systematically overcome agent stalemates.
* **`request_push_approval(branch, description)` / `ack_push(request_id)`**: Similar to Git Pull Requests logic, preventing unchecked master branch pollution.

### 10. Dependencies & Progress

Tools to block tasks based on requirements and track metrics.

* **`declare_dependency(task_id, depends_on)` / `check_dependencies(task_id)`**: Establishes blocking relationships between tasks.
* **`update_progress(feature, percent, notes)` / `get_progress()`**: Tracks higher-level epics/features globally.
* **`get_reputation(agent)`**: Generates leaderboards based on metrics like tasks completed, bugs found, etc.

---

## Best Practices

When integrating or testing these MCP tools:
1. **Always implement the base loop**: `register` -> `get_briefing` -> `listen` (or `get_work`), as documented in the internal constraints of `clis`/`templates`.
2. **Handle Non-Blocking vs. Blocking**: Differentiate usage between `check_messages`/`get_notifications` (light, non-blocking) and `listen`/`wait_for_reply` (heavy, poll-blocking loops).
3. **Confidence Matters**: Using `verify_and_advance` demands realistic self-evaluating confidence scores, otherwise autonomous chains break and flood edge-cases to humans unnecessarily.
