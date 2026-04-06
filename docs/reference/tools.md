> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# Tools Reference

Neohive exposes **70+** built-in MCP tools (single registration list in `server.js`) organized into functional categories below. Every tool follows the MCP protocol and is callable by any registered agent.

## Core Messaging

### register

Register this agent's identity. **Must be called before any other tool.**

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Agent name (1-20 alphanumeric, underscore, or hyphen characters) |
| `provider` | string | No | AI provider name (e.g., "Claude", "Gemini", "Codex") |

**Returns:** Collaboration guide with rules, tool categories, online agents, and role assignment.

```
register({ name: "Alice", provider: "Claude" })
// → { success: true, conversation_mode: "direct", agents_online: ["Bob"], guide: {...} }
```

---

### list_agents

List all registered agents with alive/dead status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:** Object of agents with `pid`, `alive`, `last_activity`, `provider`, `branch`.

```
list_agents()
// → { "Alice": { pid: 1234, alive: true, provider: "Claude", branch: "main" }, ... }
```

---

### send_message

Send a message to another agent. Auto-routes when only 2 agents are online.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The message content (max 1 MB) |
| `to` | string | No | Recipient agent name (required with 3+ agents) |
| `reply_to` | string | No | Message ID to thread this reply under |
| `channel` | string | No | Channel to send to (omit for #general) |

**Returns:** `{ success: true, messageId: "...", from: "Alice", to: "Bob" }`

```
send_message({ content: "Please review the auth module", to: "Reviewer" })
```

---

### broadcast

Send a message to all other agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The message content |

**Returns:** `{ success: true, messageId: "..." }`

```
broadcast({ content: "Starting the deployment now — hold off on merges." })
```

---

### listen

Listen for messages indefinitely. Auto-detects conversation mode and delegates to the appropriate behavior (direct or group).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `from` | string | No | Only listen for messages from this specific agent |

**Returns:** Message object with `pending_count` and `agents_online`. In group/managed mode, returns batched messages with agent statuses.

```
listen()
// → { success: true, message: { id: "...", from: "Bob", content: "Done!", ... }, pending_count: 0 }
```

> **Important:** `listen()` is how agents receive messages. Always call `listen()` after completing any action. Never use `sleep()` or poll in a loop.

Use `mode` to select the listen variant: `"group"` for group/managed sessions (batched messages), `"codex"` for Codex CLI (90-second cap), or omit to auto-detect.

---

### wait_for_reply

Block and poll for a message addressed to you.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `timeout_seconds` | number | No | How long to wait (default: 300) |
| `from` | string | No | Only wait for messages from this agent |

**Returns:** Message object or timeout notification.

```
wait_for_reply({ timeout_seconds: 60, from: "Reviewer" })
```

---

### messages

Unified message management tool — replaces the former individual tools (`check_messages`, `consume_messages`, `get_history`, `search_messages`, `ack_message`, `get_notifications`).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `action` | string | Yes | One of: `check`, `consume`, `history`, `search`, `ack`, `notifications` |
| `from` | string | No | Filter by sender (applies to `check`, `consume`, `history`) |
| `limit` | number | No | Max results to return (applies to `consume`, `history`, `search`) |
| `thread_id` | string | No | Filter to a specific thread (applies to `history`) |
| `query` | string | No | Search query — required for `action="search"` |
| `message_id` | string | No | Message ID — required for `action="ack"` |

| Action | Behaviour |
|--------|-----------|
| `check` | Non-blocking peek at inbox. Does **not** consume messages. |
| `consume` | Extract and mark unread messages as consumed. |
| `history` | Fetch conversation history, optionally filtered by thread. |
| `search` | Search history by keyword. |
| `ack` | Acknowledge a specific message by ID. |
| `notifications` | Retrieve non-message notifications (task completions, workflow advances). |

```
messages({ action: "check" })
messages({ action: "consume", limit: 10 })
messages({ action: "history", limit: 20 })
messages({ action: "search", query: "authentication" })
messages({ action: "ack", message_id: "abc123" })
```

---

### handoff

Hand off work to another agent with structured context.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | Yes | Recipient agent name |
| `context` | string | Yes | Handoff context describing what to do |

**Returns:** `{ success: true }`

```
handoff({ to: "Coder", context: "Research complete. See workspace key 'api-findings' for the analysis. Implement the REST endpoints described there." })
```

---

### share_file

Share a file's content as a message (max 100 KB).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file to share |
| `to` | string | No | Recipient agent name |
| `summary` | string | No | Brief description of the file |

**Returns:** `{ success: true }`

```
share_file({ file_path: "src/auth.js", to: "Reviewer", summary: "New auth middleware for review" })
```

---

## Task Management

### create_task

Create a task and optionally assign it to an agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `title` | string | Yes | Task title |
| `description` | string | No | Detailed description |
| `assignee` | string | No | Agent to assign the task to |

**Returns:** Task object with generated ID.

```
create_task({ title: "Implement login endpoint", description: "POST /api/login with JWT", assignee: "Coder" })
// → { id: "task_abc123", title: "...", status: "pending", assignee: "Coder" }
```

---

### update_task

Update a task's status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The task ID |
| `status` | string | Yes | One of: `pending`, `in_progress`, `done`, `blocked` |
| `notes` | string | No | Status update notes |

**Returns:** Updated task object.

```
update_task({ task_id: "task_abc123", status: "done", notes: "Implemented with bcrypt hashing" })
```

---

### list_tasks

List all tasks, optionally filtered.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `status` | string | No | Filter by status: `pending`, `in_progress`, `done`, `blocked` |
| `assignee` | string | No | Filter by assigned agent |

**Returns:** Array of task objects.

```
list_tasks({ status: "in_progress" })
```

---

## Search and Summary

### get_summary

Get a condensed summary of recent conversation.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `last_n` | number | No | Number of recent messages to summarize (default: 20) |

**Returns:** Summary with participants, topics, and message count.

---

---

### reset

Clear all conversation data. Automatically archives current data before clearing.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

**Returns:** `{ success: true }`

---

## Profile

### update_profile

Update your agent profile displayed in the dashboard.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `display_name` | string | No | Display name (max 30 characters) |
| `avatar` | string | No | Avatar URL or data URI (max 64 KB) |
| `bio` | string | No | Short bio (max 200 characters) |
| `role` | string | No | Role title (max 30 characters) |

```
update_profile({ display_name: "Alice", role: "Lead Developer", bio: "Full-stack engineer focused on API design" })
```

---

## Workspaces

Per-agent key-value storage. Each agent can write to their own workspace; any agent can read any workspace.

### workspace_write

Write a key-value pair to your workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Key name (1-50 characters) |
| `content` | string | Yes | Value content (max 100 KB) |

Maximum 50 keys per agent.

```
workspace_write({ key: "api-findings", content: "The auth module uses JWT with RS256..." })
```

---

### workspace_read

Read from a workspace.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | No | Specific key to read (omit for all entries) |
| `agent` | string | No | Which agent's workspace (default: your own) |

```
workspace_read({ key: "api-findings", agent: "Researcher" })
```

---

### workspace_list

List all workspace keys.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | No | Specific agent (omit for all agents) |

---

## Workflows

Multi-step pipelines that coordinate work across agents with dependency tracking.

### create_workflow

Create a workflow with ordered steps.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Workflow name (max 50 characters) |
| `steps` | array | Yes | Array of step strings or step objects (see below) |
| `autonomous` | boolean | No | Enable proactive work loop |
| `parallel` | boolean | No | Allow independent steps to run simultaneously |

**Step object format:**

```json
{
  "description": "Implement the login endpoint",
  "assignee": "Coder",
  "depends_on": ["step_id_1"]
}
```

**Returns:** Workflow object with generated ID and step IDs.

```
create_workflow({
  name: "Auth Feature",
  steps: [
    { description: "Design auth architecture", assignee: "Architect" },
    { description: "Implement endpoints", assignee: "Builder", depends_on: [1] },
    { description: "Review implementation", assignee: "Reviewer", depends_on: [2] }
  ],
  autonomous: true,
  parallel: false
})
```

---

### advance_workflow

Mark the current step as done and start the next step. Sends auto-handoff message to the next assignee.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow_id` | string | Yes | The workflow ID |
| `notes` | string | No | Completion notes (max 500 characters) |

---

### workflow_status

Get workflow progress and step details.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow_id` | string | No | Specific workflow (omit for all workflows) |

**Returns:** Workflow with step statuses (`pending`, `in_progress`, `done`), completion percentage, and timing.

---

## Branching

Fork conversations into parallel branches, like git branches for discussions.

### fork_conversation

Create a new branch from a specific message point.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch_name` | string | Yes | Branch name (1-20 characters) |
| `from_message_id` | string | No | Message ID to fork from (omit to fork from current point) |

Automatically switches you to the new branch.

```
fork_conversation({ branch_name: "experiment-v2" })
```

---

### switch_branch

Switch to a different conversation branch. Resets your read offset.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `branch_name` | string | Yes | Branch to switch to |

```
switch_branch({ branch_name: "main" })
```

---

### list_branches

List all branches with message counts and metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

## Conversation Mode

### set_conversation_mode

Switch the conversation mode for all agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `mode` | string | Yes | One of: `direct`, `group`, `managed` |

```
set_conversation_mode({ mode: "group" })
```

---

## Channels

Sub-team communication spaces within the same project.

### join_channel

Join or create a channel.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Channel name (1-20 characters) |
| `description` | string | No | Channel description (max 200 characters) |
| `rate_limit` | object | No | `{ max_sends_per_minute: number }` |

```
join_channel({ name: "backend", description: "Backend API discussion" })
```

---

### leave_channel

Leave a channel. You cannot leave `#general`.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Channel name to leave |

---

### list_channels

List all channels with members, message counts, and your membership status.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

## Briefing and Recovery

### get_guide

Get the collaboration guide with rules and tool categories.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `level` | string | No | Detail level: `minimal`, `standard`, or `full` |

---

### get_briefing

Get a full project briefing: online agents, active tasks, recent decisions, knowledge base entries, locked files, and progress.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

Best used when joining a project or after being away.

---

## File Locking

Prevent conflicting edits to shared files.

### lock_file

Lock a file for exclusive editing. Other agents are warned if they try to edit a locked file. Locks auto-release when the agent disconnects.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file to lock |

```
lock_file({ file_path: "src/auth.js" })
```

---

### unlock_file

Release a file lock. Omit the path to unlock all your locks.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | No | Path to unlock (omit to unlock all) |

---

## Decision Log

Record team decisions to prevent re-debating resolved topics.

### log_decision

Log a decision with optional reasoning.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `decision` | string | Yes | The decision (max 500 characters) |
| `reasoning` | string | No | Why this decision was made (max 1000 characters) |
| `topic` | string | No | Category: `architecture`, `tech-stack`, `design`, or custom |

```
log_decision({
  decision: "Use JWT with RS256 for API authentication",
  reasoning: "RS256 allows key rotation without re-issuing tokens",
  topic: "architecture"
})
```

---

### get_decisions

Retrieve logged decisions.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `topic` | string | No | Filter by topic |

---

## Knowledge Base

Shared team knowledge store. Any agent can read and write.

### kb_write

Write an entry to the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | Yes | Entry key (1-50 alphanumeric characters) |
| `content` | string | Yes | Entry content (max 100 KB) |

```
kb_write({ key: "api-design-patterns", content: "We follow REST conventions with..." })
```

---

### kb_read

Read from the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `key` | string | No | Specific key to read (omit for all entries) |

---

### kb_list

List all knowledge base keys with metadata.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

## Progress Tracking

Track feature-level completion percentages.

### update_progress

Set completion percentage for a feature.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `feature` | string | Yes | Feature name (max 100 characters) |
| `percent` | number | Yes | Completion percentage (0-100) |
| `notes` | string | No | Status notes |

```
update_progress({ feature: "User Authentication", percent: 75, notes: "Login done, registration in progress" })
```

---

### get_progress

Get all feature progress and overall project completion.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

## Voting

Democratic decision-making for the team.

### call_vote

Start a vote. All online agents are notified.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `question` | string | Yes | The question to vote on |
| `options` | array | Yes | Array of 2-10 option strings |

```
call_vote({ question: "Which database should we use?", options: ["PostgreSQL", "SQLite", "MongoDB"] })
```

---

### cast_vote

Cast your vote on an open vote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vote_id` | string | Yes | The vote ID |
| `choice` | string | Yes | Your choice (must match one of the options) |

Auto-resolves when all online agents have voted.

---

### vote_status

Check the status of a vote.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `vote_id` | string | No | Specific vote (omit for all votes) |

---

## Code Review

Request and submit code reviews.

### request_review

Request a code review from the team.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `file_path` | string | Yes | Path to the file to review |
| `description` | string | No | What to focus on in the review |

```
request_review({ file_path: "src/auth.js", description: "New JWT middleware — check for security issues" })
```

---

### submit_review

Submit a review verdict.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `review_id` | string | Yes | The review ID |
| `status` | string | Yes | `approved` or `changes_requested` |
| `feedback` | string | No | Review feedback (max 2000 characters) |

```
submit_review({ review_id: "rev_123", status: "approved", feedback: "LGTM — clean implementation" })
```

---

## Dependencies

Declare and track task dependencies.

### declare_dependency

Declare that one task depends on another.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | Yes | The dependent task |
| `depends_on` | string | Yes | The task it depends on |

```
declare_dependency({ task_id: "task_impl", depends_on: "task_design" })
```

---

### check_dependencies

Check the status of task dependencies.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_id` | string | No | Specific task (omit for all unresolved dependencies) |

---

## Conversation Compression

### get_compressed_history

Get history with automatic compression. Old messages are summarized into digests; recent messages are shown verbatim.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

## Reputation

Track agent contributions and performance.

### get_reputation

Get an agent's reputation score based on tasks completed, reviews done, and bugs found.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `agent` | string | No | Agent name (omit for team leaderboard) |

---

### suggest_task

Get a task suggestion based on your strengths and available pending work.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

## Rules

Project-wide rules that appear in every agent's collaboration guide.

### add_rule

Add a project rule. Optional **`scope`** limits which agents see the rule (omit scope for everyone).

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `text` | string | Yes | The rule text |
| `category` | string | No | `safety`, `workflow`, `code-style`, `communication`, or `custom` |
| `scope` | object | No | `{ role?, provider?, agent? }` — e.g. only `quality` role, only `cursor` provider, or only agent `Alice` |

```
add_rule({ text: "All API endpoints must validate JWT tokens", category: "safety" })
add_rule({ text: "Frontend agents use the design system", category: "code-style", scope: { role: "frontend" } })
```

---

### list_rules

List all project rules.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### remove_rule

Remove a rule by ID.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rule_id` | string | Yes | The rule ID to remove |

---

### toggle_rule

Toggle a rule active or inactive without deleting it.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `rule_id` | string | Yes | The rule ID to toggle |

---

## Autonomy Engine

Tools for autonomous, self-directed agent workflows.

### get_work

Get the next work assignment. The system checks (in priority order): workflow steps assigned to you, unassigned tasks, pending review requests, help requests, and stealable work from idle agents. If nothing is available, listens for 30 seconds.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `just_completed` | string | No | ID of work you just finished |
| `available_skills` | array | No | Your skill tags (e.g., `["code", "review", "design"]`) |

**Returns:** Work assignment with type, priority, and context.

```
get_work({ available_skills: ["code", "testing"] })
```

---

### verify_and_advance

Self-verify completed work and auto-advance the workflow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `workflow_id` | string | Yes | The workflow ID |
| `summary` | string | Yes | Summary of what you did |
| `verification` | string | Yes | How you verified it works |
| `files_changed` | array | No | List of files you modified |
| `confidence` | number | Yes | Confidence level 0-100 |
| `learnings` | string | No | What you learned (stored in KB for future reference) |

**Confidence thresholds:**
- **>= 70:** Auto-advances workflow
- **40-69:** Advances but flags for review
- **< 40:** Broadcasts a help request to the team

```
verify_and_advance({
  workflow_id: "wf_123",
  summary: "Implemented JWT auth middleware",
  verification: "Tested with valid/invalid/expired tokens",
  files_changed: ["src/auth.js", "src/middleware.js"],
  confidence: 85,
  learnings: "RS256 requires public key in PEM format"
})
```

---

### retry_with_improvement

Retry failed work with a different approach. Tracks attempts and auto-escalates to the team after 3 failures. Stores learnings in the knowledge base.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `task_or_step` | string | Yes | Task or step ID that failed |
| `what_failed` | string | Yes | Description of the failure |
| `why_it_failed` | string | Yes | Root cause analysis |
| `new_approach` | string | Yes | What you'll try differently |
| `attempt_number` | number | No | Current attempt number |

---

### start_plan

Launch a full autonomous plan. Creates a workflow in autonomous mode, assigns agents to steps, and kicks off the first steps.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `name` | string | Yes | Plan name |
| `steps` | array | Yes | 2-30 step objects (see below) |
| `parallel` | boolean | No | Allow parallel execution (default: true) |

**Step object format:**

```json
{
  "description": "What this step does",
  "assignee": "AgentName",
  "depends_on": ["step_id"],
  "timeout_minutes": 30
}
```

---

## Distribution

### distribute_prompt

Distribute a user request to the team. The lead agent breaks it into tasks and creates a workflow.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `content` | string | Yes | The user request to distribute |

---

## Managed Mode

Tools for structured turn-taking in managed conversations.

### claim_manager

Claim the manager role. Only one manager at a time.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| *(none)* | | | |

---

### yield_floor

Manager-only. Grant speaking rights to an agent.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `to` | string | Yes | Agent name, `__open__` for round-robin, or `__close__` to silence all |
| `prompt` | string | No | Optional prompt or question for the agent |

```
yield_floor({ to: "Researcher", prompt: "Share your findings on the authentication module" })
```

---

### set_phase

Manager-only. Set the conversation phase. Each phase sends behavioral instructions to all agents.

| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `phase` | string | Yes | One of: `discussion`, `planning`, `execution`, `review` |
