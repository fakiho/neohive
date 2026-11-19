'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');

async function run() {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neohive-bmad-mcp-'));
  const dataDir = path.join(projectDir, '.neohive');
  fs.mkdirSync(path.join(projectDir, '_bmad', '_config'), { recursive: true });
  fs.mkdirSync(path.join(projectDir, '_bmad-output', 'planning-artifacts'), { recursive: true });
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(path.join(projectDir, '_bmad', '_config', 'manifest.yaml'), 'version: 6.10.0\nmodules:\n  - name: bmm\n    version: 6.10.0\n');
  fs.writeFileSync(path.join(projectDir, '_bmad-output', 'planning-artifacts', 'prd.md'), '# PRD\n');
  fs.writeFileSync(path.join(dataDir, 'config.json'), JSON.stringify({
    methodologies: { bmad: { enabled: true, mode: 'full', workflow: 'bmad-architecture' } },
  }));

  const client = new Client({ name: 'neohive-bmad-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.resolve(__dirname, '..', 'server.js')],
    env: { NEOHIVE_DATA_DIR: dataDir, NEOHIVE_PROJECT_ROOT: projectDir, NEOHIVE_LOG_LEVEL: 'error' },
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const listed = await client.listTools();
    const names = listed.tools.map(tool => tool.name);
    assert.ok(names.includes('methodology_status'));
    assert.ok(names.includes('methodology_next_action'));
    assert.ok(names.includes('methodology_artifacts'));

    await client.callTool({ name: 'register', arguments: { name: 'BmadTest' } });
    const statusResult = await client.callTool({ name: 'methodology_status', arguments: {} });
    const status = JSON.parse(statusResult.content[0].text);
    assert.strictEqual(status.installed, true);
    assert.strictEqual(status.enabled, true);
    assert.strictEqual(status.recommended_action.workflow, 'bmad-architecture');
    assert.match(status.next_action, /bmad-architecture/);

    const artifactResult = await client.callTool({ name: 'methodology_artifacts', arguments: { kind: 'prd' } });
    const artifacts = JSON.parse(artifactResult.content[0].text);
    assert.strictEqual(artifacts.count, 1);

    const briefingResult = await client.callTool({ name: 'get_briefing', arguments: {} });
    const briefing = JSON.parse(briefingResult.content[0].text);
    assert.strictEqual(briefing.methodology.id, 'bmad');
    assert.strictEqual(briefing.methodology.next_action.workflow, 'bmad-architecture');
    console.log('BMAD MCP tool tests passed');
  } finally {
    await transport.close().catch(() => {});
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
