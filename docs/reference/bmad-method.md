> [Documentation hub](../documentation.md) · [Reference index](./README.md)

# BMad Method compatibility

Neohive can install and orchestrate projects that use BMad Method v6. The integration is optional: Neohive continues to require Node.js 18+, while the upstream BMad installer is invoked only when requested and requires Node.js 20.12+, Python 3.10+, `uv`, Git, and `npx`.

## Install and update

From a project root:

```bash
npx neohive bmad status
npx neohive bmad install
npx neohive bmad update
```

Use `--runtimes claude,cursor` (also `gemini` or `codex`) when automatic CLI detection is not appropriate. The dashboard Launch view provides the same status, prerequisite, install, and update actions.

Neohive invokes the stable upstream `bmad-method@^6` installer through an argument array, never a shell command string. Fresh installs select the `bmm` module and requested tools. Updates use BMad's non-interactive `quick-update` action.

## State ownership

There is one authority for each kind of state:

| State | Authority |
|---|---|
| BMad installation and configuration | `_bmad/` |
| PRDs, architecture, stories, sprint status, and gates | `_bmad-output/` |
| Agent registration, assignments, messages, locks, and execution notes | `.neohive/` |

The dashboard projects BMad lifecycle state read-only. It does not copy BMad story or phase status into `tasks.json` or `workflows.json`. A Neohive execution task may use an `external_ref` such as `bmad:story:story-one`; that reference links an assignee to the authoritative BMad story without creating a second status authority.

## Agent launching

The launcher offers:

- **None** — normal Neohive role behavior.
- **BMad Method / Quick** — `bmad-quick-dev` or `bmad-dev-auto`.
- **BMad Method / Full** — analysis, planning, solutioning, and implementation workflows.

The server composes the final prompt from the selected Neohive role and BMad workflow. BMad agents must call `methodology_status()` and load the installed BMad skill before methodology work. Neohive remains responsible for multi-agent coordination, so BMad Party Mode and BMad-spawned subagents are disabled by the launch contract.

Executable BMad workflows are supported for native Claude Code, Gemini CLI, Codex CLI, Cursor Agent, and full Claude Code via Ollama. The lightweight Ollama responder has no filesystem, shell, MCP, or skill loader and is rejected when BMad is selected.

## Lifecycle projection

The dashboard and MCP tools expose:

- installed and compatible BMad version;
- Quick or Full mode and selected workflow;
- analysis, planning, solutioning, and implementation phases;
- sprint stories and linked Neohive assignments;
- readiness/review gate artifacts;
- relative artifact paths, timestamps, sizes, and hashes;
- a recommended next workflow.

Use these MCP tools:

| Tool | Purpose |
|---|---|
| `methodology_status` | Full lifecycle, compatibility, story, gate, and next-action status |
| `methodology_next_action` | Compact recommended workflow |
| `methodology_artifacts` | Filtered authoritative artifact references |

Nested `_bmad-output/` changes are detected by a debounced fingerprint poller because Linux does not support portable recursive `fs.watch()`. Watcher callbacks never write to BMad files.

## Recovery and removal

- If installation fails, Neohive does not enable the integration or overwrite its previous project settings. Inspect the upstream installer output and rerun the action.
- BMad updates preserve `_bmad-output/`; Neohive never deletes it.
- To stop launching BMad agents, disable the methodology in the dashboard or choose **None** in the launcher.
- Remove `_bmad/` or `_bmad-output/` only by following upstream BMad guidance. Neohive intentionally has no destructive uninstall endpoint.

## License and naming

BMad Method's software is MIT licensed. BMad names and logos are trademarks of BMad Code, LLC and are not covered by that software license. Neohive describes this feature as **“Compatible with BMad Method v6”** and does not claim endorsement, certification, or partnership.
