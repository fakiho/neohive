# Contributing to Neohive

Glad you're here. Contributions of any size are welcome — a typo fix is as useful as a new feature if it makes the project clearer.

Neohive is a solo project by Alionix. The server and CLI live in `agent-bridge/`, the npm package is `neohive`, and everything at runtime goes into `.neohive/` in your project. If you're coming from another MCP tool, heads up: Neohive is its own thing — different package, different data directory, different IDE integrations, different roadmap. [ROADMAP.md](ROADMAP.md) has the full picture.

## Ways to Contribute

- **Bug reports** — [Open an issue](https://github.com/fakiho/neohive/issues/new?template=bug_report.md) with steps to reproduce
- **Feature requests** — [Open an issue](https://github.com/fakiho/neohive/issues/new?template=feature_request.md) describing the use case
- **Code** — Fork, branch, implement, open a PR
- **Templates** — Create new agent team templates (drop a JSON in `templates/`)
- **Plugins** — Build custom tools using the plugin API
- **Docs** — Fix typos, improve explanations, add examples

## Development Setup

```bash
git clone https://github.com/fakiho/neohive.git
cd neohive/agent-bridge   # use your clone folder name if different
npm install

# Run the MCP server directly
npm start

# Run the dashboard in development mode (hot-reload)
NODE_ENV=development node dashboard.js

# Test the CLI
node cli.js help
node cli.js templates
```

## Project Structure

```
agent-bridge/
  server.js         # MCP server (70+ built-in tools; StdioServerTransport, heartbeats)
  lib/              # Shared modules (prefer new helpers here; server.js requires them)
  dashboard.js      # HTTP server (REST API + SSE)
  dashboard.html      # Single-page dashboard frontend (inline CSS/JS)
  cli.js              # CLI entry point (npx commands)
  templates/          # Agent team templates (JSON)
```

## Pull Request Guidelines

1. **One feature per PR** — keep changes focused
2. **Test your changes** — run the dashboard, test with two agents talking
3. **Update docs** — if you add a tool or feature, update the README and the relevant files under `docs/` (see **`docs/README.md`** for the hub layout and **kebab-case** file naming)
4. **Follow existing style** — CommonJS, no build step, no external frontend deps
5. **No breaking changes** — backward compatibility with existing `.neohive/` data
6. **Append-only writes** for message files (no read-modify-write on JSONL)

## Code Style

- Raw Node.js, CommonJS (`require` / `module.exports`)
- No TypeScript, no build step, no bundler
- Dashboard is a single HTML file with inline CSS/JS
- Minimize dependencies — currently only `@modelcontextprotocol/sdk`
- Each MCP tool should do one thing well

## Adding a Template

Create a JSON file in `templates/`:

```json
{
  "name": "my-template",
  "description": "What this team configuration does",
  "agents": [
    {
      "name": "AgentName",
      "role": "What this agent does",
      "prompt": "The full prompt to paste into the terminal"
    }
  ]
}
```

Test with: `node cli.js init --template my-template`

## Adding a Plugin

See [agent-bridge/neohive-plugin/README.md](agent-bridge/neohive-plugin/README.md) for the bundled Claude Code plugin. Dynamic plugins live under `.neohive/plugins/` and export `name`, `description`, `inputSchema`, and `handler` (see main [README](README.md) feature list for the `npx neohive plugin` CLI).

## Reporting Issues

Use the [GitHub issue templates](https://github.com/fakiho/neohive/issues/new/choose) for bug reports and feature requests.

## License

By contributing, you agree that your contributions will be licensed under the [Business Source License 1.1](LICENSE).
