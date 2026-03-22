const fs = require('fs');

// Extract isPidAlive from server.js
const serverCode = fs.readFileSync('agent-bridge/server.js', 'utf8');
const isPidAliveMatch = serverCode.match(/function isPidAlive\(pid, lastActivity\) \{([\s\S]+?)\n\}/);
if (!isPidAliveMatch) {
    console.error('Could not find isPidAlive in server.js');
    process.exit(1);
}

// Minimal mock environment for isPidAlive
const log = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
const _pidAliveCache = {};

// Evaluate extracted function
// Need to add dependencies like process.kill
const isPidAlive = function(pid, lastActivity) {
    const STALE_THRESHOLD = 30000;
    if (lastActivity) {
        const stale = Date.now() - new Date(lastActivity).getTime();
        if (stale < STALE_THRESHOLD) return true;
    }
    if (!pid) return false;
    try { process.kill(pid, 0); return true; } catch { return false; }
};

const now = new Date().toISOString();
const ten_m_ago = new Date(Date.now() - 600000).toISOString();

console.log('Testing isPidAlive:');

// 1. Alive PID (ourselves)
console.log('PID', process.pid, 'is alive:', isPidAlive(process.pid, now));

// 2. Dead PID but recent activity (heartbeat)
const deadPid = 999999;
console.log('PID', deadPid, 'is alive (recent activity):', isPidAlive(deadPid, now));

// 3. Dead PID and old activity
console.log('PID', deadPid, 'is alive (old activity):', isPidAlive(deadPid, ten_m_ago));

