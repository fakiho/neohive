# Documentation audit — Neohive

**Purpose:** Onboarding and maintenance guide for documentation. Lists what to **create**, **improve**, **enhance**, or **remove**, grounded in a pass over the repo (Markdown/MDC) and spot-checks against `agent-bridge/server.js`, `cli.js`, and `package.json`.

**Audit date:** 2026-04-04  
**Package version (source of truth):** `agent-bridge/package.json` → **6.0.3**  
**MCP server metadata:** `server.js` registers `{ name: 'neohive', version: '6.0.3' }` (aligned with package as of remediation pass).

---

## Methodology (plan executed)

| Step | Scope | Status |
|------|--------|--------|
| 1 | Glob all `*.md` / `*.mdc` in repo | Done |
| 2 | Compare root `README.md`, `CONTRIBUTING.md`, `CHANGELOG.md`, `USAGE.md` vs `agent-bridge/` and `cli.js` | Done |
| 3 | Review `docs/` (`documentation.md`, `ai-onboarding.md`, `mcp-tools-documentation.md`) for overlap and accuracy | Done |
| 4 | Check `SECURITY.md` duplicates, IDE guides (`CLAUDE.md`, `GEMINI.md`, copilot, Cursor rules/skills), `neohive-plugin/` | Done |
| 5 | Spot-check code: MCP tool list (`CallToolRequestSchema` switch), env vars, CLI commands | Done |
| 6 | Produce this file with prioritized actions | Done |

**Not done in this pass (optional follow-up):** line-by-line review of `dashboard.html` inline help, every REST path in `dashboard.js` vs `documentation.md`, and every init flag in `cli.js`.

---

## Executive summary

- **Single biggest issue:** **Two divergent changelogs** (root vs `agent-bridge/`) and **stale root `CHANGELOG.md`** (latest section is **5.3.0** while the shipped package is **6.0.3**).
- **Second issue (remediated in docs):** **`NEOHIVE_FULL_TOOLS`** was documented without implementation in `server.js`. README / onboarding / config tables were updated to describe a **single 70+ tool list**; the env var was **removed** from user-facing docs.
- **Third issue (partially remediated):** **Tool counts** were aligned in README, documentation hub, USAGE, VISION, CONTRIBUTING, CLAUDE to **70+**; exact `case` count in `server.js` may still drift — re-count when adding tools.
- **Duplicate content:** Root **`README.md`** and **`agent-bridge/README.md`** are effectively the same; root **`SECURITY.md`** and **`agent-bridge/SECURITY.md`** appear identical — risk of editing one and not the other.

---

## Inventory — documentation files

| Path | Role |
|------|------|
| `README.md` | Product landing, quick start, feature matrix |
| `VISION.md` | Roadmap / principles |
| `CHANGELOG.md` | **Root** release notes (stale vs package) |
| `CONTRIBUTING.md` | Contributor setup (paths/tool counts outdated) |
| `USAGE.md` | Long-form usage (version header outdated) |
| `SECURITY.md` | Vulnerability reporting + model (duplicate of bridge copy) |
| `CLAUDE.md` | Claude Code agent context |
| `GEMINI.md` | Gemini CLI context |
| `.github/copilot-instructions.md` | Copilot Chat context |
| `.cursor/rules/neohive.mdc` | Cursor Neohive workflow rules |
| `.cursor/rules/debugging-and-fixes.mdc` | Cursor debugging policy |
| `.cursor/skills/neohive-*.md` | Coordinator / developer skills |
| `.agent/skills/neohive/SKILL.md` | Antigravity-oriented skill |
| `docs/README.md` | `docs/` index + **naming convention** (kebab-case) |
| `docs/documentation.md` | Documentation **hub** (overview, getting started, links) |
| `docs/reference/*.md` | Split reference: tools, dashboard API, data dir, CLI, etc. |
| `docs/ai-onboarding.md` | AI contributor orientation |
| `docs/mcp-tools-documentation.md` | Secondary MCP tool narrative + categories |
| `agent-bridge/README.md` | Duplicate of root README (npm package readme) |
| `agent-bridge/CHANGELOG.md` | Package changelog (**has 6.x**) |
| `agent-bridge/SECURITY.md` | Duplicate of root SECURITY |
| `agent-bridge/neohive-plugin/**/*.md` | Plugin install + skills for Claude/Gemini |
| `.github/ISSUE_TEMPLATE/*.md` | Issue templates |

---

## Actions — create (new documentation)

| # | Item | Rationale |
|---|------|-----------|
| C1 | **`docs/CHANGELOG.md` policy** (short doc or section in CONTRIBUTING) | Define **one** authoritative changelog for humans: either root `CHANGELOG.md` mirrors `agent-bridge/CHANGELOG.md`, or root links to the package changelog only. |
| C2 | **`docs/reference/architecture.md` (optional)** | `VISION.md` calls for modular architecture; a **single diagram + module boundaries** (`server.js` vs `lib/*` vs `dashboard.js`) would reduce reliance on huge `documentation.md` for onboarding. |
| C3 | **`docs/reference/cli.md` kept in sync** | `cli.js` exposes **`neohive serve`** (HTTP MCP); keep README and this file aligned. |
| C4 | **Plugin story in main docs** | `CONTRIBUTING.md` links to `README.md#plugins` but root README **has no `#plugins` anchor** in a quick grep — either add a Plugins section or fix the link to `docs/documentation.md` or plugin README. |

---

## Actions — improve / enhance (existing docs)

| # | File | Issue | Suggested fix |
|---|------|--------|----------------|
| I1 | `CHANGELOG.md` (root) | Stops at **5.3.0**; missing **6.x** releases present in `agent-bridge/CHANGELOG.md` | Backfill 6.0.x from package changelog **or** replace with pointer: “See `agent-bridge/CHANGELOG.md`.” |
| I2 | `agent-bridge/CHANGELOG.md` | Jumps **6.0.3 → 5.1.0** (no 5.2/5.3 sections in file); root has 5.2/5.3 detail | Merge missing sections so history is contiguous or add note “5.2–5.3 documented in git history / root CHANGELOG archive.” |
| I3 | `README.md` + `agent-bridge/README.md` | **`NEOHIVE_FULL_TOOLS`** described; **not implemented** in `server.js` | Remove env var **or** re-implement gating; until then, **delete** references to “24 core / 30 optional” split **or** rewrite to match actual registration. |
| I4 | Same + `docs/documentation.md` | States **66** tools | Regenerate count from `server.js` (currently **~71** built-in `case` labels in `CallToolRequestSchema` handler, excluding `default`). |
| I5 | `docs/documentation.md` | Footer still says **v5.3.0** | Update to **6.0.x** and match header version. |
| I6 | `docs/documentation.md` | **Data directory** table omits files present in code (e.g. `push-requests.json`, `audit_log.jsonl`, `agent-cards.json`, `notifications.json` — verify against `server.js` top-of-file constants) | Extend **Data Directory Reference** to match reality. |
| I7 | `docs/documentation.md` | **`add_rule`** table omits **`scope`** | `toolAddRule` accepts `scope`; document parameter and semantics (match `inputSchema` in `server.js`). |
| I8 | `CONTRIBUTING.md` | **`cd neohive/neohive`** — wrong path | Use **`cd neoHive/agent-bridge`** (or actual repo folder name) + `npm install`. |
| I9 | `CONTRIBUTING.md` | “**27 tools + plugins**”, structure omits **`lib/`** | Update tool count; document **`agent-bridge/lib/`** as the target for new shared code. |
| I10 | `CLAUDE.md` | Same stale **27 tools** line | Align with real tool surface + `lib/` note. |
| I11 | `USAGE.md` | Title **v5.1.0** | Bump to **6.0.x** and reconcile with README (export format, dashboard features). |
| I12 | `SECURITY.md` (both copies) | **Supported versions** table lists **3.x** only | Update for **6.x** support policy or generic “current major” wording. |
| I13 | `README.md` **Documentation** table | Does not list **`docs/ai-onboarding.md`** or **`docs/mcp-tools-documentation.md`** | Add rows so AI/humans find them; clarify **canonical** vs **supplementary**. |
| I14 | `docs/mcp-tools-documentation.md` | Overlaps **`documentation.md`**; **marketing tone** (“Unprecedented”); some signatures abbreviated | Either **trim** to a one-page index linking to `documentation.md` **or** mark clearly as “high-level only”; fix **`workflow_status`** description to match real args (`workflow_id`, `action`, `checkpoint_index`). |
| I15 | `docs/ai-onboarding.md` | References **`NEOHIVE_FULL_TOOLS`** | Remove or rewrite per I3. |
| I16 | `GEMINI.md` / `.github/copilot-instructions.md` | Likely duplicate “available tools” lists vs server | Periodic sync check (same as I4). |
| I17 | `VISION.md` | Already good; could **link** to `docs/documentation-audit.md` for doc-debt tracking | Optional cross-link under “How to Help.” |

---

## Actions — delete / consolidate / de-emphasize

| # | Item | Recommendation |
|---|------|----------------|
| D1 | **Dual `SECURITY.md`** | **Keep one canonical file** (e.g. root) and make the other a short “see ../SECURITY.md” **or** generate from one source — avoid silent drift. |
| D2 | **Dual `README.md`** | **Keep** `agent-bridge/README.md` for npm, but add a **one-line** note at top: “Synced from repo root; edit root README when changing product docs” **or** automate copy in release script — document the rule in CONTRIBUTING. |
| D3 | **`docs/mcp-tools-documentation.md`** | **Do not delete without decision:** overlaps `documentation.md`. Options: (a) merge unique bits into `documentation.md` and delete; (b) keep as **short** “tool index” only; (c) rename to `mcp-tools-index.md` if you split “index” vs “essay”. |
| D4 | Root **`CHANGELOG.md`** if unmaintained | **Delete** only if replaced by clear pointer to `agent-bridge/CHANGELOG.md` everywhere (README, npm). |

---

## Code-derived facts to align docs with

| Topic | Code reference | Doc mismatch |
|--------|----------------|--------------|
| Max message size | MCP: `MAX_CONTENT_BYTES = 1000000` in `server.js` | Root `CHANGELOG.md` cites **100KB** for “input validation” (likely **dashboard API** paths). `dashboard.js` mixes checks (e.g. `content.length > 100000` vs `MAX_BODY` 1 MB) — **document per-endpoint limits** in `documentation.md`. |
| Built-in MCP tools | Single `tools: [...]` list + matching `switch (name)` | Split “core vs optional” in README is **not** enforced by `NEOHIVE_FULL_TOOLS` in code |
| CLI | `cli.js` includes **`serve`** | README CLI table omits **`neohive serve`** |
| MCP server version string | `6.0.0` in `Server({ version: ... })` | May disagree with **6.0.3** package |

---

## Suggested priority order

1. **Changelog strategy (I1, I2, C1)** — **Done** (2026-04-04): root + bridge sync for 6.0.3 and 5.2/5.3; root note points at package changelog.  
2. **`NEOHIVE_FULL_TOOLS` (I3, I15)** — **Done** in docs (removed false env; single tool list documented).  
3. **Tool counts + CONTRIBUTING/CLAUDE (I4, I8–I10)** — **Done** (70+ wording; paths; `lib/`).  
4. **`documentation.md` footer / data / `add_rule` (I5–I7)** — **Done**.  
5. **`mcp-tools-documentation.md` (I14, D3)** — still open.  
6. **SECURITY versions (I12)** — **Done**; **duplicate SECURITY files (D1)** — still open (policy only).

---

## Remediation applied (2026-04-04)

| Audit item | Action taken |
|------------|----------------|
| Changelog drift | **Root** `CHANGELOG.md` prepended with **6.0.3** + pointer to `agent-bridge/CHANGELOG.md`. **agent-bridge** changelog gained missing **5.3.0** / **5.2.0** sections (from root). |
| `NEOHIVE_FULL_TOOLS` | Removed from README / agent-bridge README; removed from `ai-onboarding.md`. |
| Tool counts / categories | README (both) unified category table; documentation hub, USAGE, VISION, CONTRIBUTING, CLAUDE updated. |
| `CONTRIBUTING.md` paths | `cd …/agent-bridge`, `lib/` in structure, plugin link → `neohive-plugin/README.md`. |
| `documentation.md` | Version **6.0.3**, **70+** tools, **`add_rule` `scope`**, data files (`notifications`, `push-requests`, `agent-cards`, `audit_log.jsonl`), footer, **mcp** / **serve** CLI, constants note for MCP vs dashboard limits. |
| `SECURITY.md` (both) | Supported-versions table updated for **6.x**. |
| `USAGE.md` | Version header, tool section title, `listen` description, CLI lines (`mcp`, `serve`, `reset --force`). |
| MCP SDK version string | `server.js` `Server({ version })` set to **6.0.3**; `cli.js` help banner **6.0.3**. |
| README doc table | Links to **ai-onboarding**, **documentation-audit**, dual changelog. |
| `mcp-tools-documentation.md` | Top banner → canonical **documentation.md**; **`workflow_status`** signature softened. |
| SECURITY LAN caveat | Both copies note **`--lan` / `NEOHIVE_LAN`** widens bind + token. |

**Still open (see tables above):** full merge vs delete of `mcp-tools-documentation.md`, duplicate SECURITY single-source strategy, `reference/cli.md` init flags (`--cursor` / `--vscode`), optional extra architecture doc (C2 — partly satisfied by `reference/architecture.md`).

**Split (2026-04-04):** `documentation.md` is a short hub; long sections moved to **`docs/reference/`** (see `reference/README.md`).

**Naming (2026-04-04):** `docs/*.md` uses **kebab-case** (`documentation.md`, `ai-onboarding.md`, …). **`README.md`** is the standard exception. Policy is recorded in **`docs/README.md`**.

---

## Maintenance

When adding an MCP tool or data file:

- Update **`docs/reference/tools.md`** and **`docs/reference/data-directory.md`** (and the hub if you add new top-level sections).
- Bump **`agent-bridge/CHANGELOG.md`** and keep **root** changelog in sync per policy (C1).
- Regenerate or adjust any **tool count** claims in README.
- If the tool is user-facing in CLI/dashboard, update **README** / **USAGE** / **ai-onboarding.md** as needed.

---

*This audit is a snapshot; re-run the methodology after large refactors (e.g. splitting `server.js`).*
