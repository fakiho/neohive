
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(process.cwd(), '.neohive');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');

function register() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }

  const name = 'Reviewer';
  const now = new Date().toISOString();
  
  // Register agent
  let agents = {};
  if (fs.existsSync(AGENTS_FILE)) {
    agents = JSON.parse(fs.readFileSync(AGENTS_FILE, 'utf8'));
  }
  agents[name] = {
    pid: process.pid,
    timestamp: now,
    last_activity: now,
    provider: 'Gemini',
    branch: 'main',
    token: Math.random().toString(36).slice(2),
    started_at: now
  };
  fs.writeFileSync(AGENTS_FILE, JSON.stringify(agents, null, 2));

  // Create profile
  let profiles = {};
  if (fs.existsSync(PROFILES_FILE)) {
    profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  }
  if (!profiles[name]) {
    profiles[name] = {
      display_name: name,
      avatar: '',
      bio: 'Code reviewer',
      role: 'reviewer',
      created_at: now,
      role_description: 'You review code submissions and provide feedback.'
    };
    fs.writeFileSync(PROFILES_FILE, JSON.stringify(profiles, null, 2));
  }

  // Heartbeat
  fs.writeFileSync(path.join(DATA_DIR, `heartbeat-${name}.json`), JSON.stringify({
    last_activity: now,
    pid: process.pid
  }));

  console.log(`Registered as ${name}`);
}

register();
