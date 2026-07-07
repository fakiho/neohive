# Neohive × Agent Client Protocol (ACP) — Integration Specification

**Status:** Approved (subject to MR-by-MR implementation gates)  
**Version:** 0.2  
**Date:** 2026-04-12  
**Author:** Discovery pass (Backend / architecture)  

**Execution rule:** Implementation proceeds **one merge request (MR) at a time** per **§14**. The Lead **reviews and explicitly approves** each MR before work begins on the next. No stacking unrelated features in a single MR.

---

## 1. Purpose

Define how **Neohive** (filesystem-backed multi-agent hub, today exposed primarily as an **MCP** server) can integrate **ACP (Agent Client Protocol)** so that **ACP-capable IDEs** (e.g. JetBrains AI Assistant, Zed, future clients) can treat Neohive as a **first-class agent** while **preserving** the existing MCP path for Claude Code, Cursor, Gemini CLI, Codex, etc.

---

## 2. Phase 1 — Discovery summary

### 2.1 Documentation read


| Source                           | Takeaway                                                                                                                                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `README.md`                      | Neohive is MCP-first; each CLI spawns its own server process; `.neohive/` is the shared bus; dashboard is HTTP+SSE.                                                                   |
| `docs/documentation.md`          | Confirms MCP tool model and points to `docs/reference/architecture.md`.                                                                                                               |
| `docs/reference/architecture.md` | **Shared-nothing filesystem architecture**; per-process MCP `server.js`; message lifecycle (append → listen → consume); data dir resolution via `NEOHIVE_DATA_DIR` / `cwd/.neohive/`. |


### 2.2 Code audit (canonical implementation)


| Area                           | Location                                               | Behavior relevant to ACP                                                                                              |
| ------------------------------ | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| MCP transport                  | `agent-bridge/server.js`                               | `@modelcontextprotocol/sdk` `Server` + `StdioServerTransport`; `server.connect(transport)` at process boot.           |
| Tool surface                   | `agent-bridge/server.js` (+ `agent-bridge/tools/*.js`) | 70+ tools; `register`, `listen`, `send_message`, tasks, workflows, etc.                                               |
| Agent identity                 | `toolRegister()` in `agent-bridge/server.js`           | Maps **agent name** ↔ `**process.pid`** in `agents.json`; heartbeat files; `autoReclaimDeadSeat()` on startup.        |
| Message I/O                    | `toolListen`, `lib/messaging` patterns                 | Pull-based delivery; per-agent `consumed-*.json`; byte offsets into `messages.jsonl`.                                 |
| Alternate transport (existing) | `cli.js` (`npx neohive serve`)                         | **HTTP MCP** mode already exists as a separate entry — relevant when comparing “second socket” vs stdio-only clients. |
| Dashboard                      | `agent-bridge/dashboard.js`                            | Reads same `.neohive/`; injects messages; SSE — orthogonal to ACP but useful for **observability** of an ACP bridge.  |


### 2.3 Correction vs earlier briefing language

Some prompts describe ACP as “REST-native.” Per **official ACP architecture** ([Architecture](https://agentclientprotocol.com/overview/architecture)), the **agent subprocess** speaks **JSON-RPC** over **stdin/stdout**, with **notifications** for streaming UI updates. **Neohive’s dashboard** remains **HTTP** — that is separate from ACP wire format.

**Implication:** Integration work is **not** “replace MCP JSON-RPC with REST”; it is **add (or bridge) ACP’s JSON-RPC session model** alongside existing MCP tools, or expose Neohive through **MCP-over-ACP** where the client supports it ([RFD: MCP-over-ACP](https://agentclientprotocol.com/rfds/mcp-over-acp.md)).

---

## 3. Goals and non-goals

### 3.1 Goals (MVP)

1. **ACP clients can connect** to a Neohive-provided **agent entrypoint** (subprocess + manifest) without breaking existing MCP users.
2. **Single source of truth** remains `**.neohive/`** (messages, tasks, agents, workflows) — no second message store.
3. **Predictable identity:** an ACP-driven session must map to a **registered agent name** and participate in `list_agents` / dashboard liveness where feasible.
4. Document `**acp.json` / Zed config** fragments via `npx neohive init --acp`; **ACP Registry** submission in parallel after Zed smoke (**§12**).

### 3.2 Non-goals (initial phases)

- Rewriting the entire Neohive tool surface in ACP terms in one release.
- Removing MCP or stdio transport.
- Guaranteeing feature parity between **every** MCP tool and **every** ACP UI primitive (plans, terminals, elicitation) before MVP.

---

## 4. Current state vs future state

### 4.1 Current state

```
IDE/CLI  --stdio MCP JSON-RPC-->  server.js (per terminal PID)
                                      |
                                      v
                                 .neohive/  (JSONL + JSON state)
                                      ^
                                      |
                               dashboard.js (HTTP/SSE)
```

- **Unit of connection:** one MCP server process per spawning CLI.
- **Primary API:** MCP tools = side effects on disk + structured JSON results.
- **Identity:** `register(name)` + **PID** + heartbeat; optional auto-reclaim.

### 4.2 Future state (target)

Two **coexistent** frontends to the **same hub**:

```
                    +-- stdio MCP --> server.js (existing)
IDE / CLI ----------+                 |
                    |                 +--> .neohive/
                    +-- ACP JSON-RPC -> acp-agent (new)
                    |                      |
                    +-- (optional) MCP-over-ACP channel ----*
```

- **ACP path:** IDE spawns **Neohive ACP agent** process; ACP handles **sessions**, **prompt turns**, **tool-call UX notifications** per spec.
- **MCP path:** unchanged for existing users.
- **Shared core:** new code should call into **shared modules** (`agent-bridge/lib/*`) rather than duplicating disk protocol.

---

## 5. Architectural options (choose in review)


| Option                          | Description                                                                                                                                                                                            | Pros                                                           | Cons                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| **A — Thin ACP wrapper**        | New Node entry (`acp-agent.js`) using `@agentclientprotocol/sdk` `AgentSideConnection`; implements ACP lifecycle; **internally invokes** the same functions as MCP tools (refactor shared “core” API). | Clear separation; MCP untouched; matches ACP subprocess model. | Requires extracting non-trivial logic from monolithic `server.js` over time.            |
| **B — MCP-over-ACP only**       | No separate tool re-expression; IDE tunnels MCP to Neohive via ACP channel per RFD.                                                                                                                    | Less duplicate mapping if client supports it.                  | Depends on **client** support; may not cover all UX (notifications) without extra work. |
| **C — Dashboard as ACP client** | Dashboard or extension hosts ACP client side.                                                                                                                                                          | Interesting for web UX.                                        | Large scope; not recommended for MVP.                                                   |


**Recommendation:** **Option A for MVP**, keep **Option B** on the roadmap for clients that implement **MCP-over-ACP** (advertised via `mcpCapabilities.acp` per RFD).

---

## 6. Dependencies


| Dependency                                                                           | Role                                               | Notes                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `[@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)` | ACP **AgentSideConnection** (and tests / examples) | Official TypeScript SDK; Neohive today is **CommonJS** — implementation may use a **small ESM wrapper** subprocess, **dynamic `import()`**, or a **dual package** build step; **spike required** before committing to one approach. |
| `@modelcontextprotocol/sdk`                                                          | Existing MCP server                                | Remains; version pinned in `agent-bridge/package.json`.                                                                                                                                                                             |
| ACP protocol docs                                                                    | Normative behavior                                 | [Protocol index](https://agentclientprotocol.com/llms.txt) — especially **initialization**, **prompt turn**, **tool calls**, **session** lifecycle.                                                                                 |


**Optional reference implementations** (for patterns, not hard dependencies): Gemini CLI Zed integration (linked from ACP TypeScript docs), open-source ACP examples in `typescript-sdk` repo.

---

## 7. Configuration: `acp.json` and IDE registration

Exact filenames vary by client (JetBrains vs Zed vs registry). Neohive should ship a **documented template** and, if feasible, `**npx neohive init --acp`** to write it.

### 7.1 Illustrative manifest (Zed-oriented — align with final registry schema)

```json
{
  "name": "neohive",
  "version": "6.4.2",
  "description": "Multi-agent collaboration hub — ACP bridge to shared .neohive/",
  "command": "node",
  "args": ["${workspaceFolder}/node_modules/neohive/acp-agent.mjs"],
  "env": {
    "NEOHIVE_DATA_DIR": "${workspaceFolder}/.neohive",
    "NEOHIVE_ACP_AGENT_NAME": "acp-${workspaceName}"
  },
  "capabilities": {
    "mcpBridge": true
  }
}
```

**Client-specific expansion:** `${workspaceName}` (and similar tokens) are **defined by the ACP client** that launches the subprocess—not by Node. If the client does not expand a variable, the agent sees the literal string and may fail `sanitizeName()` or collide. **Document per client** and always provide a **static fallback** example, e.g. `"NEOHIVE_ACP_AGENT_NAME": "acp-myproject"` for copy-paste setups.

**Default when env is unset (runtime):** the ACP entrypoint should default to a deterministic name such as `acp-<hostname>` or `acp-<workspaceFolderBasename>` derived from `NEOHIVE_DATA_DIR` / `cwd` (see **§12.3**).

**Review items before freezing:**

- **Command path:** published package layout (`agent-bridge/` vs npm `files` field) must expose a stable **ACP entry binary**.
- `**NEOHIVE_DATA_DIR`:** must match documented resolution order; never rely on unexpanded `${workspaceFolder}` in env if the runtime is plain Node (see existing Cursor warning in `server.js`).
- **Registry:** submit to [ACP Registry](https://agentclientprotocol.com/get-started/registry.md) (**parallel track** once Zed smoke passes) via PR to `agentclientprotocol/registry` (`agent.json` + optional `icon.svg`).

---

## 8. Identity, PID, and liveness


| Topic            | MCP today                      | ACP integration impact                                                                                                                                                                                                                         |
| ---------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Process identity | `process.pid` in `agents.json` | ACP agent process has its **own** PID — distinct from MCP-based agents.                                                                                                                                                                        |
| Agent name       | `register(name)`               | Bridge should call the **same registration path** (or shared helper) so dashboard shows the session.                                                                                                                                           |
| Auto-reclaim     | `autoReclaimDeadSeat()`        | Risk of **colliding** with MCP auto-reclaim if both run against same stale name — **must** define policy: e.g. ACP agent **always explicit `register`**, disable auto-reclaim for ACP entrypoint, or use **dedicated name prefix** (`acp::…`). |
| `listen()` loop  | MCP tool                       | ACP agents do not call MCP `listen()` unless MCP-over-ACP exposes tools; **push model** may use ACP **notifications** instead while still **reading** hub state from disk for team messages.                                                   |


**Resolved (see §12):** **One ACP process instance ↔ one Neohive agent name** (ACP session id stays on the ACP side). **Per-workspace configurable** name via `NEOHIVE_ACP_AGENT_NAME`, with deterministic defaults when unset — avoids two developers colliding on a fixed `acp-bridge`.

---

## 9. Technical limitations and risks

1. **Dual protocol semantics:** MCP tools return **immediate JSON**; ACP emphasizes **streaming notifications** and **editor requests** (permissions, etc.). A straight 1:1 mapping of every Neohive tool to ACP UX may be non-trivial.
2. **Monolithic `server.js`:** Much logic lives in one file (~8k+ lines). A maintainable ACP layer needs **incremental extraction** into `lib/` or `core/` with shared handlers (same risk as any new transport).
3. **CJS vs ESM:** SDK is TypeScript/ESM-oriented; integration may require **build tooling** or a **subprocess boundary** — spike before MVP estimate.
4. **HTTP MCP (`neohive serve`):** Useful experimentally; ACP docs note editors may proxy MCP — avoid assuming **one stdio pipe** can carry both protocols without client cooperation ([Architecture — MCP section](https://agentclientprotocol.com/overview/architecture)).
5. **Security:** ACP assumes a **trusted** local editor model similar to MCP; Neohive’s **message injection** and **dashboard** surfaces must stay **CSRF/auth**-aware where HTTP is involved (existing concern, not introduced by ACP alone).

---

## 10. Step-by-step implementation plan (post-approval)

### MVP hub surface (v1 messaging only)

Day-one Neohive operations exposed through the ACP bridge (aligned with **§12.2**):


| Hub capability            | Maps to                                                    |
| ------------------------- | ---------------------------------------------------------- |
| Session identity          | `register`                                                 |
| Send coordination traffic | `send_message`                                             |
| Who is online             | `list_agents`                                              |
| One-shot context          | `get_briefing`                                             |
| Inbound replies           | `listen` (pull) **and/or** ACP **notifications** (push UX) |


**Tasks, workflows,** and richer ACP primitives (plans, elicitation) are **Phase 2+**, not MVP.

### Phase 0 — Spike (1–3 days) — **Zed**

1. Add `**@agentclientprotocol/sdk`** on a dedicated branch; prove `**AgentSideConnection**` from a **standalone `.mjs` entry** (path of least resistance: **pure ESM**; use `import()` / `createRequire` only where calling into existing **CJS** `lib/` is unavoidable).
2. Run **Zed smoke test** using patterns from the official TypeScript SDK examples and **Gemini CLI** `[zedIntegration.ts](https://github.com/google-gemini/gemini-cli)` as the canonical production template.
3. Document **CJS/ESM boundary** decision in MR-0 description (no production Neohive behavior change required beyond dependency + spike files if kept isolated).

### Phase 1 — Core extraction (incremental) — **MR-1**

**Hard rules:**

1. `**agent-bridge/core/` is CommonJS** (`.js`, `require`/`module.exports`). **Do not** introduce ESM in MR-1 — the **CJS/ESM boundary** belongs in **MR-2** (`acp-agent.mjs` + SDK), not here.
2. **Delegate to existing `lib/`** — `lib/messaging.js`, `lib/agents.js`, `lib/file-io.js`, `lib/config.js`, `lib/state.js` (and closely related helpers they already use). **No re-implementing** the disk protocol in `core/`.
3. **Five thin exports only** (MVP hub actions from **§12.2** / **§10**): one function each for the operational equivalents of `register`, `send_message`, `list_agents`, `get_briefing`, `listen`. Target **~10–20 lines per function**; if a `core/` file grows large, it is probably **duplicating `lib/`** — stop and refactor.
4. `**server.js` changes** for MR-1 are **optional / follow-up** — the hub façade can ship **without** MCP rewiring so ACP (`acp-agent.mjs`) is the first consumer. **No** new MCP tools in MR-1.
5. **Scope / timing:** Recent **push-delivery and hooks** work (e.g. commits `f78f582`, `53a9f2e`, `2b88f0c`) already mitigates the **listen-loop** pain for MCP users. **No pressure** to rush or **expand** MR-1 beyond the five actions.


| Step | Action                                                                                                                               |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 1.1  | Map each MVP action to **existing** `lib/*` entry points; list gaps (if any) before coding.                                          |
| 1.2  | Add `**agent-bridge/core/hub.js`** (or a few small files) with the **five** thin wrappers — **call `lib/`**, do not copy disk logic. |
| 1.3  | *(Optional follow-up)* Wire `**server.js*`* MCP handlers to `core/hub.js` if the team wants one code path for MCP + ACP.             |
| 1.4  | Optional: manual or script smoke test; **no** new test framework required.                                                           |


**Gate:** **Do not start MR-1** until **MR-0** is **complete** (Lead Zed smoke + merge + **“approve MR-1”**).

### Phase 2 — ACP agent entrypoint


| Step | Action                                                                                                                                                         |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2.1  | New file: `agent-bridge/acp-agent.mjs` — stdio ACP server (`AgentSideConnection`).                                                                             |
| 2.2  | Resolve `DATA_DIR`; `**register`** using `NEOHIVE_ACP_AGENT_NAME` if set, else default `acp-<hostname>` or `acp-<basename(NEOHIVE_DATA_DIR)>` (see **§12.3**). |
| 2.3  | Map **prompt turns** to MVP hub actions only; surface inbound mail via `**listen`** semantics + ACP notifications as needed.                                   |
| 2.4  | Emit ACP **notifications** for long or multi-step operations per [tool calls](https://agentclientprotocol.com/protocol/tool-calls.md) / session updates.       |


### Phase 3 — CLI / init / docs


| Step | Action                                                                                                                                             |
| ---- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 3.1  | `cli.js`: `npx neohive init --acp` writes Zed-oriented snippet + **§7.1** template (with static-fallback note).                                    |
| 3.2  | `README.md` + `docs/documentation.md`: **ACP + Zed** section; link to this `SPEC.md`.                                                              |
| 3.3  | **ACP Registry:** open PR to `agentclientprotocol/registry` (**parallel** once Zed smoke passes; not a substitute for a real client test harness). |


### Phase 4 — MCP-over-ACP (optional)


| Step | Action                                                                                                                                                                  |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4.1  | Follow [MCP-over-ACP RFD](https://agentclientprotocol.com/rfds/mcp-over-acp.md); advertise `mcpCapabilities.acp` if/when Neohive exposes an MCP server **through** ACP. |
| 4.2  | Validate with a client that implements the RFD.                                                                                                                         |


### Phase 5 — JetBrains (v1.1)

Target **Junie / JetBrains** ACP surface **after** Zed + registry path is stable — newer docs and less SDK example coverage than Zed for v1.

---

## 11. Files expected to change (checklist)


| File / area                                         | Change type                                                       |
| --------------------------------------------------- | ----------------------------------------------------------------- |
| `agent-bridge/package.json`                         | Add `@agentclientprotocol/sdk`; optional `exports` for ACP entry. |
| `agent-bridge/acp-agent.mjs` (new)                  | ACP stdio process.                                                |
| `agent-bridge/lib/*` or `agent-bridge/core/*` (new) | Shared hub operations extracted from `server.js`.                 |
| `agent-bridge/server.js`                            | Refactor to call shared core (incremental; avoid big-bang).       |
| `agent-bridge/cli.js`                               | `init --acp`, help text.                                          |
| `agent-bridge/templates/*`                          | IDE template fragments for ACP manifest.                          |
| `README.md`, `docs/documentation.md`                | User-facing ACP instructions.                                     |
| `SPEC.md`                                           | Bump version / status after review.                               |


---

## 12. Product decisions (answered — 2026-04-12)

### 12.1 Primary ACP client for v1

**Decision:** **Zed first**; **ACP Registry** as a **parallel** distribution track; **JetBrains (Junie)** = **v1.1**.

**Rationale:**

- Zed has the most mature ACP integration; official **TypeScript SDK** examples are written and tested against it.
- **Gemini CLI** `[zedIntegration.ts](https://github.com/google-gemini/gemini-cli)` is the best **production template** to follow.
- JetBrains is in the registry but the ACP surface is newer with less public documentation outside their agent.
- The registry is **not** a test harness — submit only after the agent passes a **real client** (Zed) smoke test.

**Concrete plan:** Phase 0 targets **Zed smoke**; registry PR (`agent.json` + optional `icon.svg` to `agentclientprotocol/registry`) once that passes.

### 12.2 MVP hub actions (day one)

**Decision:** **Messaging only** — **five** hub capabilities (see **§10** table).


| Tool / capability | Role                                                                      |
| ----------------- | ------------------------------------------------------------------------- |
| `register`        | Session identity on connect                                               |
| `send_message`    | Core hub action; maps naturally to a prompt turn                          |
| `list_agents`     | IDE-visible roster / liveness                                             |
| `get_briefing`    | Single-call context load                                                  |
| `listen` + push   | Inbound replies; `listen` for hub semantics, **ACP notifications** for UX |


**Tasks and workflows** = **Phase 2+** (need richer ACP UI primitives).

### 12.3 Agent naming

**Decision:** **Per-workspace configurable** via env, with a **deterministic default** when unset.

- `**NEOHIVE_ACP_AGENT_NAME`** in manifest `env` (see **§7.1**). Example: `"acp-${workspaceName}"` **when the client expands it**.
- **If unset or unexpanded:** default to `acp-<hostname>` or `acp-<basename(workspaceFolder)>` derived from `NEOHIVE_DATA_DIR` / cwd — readable and collision-resistant across machines.
- Fixed `acp-bridge` alone is **not** acceptable as the only default (collisions when two developers use the same hub).

### 12.4 Distribution

**Decision:** **npm only** for ACP v1.

- IDE spawns `node …/acp-agent.mjs` — **npm package** is the correct vector.
- `**vscode-extension/`** remains **MCP** for Cursor/VS Code; do **not** bundle ACP into the extension for v1.
- **Discoverability:** ACP Registry PR (free). Revisit **VS Code ACP** (e.g. community clients) only if user demand appears — **v2** track.

---

## 13. Approval


| Role           | Name        | Date       | Approved |
| -------------- | ----------- | ---------- | -------- |
| Product / Lead | Lead (user) | 2026-04-12 | ☑        |
| Backend        | Composer    | 2026-04-12 | ☑        |


**Spec verdict:** Approvable at **v0.2** with **§7.1** + **§12** amendments above.

Implementation proceeds under **§14** — **wait for explicit MR approval** before each next MR.

---

## 14. Merge requests (MR) plan & review gates

**Operational rule (mandatory):**

1. **One open MR** per row below (no mixing phases).
2. **Do not start** the next MR until the Lead **reviews and explicitly approves** the current one (merge or “approved to proceed” comment).
3. Each MR must be **reviewable in isolation**: clear description, scope bound to the row, screenshots or logs for Zed where applicable.
4. **No production behavior change** in MR-0 beyond an isolated spike unless the Lead approves otherwise.


| MR                | Title                     | Scope (what ships)                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Review checklist                                                                                                                           | Depends on                                         |
| ----------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| **MR-0**          | ACP Phase 0 spike         | **Shipped:** `agent-bridge/package.json` devDependency `@agentclientprotocol/sdk`; `**agent-bridge/scripts/acp-spike.mjs`** (stdio **AgentSideConnection** + echo `prompt`); `**agent-bridge/docs/acp-mr0-zed-smoke.md`**; `npm run acp-spike`. **CJS/ESM:** spike is pure **ESM**; main Neohive stays **CJS**. **No** `acp-agent.mjs` yet.                                                                                                                                            | Dependency license/size OK; `node --check` passes; stderr banner on spawn; **you** run Zed smoke per doc; zero MCP changes to `server.js`. | SPEC v0.2 + Lead approval to start MR-0            |
| **MR-1**          | Hub core wrappers (MVP 5) | `**core/hub.js` (CommonJS):** `register`, `sendMessage`, `listAgents`, `getBriefing`, `listen` → `**lib/agents`**, `**lib/messaging**`, `**lib/compact**` (consumed IDs). May ship **without** `server.js` edits; MCP unchanged until a later optional wiring MR. **No** ACP SDK.                                                                                                                                                                                                      | Wrappers stay thin; disk logic lives in `lib/`; `server.js` diff may be **zero**.                                                          | MR-0 **merged** + Lead **“approve MR-1”**          |
| **MR-2**          | `acp-agent.mjs` MVP       | Ship `**acp-agent.mjs`** using SDK; uses **MR-1** `core/hub.js`; implements **§12.2**; naming per **§12.3**; `package.json` `**files` / `bin`** so npm exposes entry path from **§7.1**. Handle `**setSessionMode`** for non-default mode selectors if Zed sends them (MR-0 spike used an empty stub). **Wire format:** ACP JSON-RPC methods are **namespaced** (e.g. `session/new`, `session/prompt`, `session/update`) — not camelCase; map prompt turns to hub actions accordingly. | Zed end-to-end: connect, register, send, receive; dashboard shows agent; docs snippet in MR.                                               | MR-1 merged + Lead approval                        |
| **MR-3**          | `init --acp` + docs       | `cli.js` `**init --acp`**; template under `**templates/**`; **README** + `**docs/documentation.md`** ACP/Zed section; **§7.1** static-fallback documented.                                                                                                                                                                                                                                                                                                                             | Init idempotent; paths work for published layout; docs accurate.                                                                           | MR-2 merged + Lead approval                        |
| **MR-4**          | ACP Registry (parallel)   | **Separate repo PR** to `agentclientprotocol/registry` + cross-link in Neohive README.                                                                                                                                                                                                                                                                                                                                                                                                 | Registry maintainers’ requirements met; icon optional.                                                                                     | MR-2 or MR-3 merged (Lead decides) + Lead approval |
| **MR-5** (future) | Tasks / workflows via ACP | Elicitation, plans, task tools — **out of MVP**.                                                                                                                                                                                                                                                                                                                                                                                                                                       | TBD when Phase 2 is scheduled.                                                                                                             | MR-3 + product priority                            |
| **MR-6** (future) | JetBrains v1.1            | Validate Junie manifest + behavior.                                                                                                                                                                                                                                                                                                                                                                                                                                                    | TBD.                                                                                                                                       | MR-3 stable                                        |


**MR-0:** Code review **passed** (wiring, lifecycle, stderr/stdout split, devDependency placement, docs). **Pending:** Lead runs **Zed smoke** per `agent-bridge/docs/acp-mr0-zed-smoke.md` and merges when satisfied. Reply **“approve MR-1”** after merge + successful Zed check (or document blocker).

**MR-1:** **Implemented (lib + `core/hub.js` only)** — five hub exports delegate to `lib/`; `**server.js` not modified** in this pass. **Next:** Lead review, then `**approve MR-2`** to wire `acp-agent.mjs` via `createRequire('./core/hub')` (or optional future MR to route MCP through hub).

---

## References

- Neohive architecture: `docs/reference/architecture.md`
- ACP architecture: [https://agentclientprotocol.com/overview/architecture](https://agentclientprotocol.com/overview/architecture)  
- ACP TypeScript SDK: [https://www.npmjs.com/package/@agentclientprotocol/sdk](https://www.npmjs.com/package/@agentclientprotocol/sdk)  
- MCP-over-ACP RFD: [https://agentclientprotocol.com/rfds/mcp-over-acp.md](https://agentclientprotocol.com/rfds/mcp-over-acp.md)  
- Neohive MCP server setup: `agent-bridge/server.js` (MCP `Server` / `StdioServerTransport`)

