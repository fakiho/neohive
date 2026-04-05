# Neohive — reference documentation

These files are **split from** the main hub **[`../documentation.md`](../documentation.md)** so each topic stays a manageable size. **Implementers** usually want **[tools.md](./tools.md)** or **[dashboard.md](./dashboard.md)**.

| File | Contents |
|------|----------|
| [architecture.md](./architecture.md) | Filesystem bus, process model, message lifecycle, `DATA_DIR` resolution |
| [tools.md](./tools.md) | Full MCP tool reference (~70+ tools) |
| [dashboard.md](./dashboard.md) | Web UI setup, SSE, REST API, CSRF/LAN |
| [cli.md](./cli.md) | `npx neohive` command reference |
| [data-directory.md](./data-directory.md) | `.neohive/` file catalog |
| [advanced.md](./advanced.md) | Autonomy engine, managed mode, branching, channels, templates |
| [configuration.md](./configuration.md) | Env vars, MCP config per CLI, limits/constants |
| [next-action-chain.md](./next-action-chain.md) | Unified `next_action` response chain, coordinator modes, agent flows |

**Maintenance:** Edit these files **directly**. [`../documentation.md`](../documentation.md) is the short hub with links here. The old one-shot splitter lives at [`../scripts/split-documentation.mjs`](../scripts/split-documentation.mjs) and **exits with an error** unless you restore a pre-split monolith from git history.
