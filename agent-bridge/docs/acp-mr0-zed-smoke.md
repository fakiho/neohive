# MR-0 — Zed smoke test (`acp-spike.mjs`)

This document describes how to verify the **Agent Client Protocol** spike shipped in MR-0. The spike is a **minimal echo agent** only; it does **not** connect to `.neohive/` yet.

## What MR-0 proves

- `@agentclientprotocol/sdk` installs and runs under Node 18+ in this repo.
- **`AgentSideConnection`** + **`ndJsonStream`** over **stdio** match the official SDK example wiring.
- **ESM** (`.mjs`) is viable for ACP without converting the main Neohive **CommonJS** `server.js`.

## Prerequisites

- [Zed](https://zed.dev/) with ACP agent support (version aligned with current ACP docs).
- Node.js 18+.
- This repo: `cd agent-bridge && npm install` (pulls `@agentclientprotocol/sdk` as a **devDependency**).

## Agent command (absolute path)

Use an **absolute** path to the spike script so Zed’s subprocess does not depend on `cwd`:

```bash
node /absolute/path/to/neoHive/agent-bridge/scripts/acp-spike.mjs
```

(On your machine, replace `/absolute/path/to/neoHive` with the real workspace root.)

## Zed configuration (high level)

Zed’s UI for **external ACP agents** changes between releases. Use Zed’s own documentation for **“Agent Client Protocol”** or **custom agent** setup, and point the agent command to the line above.

**Expectation:** After the agent starts, open a session and send a short user message. The agent should stream a single text chunk starting with:

`[neohive ACP MR-0 spike] Echo:`

followed by your input.

## Troubleshooting

| Symptom | Check |
|--------|--------|
| Agent exits immediately | Confirm **absolute** `node` path (same trick as `npx neohive init` for Volta/nvm). |
| No output | Stderr should show `[neohive] acp-spike (MR-0): ...` on startup; if missing, the wrong file may be running. |
| Parse errors on stderr | Something wrote non-JSON to **stdout**; only the ACP stream may use stdout. |

## Reference implementations (for later MRs)

- Official SDK examples: `@agentclientprotocol/sdk` package under `dist/examples/`.
- Production-style Zed integration: Gemini CLI `zedIntegration.ts` (see [SPEC.md](../../SPEC.md) §10).

## Next MR

After Lead approval: **MR-1** introduces hub core wrappers; **MR-2** replaces this spike with a real `acp-agent.mjs` wired to Neohive.
