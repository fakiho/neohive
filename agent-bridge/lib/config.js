'use strict';

const fs = require('fs');
const path = require('path');

// Data dir lives in the project where the CLI runs, not where the package is installed
const DATA_DIR = process.env.NEOHIVE_DATA_DIR || path.join(process.cwd(), '.neohive');

// File paths for all shared data
const MESSAGES_FILE = path.join(DATA_DIR, 'messages.jsonl');
const HISTORY_FILE = path.join(DATA_DIR, 'history.jsonl');
const AGENTS_FILE = path.join(DATA_DIR, 'agents.json');
const ACKS_FILE = path.join(DATA_DIR, 'acks.json');
const TASKS_FILE = path.join(DATA_DIR, 'tasks.json');
const PROFILES_FILE = path.join(DATA_DIR, 'profiles.json');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');
const WORKSPACES_DIR = path.join(DATA_DIR, 'workspaces');
const BRANCHES_FILE = path.join(DATA_DIR, 'branches.json');
const DECISIONS_FILE = path.join(DATA_DIR, 'decisions.json');
const KB_FILE = path.join(DATA_DIR, 'kb.json');
const LOCKS_FILE = path.join(DATA_DIR, 'locks.json');
const PROGRESS_FILE = path.join(DATA_DIR, 'progress.json');
const VOTES_FILE = path.join(DATA_DIR, 'votes.json');
const REVIEWS_FILE = path.join(DATA_DIR, 'reviews.json');
const DEPS_FILE = path.join(DATA_DIR, 'dependencies.json');
const REPUTATION_FILE = path.join(DATA_DIR, 'reputation.json');
const COMPRESSED_FILE = path.join(DATA_DIR, 'compressed.json');
const RULES_FILE = path.join(DATA_DIR, 'rules.json');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PERMISSIONS_FILE = path.join(DATA_DIR, 'permissions.json');
const READ_RECEIPTS_FILE = path.join(DATA_DIR, 'read_receipts.json');
const DATA_VERSION_FILE = path.join(DATA_DIR, '.version');
const CHANNELS_FILE_PATH = path.join(DATA_DIR, 'channels.json');

// Constants
const MAX_CONTENT_BYTES = 1000000; // 1 MB max message size
const CURRENT_DATA_VERSION = 1;
const RESERVED_NAMES = ['__system__', '__all__', '__open__', '__close__', '__user__', 'system', 'dashboard', 'Dashboard'];

// Config helpers
function getConfig() {
  if (!fs.existsSync(CONFIG_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch { return {}; }
}

function saveConfig(config) {
  ensureDataDir();
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config));
}

function isGroupMode() {
  return getConfig().conversation_mode === 'group';
}

function isManagedMode() {
  return getConfig().conversation_mode === 'managed';
}

function getManagedConfig() {
  const config = getConfig();
  return config.managed || {
    manager: null,
    phase: 'discussion',
    floor: 'closed',
    turn_queue: [],
    turn_current: null,
    phase_history: [],
  };
}

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  }
}

function sanitizeName(name) {
  if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,20}$/.test(name)) {
    throw new Error(`Invalid name "${name}": must be 1-20 alphanumeric/underscore/hyphen chars`);
  }
  if (RESERVED_NAMES.includes(name.toLowerCase())) {
    throw new Error(`Name "${name}" is reserved and cannot be used`);
  }
  return name;
}

function generateId() {
  try { return Date.now().toString(36) + require('crypto').randomBytes(6).toString('hex'); }
  catch { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
}

function generateToken() {
  try { return require('crypto').randomBytes(16).toString('hex'); }
  catch { return Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2); }
}

function validateContentSize(content) {
  if (typeof content !== 'string') return { error: 'content must be a string' };
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
    return { error: 'Message content exceeds maximum size (1 MB)' };
  }
  return null;
}

function getMessagesFile(branch) {
  if (!branch || branch === 'main') return MESSAGES_FILE;
  return path.join(DATA_DIR, `branch-${sanitizeName(branch)}-messages.jsonl`);
}

function getHistoryFile(branch) {
  if (!branch || branch === 'main') return HISTORY_FILE;
  return path.join(DATA_DIR, `branch-${sanitizeName(branch)}-history.jsonl`);
}

module.exports = {
  DATA_DIR,
  MESSAGES_FILE, HISTORY_FILE, AGENTS_FILE, ACKS_FILE, TASKS_FILE,
  PROFILES_FILE, WORKFLOWS_FILE, WORKSPACES_DIR, BRANCHES_FILE,
  DECISIONS_FILE, KB_FILE, LOCKS_FILE, PROGRESS_FILE, VOTES_FILE,
  REVIEWS_FILE, DEPS_FILE, REPUTATION_FILE, COMPRESSED_FILE, RULES_FILE,
  CONFIG_FILE, PERMISSIONS_FILE, READ_RECEIPTS_FILE, DATA_VERSION_FILE,
  CHANNELS_FILE_PATH,
  MAX_CONTENT_BYTES, CURRENT_DATA_VERSION, RESERVED_NAMES,
  getConfig, saveConfig, isGroupMode, isManagedMode, getManagedConfig,
  ensureDataDir, sanitizeName, generateId, generateToken, validateContentSize,
  getMessagesFile, getHistoryFile,
};
