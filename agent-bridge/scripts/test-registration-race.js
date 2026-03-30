const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

async function registerAgent(name) {
  return new Promise((resolve) => {
    // We use the CLI to register an agent under a name
    const cli = spawn('node', ['cli.js', 'register', name], {
      cwd: path.resolve(__dirname, '..'),
      env: { ...process.env, NEON_HIVE_NAME: name }
    });
    
    let output = '';
    cli.stdout.on('data', (data) => output += data.toString());
    cli.stderr.on('data', (data) => output += data.toString());
    
    cli.on('close', (code) => {
      resolve({ name, code, output });
    });
  });
}

async function runTest() {
  console.log('Starting concurrent registration test (10 agents)...');
  const agents = Array.from({ length: 10 }, (_, i) => `TestAgent_${i}`);
  
  // Run all registrations simultaneously
  const results = await Promise.all(agents.map(name => registerAgent(name)));
  
  console.log('Results:');
  const failures = results.filter(r => r.code !== 0);
  if (failures.length > 0) {
    console.log(`Failed registrations: ${failures.length}`);
  } else {
    console.log('All CLI commands exited with code 0.');
  }

  // Check .neohive/agents.json
  const agentsJsonPath = path.resolve(__dirname, '../.neohive/agents.json');
  if (fs.existsSync(agentsJsonPath)) {
    const data = JSON.parse(fs.readFileSync(agentsJsonPath, 'utf8'));
    const registeredCount = Object.keys(data).filter(k => k.startsWith('TestAgent_')).length;
    console.log(`Agents found in registry: ${registeredCount}/10`);
    
    if (registeredCount === 10) {
      console.log('SUCCESS: All 10 agents survived the race condition.');
    } else {
      console.log('FAILURE: Some agents were overwritten.');
      if (failures.length > 0) {
        console.log('Sample failure output:', failures[0].output);
      }
    }
  } else {
    console.log('ERROR: .neohive/agents.json not found at ' + agentsJsonPath);
  }
}

runTest();
