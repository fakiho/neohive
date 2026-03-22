const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// We'll use the existing server.js but we need to talk to it via MCP
// Since we are already an agent, we can just try to register again?
// No, the server.js toolRegister() prevents mid-session name changes for the SAME process.
// We need to spawn a NEW process.

function registerAgent(name) {
  return new Promise((resolve, reject) => {
    // We'll use a simple node script that tries to register via stdio MCP
    // But it's easier to just call toolRegister if we require it.
    // However, toolRegister is internal to server.js and not exported.
    // Let's check if it's exported.
    const serverCode = fs.readFileSync('agent-bridge/server.js', 'utf8');
    if (serverCode.includes('module.exports =')) {
        // ...
    }
  });
}

// Plan: 
// 1. Check if we can reclaim a name that is in agents.json but its PID is dead.
// 2. Check if we are blocked from claiming a name that is in agents.json and its PID is alive.

const AGENTS_FILE = '.neohive/agents.json';
if (!fs.existsSync(AGENTS_FILE)) {
    console.error('agents.json not found');
    process.exit(1);
}

const agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
console.log('Current agents:', Object.keys(agents));

// Find a dead agent if any
const deadAgentName = Object.keys(agents).find(name => {
    const a = agents[name];
    try { process.kill(a.pid, 0); return false; } catch { return true; }
});

if (deadAgentName) {
    console.log('Found dead agent:', deadAgentName);
    // Now we can't easily "register" from this script because we'd need to mock the whole MCP env.
    // But we can check if isPidAlive would return false.
} else {
    console.log('No dead agents found.');
}
