const fs = require('fs');
const path = require('path');

// Extract parseScope from dashboard.js
const dashboardCode = fs.readFileSync('agent-bridge/dashboard.js', 'utf8');
const parseScopeMatch = dashboardCode.match(/function parseScope\(scope\) \{([\s\S]+?)\n\}/);
if (!parseScopeMatch) {
    console.error('Could not find parseScope in dashboard.js');
    process.exit(1);
}

// Evaluate extracted function
const parseScope = new Function('scope', parseScopeMatch[1] + '\n return result;');

function test(input, expected) {
    const result = parseScope(input);
    const pass = JSON.stringify(result) === JSON.stringify(expected);
    console.log(`[${pass ? 'PASS' : 'FAIL'}] Input: ${JSON.stringify(input)} -> Result: ${JSON.stringify(result)}`);
    if (!pass) process.exit(1);
}

console.log('Testing parseScope:');

// 1. Object format
test({ role: 'coder', provider: 'claude', agent: 'Victor' }, { role: 'coder', provider: 'claude', agent: 'Victor' });
test({ role: 'Quality' }, { role: 'quality', provider: undefined, agent: undefined });

// 2. String format (type:value)
test('role:coder', { role: 'coder', provider: undefined, agent: undefined });
test('platform:gemini', { role: undefined, provider: 'gemini', agent: undefined });
test('provider:cursor', { role: undefined, provider: 'cursor', agent: undefined });
test('agent:Zak', { role: undefined, provider: undefined, agent: 'Zak' });

// 3. Special cases
test('global', { role: undefined, provider: undefined, agent: undefined });
test(null, { role: undefined, provider: undefined, agent: undefined });
test(undefined, { role: undefined, provider: undefined, agent: undefined });
test('invalid', { role: undefined, provider: undefined, agent: undefined });
test('type:too:many:parts', { role: undefined, provider: undefined, agent: undefined });

console.log('All tests passed!');
