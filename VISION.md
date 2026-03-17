# Vision

Neohive exists because AI agents shouldn't work alone.

Today, every AI CLI tool runs in isolation. You open Claude Code in one terminal and Gemini in another — they can't see each other, share context, or divide work. You become the bottleneck, copying outputs between windows and manually coordinating.

**Neohive removes that bottleneck.** One command gives your AI agents the ability to communicate, delegate tasks, review each other's work, and execute multi-step workflows — across Claude Code, Gemini CLI, and Codex CLI.

## Where We're Going

### v6.0 (Current)

The foundation: professional-grade multi-agent infrastructure.

- 24 core MCP tools covering messaging, tasks, workflows, workspaces, knowledge base
- 30+ optional pro tools for autonomy, managed mode, voting, reviews, branching
- Real-time web dashboard with agent monitoring, kanban, workflows, stats
- Multi-CLI support (Claude Code, Gemini CLI, Codex CLI, Ollama)
- File-locked concurrent writes across all data files
- Structured logging with configurable levels
- Agent templates for common team patterns
- Security hardened (CSP, CSRF, content sanitization, path restrictions)

### Next (v6.x)

- **Modular architecture** — server split into lib/ + tools/ for testability and maintainability
- **Test suite** — integration tests for core flows (register, send, listen, ack, compact)
- **Tool reduction** — merge listen variants, consolidate KB/workspace tools, lazy-load optional tools
- **SQLite backend option** — `NEOHIVE_BACKEND=sqlite` for 10+ agent scale without filesystem contention
- **Audit logging** — every tool call tracked in audit.jsonl with timestamps, agent, args

### Medium-term (v7.x)

- **Remote agents via WebSocket** — agents on different machines connecting to a central server
- **API authentication** — API keys per team, token-based auth for dashboard and MCP tools
- **Role-based permissions** — admin, member, readonly roles enforced at tool level
- **Webhook integrations** — notify Slack, GitHub, CI on agent events
- **Token/cost tracking** — estimate and display per-agent API costs in the dashboard
- **Hosted cloud dashboard** — the paid tier: cloud-hosted monitoring, remote agents, team management

### Long-term

- **Enterprise features** — SSO/SAML, compliance, data retention policies, SLAs
- **MCP agent-to-agent spec** — contribute to and implement the MCP native agent coordination protocol
- **A2A protocol support** — interoperability with Google's Agent-to-Agent protocol
- **Cross-project intelligence** — agents that learn patterns from previous projects

## Principles

1. **Zero config** — `npx neohive init` and you're running. No accounts, no API keys, no cloud.
2. **Local first** — everything runs on your machine. Your data stays with you.
3. **CLI agnostic** — works with any AI CLI that supports MCP. Not locked to one provider.
4. **Professional grade** — file-locked writes, structured logging, security hardened. Built for teams, not toys.
5. **Agents are peers** — no agent has special privileges. Any agent can talk to any other.
6. **Human in the loop** — the dashboard lets you observe, inject, and override at any time.

## How to Help

- Try it and tell us what's missing — [GitHub Issues](https://github.com/fakiho/neohive/issues)
- Build a plugin or template — [Contributing](CONTRIBUTING.md)
- Report security vulnerabilities — [Security](SECURITY.md)
