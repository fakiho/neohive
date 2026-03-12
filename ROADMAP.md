# Neohive Roadmap

Built and maintained by Alionix — one developer, one product.

---

## What I'm building toward

Most AI coordination tools treat the filesystem as a hack. Neohive treats it as the feature. Every piece of state lives in `.neohive/` — append-only messages, file-locked writes, per-agent heartbeats. No hidden broker, no required cloud service. That's not a limitation; it's the design.

The priorities that drive every decision:

- **Reliability on disk** — if two agents write at the same time, nothing should corrupt. File locks, append-only JSONL, and per-agent state files are non-negotiable.
- **IDE-native, not just CLI** — the VS Code extension, Cursor skills, and Antigravity paths exist because agents should feel integrated, not bolted on.
- **Zero infra to start** — `npx neohive init` in 30 seconds, then you're running. Complexity is opt-in.
- **Autonomy that actually works** — `get_work` → do work → `verify_and_advance` → repeat. Agents shouldn't need babysitting.

---

## What's shipped and what's next

### Operator reliability

Getting solid with 5–50+ agents running concurrently:

| Item | Status | Note |
|------|--------|------|
| Per-agent heartbeat files | Shipped (v6.x) | Replaced shared `agents.json` writes — no more contention |
| Modular `lib/` + `tools/` architecture | Shipped (v6.x) | Server is now split for testability |
| SQLite backend (`NEOHIVE_BACKEND=sqlite`) | Planned | For teams hitting filesystem limits at scale |
| Audit log (`audit.jsonl`) | Planned | Every tool call, timestamped, with agent and args |
| Integration test suite | Planned | register → send → listen → ack → compact flows |

### IDE integration

Beyond `init` flags — agents that feel at home in your editor:

| Item | Status | Note |
|------|--------|------|
| VS Code extension — agent sidebar, task board, workflows, `@neohive` chat | Shipped (v0.5.x) | [Marketplace](https://marketplace.visualstudio.com/items?itemName=alionix.neohive) · [Open VSX](https://open-vsx.org/extension/alionix/neohive) |
| Listen-enforcement hooks for Claude Code | Shipped | `npx neohive hooks` wires `.claude/settings.json` |
| Cursor slash-command skills | Shipped | `npx neohive init --cursor` |
| Antigravity agent skills | Shipped | `npx neohive init --antigravity` |
| Inline task editing from VS Code | Planned | |

### Enterprise

| Item | Status | Note |
|------|--------|------|
| API key auth per workspace | Planned (v7.x) | |
| Role-based access (admin / member / readonly) | Planned (v7.x) | |
| Token and cost tracking | Planned (v7.x) | |
| SSO/SAML, compliance, retention policies | Long-term | |
| Hosted cloud dashboard (paid tier) | Long-term | |

### Protocol and interoperability

| Item | Status | Note |
|------|--------|------|
| Remote agents over WebSocket | Planned (v7.x) | Agents on different machines, same hive |
| Google A2A protocol | Planned (v7.x) | |
| MCP agent-to-agent spec | Exploratory | |
| Webhooks (Slack, GitHub, CI) | Planned (v7.x) | |

---

## Principles I don't compromise on

1. **Zero config first.** `npx neohive init` has to work on the first try, on any supported CLI, in under 30 seconds. Everything else is optional.
2. **Your data stays yours.** `.neohive/` is on your filesystem. I don't read it, send it, or know it exists.
3. **MCP is the contract.** Any MCP-capable CLI or IDE should work — no Alionix-specific patches required.
4. **Built for real use, not demos.** File-locked writes, structured logging, CSRF/CSP hardening. If it breaks under load, it's a bug.
5. **No agent hierarchy.** Every agent starts with the same privileges. Coordination comes from the tools, not special access.
6. **Always observable.** The dashboard and extension exist so you can watch, inject, and override at any point. You're never locked out.

---

## How I decide what to build next

Mostly: whatever I'm hitting myself while using it. Early on that's the only real signal — the repo is new and the issues list is empty. I build what feels broken, what's missing, or what would make the tool genuinely more useful in real workflows.

If you're using Neohive and have a specific situation you're solving, open a [GitHub issue](https://github.com/fakiho/neohive/issues/new?template=feature_request.md). Describe the actual problem, not just the feature. That's the kind of input that moves things up the list.

Want to contribute code? See [CONTRIBUTING.md](CONTRIBUTING.md).
