# Cursor + Neohive hooks (QA reference)

Neohive ships **project hooks** under `.cursor/hooks.json` that call scripts in `agent-bridge/neohive-plugin/scripts/`. They align Composer’s loop closer to Claude Code’s post-tool / stop enforcement.

## What runs

| Hook | Script | Purpose |
|------|--------|---------|
| `beforeSubmitPrompt` | `cursor-before-prompt.sh` | Injects team + pending inbox preview; resolves `.neohive` via `workspace_roots[0]` or `NEOHIVE_DATA_DIR`. |
| `afterMCPExecution` | `cursor-post-mcp.sh` | Appends MCP tool lines to `.neohive/activity.jsonl`; injects **listen()** reminder after mutating tools (`send_message`, `update_task`, …). |
| `stop` | `cursor-stop.sh` | Blocks stop **only** if there is **pending non-system** inbox mail for the agent (preview + block). If the inbox is clear, allows stop even when the last tool was `send_message`. Emits `followup_message` + legacy `agentMessage` when blocking. |

Shared parsing: `cursor_hook_lib.py` (tool name normalization for `MCP: neohive:…` vs legacy shapes).

## Install / refresh

From the repo root:

```bash
cd agent-bridge && node cli.js cursor-hooks
```

Or: `npx neohive hooks` (merges Neohive entries into `.cursor/hooks.json`).

Reload the Cursor window after changes.

## QA plan (manual)

1. **Trusted workspace**  
   Open the repo in a **trusted** folder so project hooks execute.

2. **beforeSubmitPrompt**  
   - Ensure `.neohive/` exists and `agents.json` has at least one live PID (run MCP `register` once).  
   - Start a **new** Agent chat turn.  
   - **Expect:** extra context mentioning “Neohive team online” (or empty if no live PIDs).

3. **afterMCPExecution**  
   - Call Neohive MCP `send_message` (or `update_task`) from Agent.  
   - **Expect:** follow-up system text reminding to call `listen()` next.  
   - **Check:** `.neohive/activity.jsonl` gains a line with `mcp__neohive__send_message` (or similar).

4. **stop hook — pending mail**  
   - Register as `qa-hook-a`.  
   - From dashboard or another agent, send a **non-system** message to `qa-hook-a`.  
   - In Agent, call `send_message` then try to **end the turn** without `listen()`.  
   - **Expect:** stop blocked; injected text mentions pending messages; agent nudged to `listen()`.

5. **stop hook — empty inbox after send**  
   - Clear consumed / ensure no pending **non-system** mail for the test agent.  
   - Call `send_message`, then stop **without** `listen()`.  
   - **Expect:** stop **allowed** (no empty-inbox loop).

6. **stop hook — clean inbox**  
   - Call `get_briefing` only, then stop.  
   - **Expect:** stop **allowed** (read-only last tool).

7. **stop hook — listen last**  
   - Call `listen()` as last MCP tool, then stop.  
   - **Expect:** stop **allowed**.

8. **loop_limit**  
   Hooks config sets `loop_limit: 8` on `stop`. If the model ignores `listen()` repeatedly, Cursor stops forcing after several loops — **not a Neohive bug**. Increase only if your team accepts longer auto-loops.

9. **Coordinator mode**  
   Responsive coordinators may intentionally avoid blocking `listen()`; hooks still run. Use dashboard **coordinator_mode** + human judgment.

10. **Portable paths**  
   Clone repo to a **new path**, run `node agent-bridge/cli.js cursor-hooks`, confirm `.cursor/hooks.json` commands are **relative** to repo root (not `/Users/…`).

## Troubleshooting

- **Hooks never run:** Cursor version &lt; 1.7, untrusted workspace, or invalid `hooks.json` JSON.  
- **Wrong `.neohive`:** Set `NEOHIVE_DATA_DIR` in the MCP server env (matches dashboard).  
- **activity agent always `unknown`:** Only `register` logs a name; stop still keys off **last tool** + **consumed-&lt;agent&gt;.json** once `register` established the name in session.
