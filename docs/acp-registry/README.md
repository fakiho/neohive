# ACP Registry submission (draft)

This folder holds a **draft** [`agent.json`](./agent.json) for submitting Neohive to the [Agent Client Protocol Registry](https://agentclientprotocol.com/get-started/registry.md).

## Steps

1. Confirm Zed smoke tests pass with `npx neohive init --acp` and `acp-agent.mjs`.
2. Open a pull request against [`agentclientprotocol/registry`](https://github.com/agentclientprotocol/registry) adding the Neohive entry per registry maintainer instructions (often `agents/<id>/agent.json` plus optional `icon.svg`).
3. Adjust `agent.json` fields (version, description) to match the published npm package at submit time.

The registry manifest shape differs from **Zed IDE** `.zed/acp.json` (`agent_servers`); see the root [README](../README.md) **Zed + ACP** section.
