> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# Advanced Topics

## Autonomous Workflows

The Autonomy Engine enables agents to work independently with minimal human supervision. It combines workflows, self-verification, and automatic retry with escalation.

### The Autonomous Work Loop

```
get_work() → Do the work → verify_and_advance() → get_work()
```

1. **get_work()** checks multiple sources for the next assignment (in priority order):
   - Workflow steps assigned to you
   - Unassigned tasks matching your skills
   - Pending review requests
   - Help requests from other agents
   - Stealable work from idle agents

2. **Do the work** — implement, research, review, or whatever the assignment requires.

3. **verify_and_advance()** — self-assess your work with a confidence score:
   - **>= 70:** Workflow advances automatically
   - **40-69:** Advances but flags the step for human review
   - **< 40:** Broadcasts a help request to the team

4. **Repeat** until all work is done.

### Starting an Autonomous Plan

```
start_plan({
  name: "Build Auth System",
  steps: [
    { description: "Design auth architecture", assignee: "Architect" },
    { description: "Implement JWT middleware", assignee: "Builder", depends_on: [1] },
    { description: "Write integration tests", assignee: "Builder", depends_on: [2] },
    { description: "Security review", assignee: "Reviewer", depends_on: [3] }
  ],
  parallel: true
})
```

The plan creates a workflow in autonomous mode. Independent steps (those without `depends_on` pointing to unfinished steps) run simultaneously when `parallel: true`.

### Retry with Learning

When work fails, `retry_with_improvement()` tracks what went wrong and why:

```
retry_with_improvement({
  task_or_step: "step_2",
  what_failed: "JWT validation rejects valid tokens",
  why_it_failed: "Using HS256 but tokens are signed with RS256",
  new_approach: "Switch to RS256 verification with public key"
})
```

After 3 failed attempts, the system automatically escalates to the team.

### Dashboard Controls

The dashboard provides live controls for autonomous plans:
- **Pause/Resume** — Temporarily halt work
- **Stop** — Cancel the plan entirely
- **Skip** — Skip a stuck step and start the next ones
- **Reassign** — Move a step to a different agent

## Managed Mode

Managed mode provides structured turn-taking for large teams or formal processes.

### Setup

```
set_conversation_mode({ mode: "managed" })
claim_manager()
```

### Manager Controls

The manager controls who can speak and when:

```
// Give the floor to a specific agent
yield_floor({ to: "Researcher", prompt: "Present your findings" })

// Open the floor for round-robin
yield_floor({ to: "__open__" })

// Close the floor (silence all)
yield_floor({ to: "__close__" })

// Set the conversation phase
set_phase({ phase: "review" })
```

### Phases

| Phase | Behavior |
|-------|----------|
| `discussion` | Open discussion, agents share ideas |
| `planning` | Focus on planning and task breakdown |
| `execution` | Heads-down implementation |
| `review` | Review and feedback on completed work |

Each phase transition sends behavioral instructions to all agents.

## Conversation Branching

Fork conversations to explore alternatives without losing the original thread.

```
// Fork from a specific message
fork_conversation({ branch_name: "alt-design", from_message_id: "msg_abc" })

// Work on the branch
send_message({ content: "Trying a different approach here..." })

// Switch back to main
switch_branch({ branch_name: "main" })

// See all branches
list_branches()
```

Branches use separate message files (`branch-{name}-messages.jsonl`) so they don't interfere with each other. The `main` branch uses the standard files for backward compatibility.

## Channels

Create focused communication spaces for sub-teams:

```
// Create a channel
join_channel({ name: "backend", description: "Backend API work" })

// Send to a channel
send_message({ content: "API routes are ready", channel: "backend" })

// Leave a channel (cannot leave #general)
leave_channel({ name: "backend" })
```

Each channel has its own message queue and history files.

## Conversation Templates

Pre-built agent configurations and workflows for common scenarios.

### Team Templates (in `templates/`)

Applied with `npx neohive init --template <name>`:

| Template | Agents | Use Case |
|----------|--------|----------|
| `pair` | A, B | Two-agent brainstorming |
| `team` | Coordinator, Researcher, Coder | Complex features needing research |
| `review` | Author, Reviewer | Code review pipeline |
| `debate` | Pro, Con | Structured debate |
| `managed` | Manager, Agent1, Agent2 | Floor-controlled discussion |

### Conversation Templates (in `conversation-templates/`)

Launched from the dashboard with pre-built workflows:

| Template | Agents | Workflow |
|----------|--------|----------|
| `autonomous-feature` | Architect, Builder, Reviewer | Design → Implement → Review (autonomous) |
| `code-review` | Author, Reviewer, Moderator | Submit → Review → Revise |
| `debug-squad` | Investigator, Fixer, Verifier | Diagnose → Fix → Verify |
| `feature-build` | Architect, Builder, Reviewer | Design → Build → Review → Ship |
| `research-write` | Researcher, Writer, Editor | Research → Draft → Edit |

## Dynamic Guide System

When an agent registers, the server generates a context-aware collaboration guide based on:

- **Conversation mode** — Different rules for direct, group, and managed modes
- **Agent role** — Quality lead, monitor, advisor, or worker get different instruction sets
- **Autonomous mode** — Additional rules for self-directed work
- **Agent count** — Progressive rule disclosure (more agents = more coordination rules)
- **Custom rules** — Project rules from `rules.json` and `guide.md`
