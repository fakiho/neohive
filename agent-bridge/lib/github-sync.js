'use strict';

// GitHub Projects v2 sync — mirrors neohive tasks to a GitHub Project board.
// Uses GraphQL API with draft issues. One-way sync (neohive → GitHub).
//
// Configuration (any of these sources):
//   1. GITHUB_TOKEN + GITHUB_PROJECT_ID env vars
//   2. .neohive/config.json → { github: { token, project_id, org, status_field_id, status_options } }
//
// When unconfigured, all functions are no-ops (graceful degradation).

const https = require('https');
const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('./config');
const log = require('./logger');

// --- Config ---

function getGitHubConfig() {
  const config = { token: null, project_id: null, org: null, status_field_id: null, status_options: {} };

  // Env vars take priority
  if (process.env.GITHUB_TOKEN) config.token = process.env.GITHUB_TOKEN;
  if (process.env.GITHUB_PROJECT_ID) config.project_id = process.env.GITHUB_PROJECT_ID;

  // Fall back to .neohive/config.json
  const configFile = path.join(DATA_DIR, 'config.json');
  if (fs.existsSync(configFile)) {
    try {
      const fileConfig = JSON.parse(fs.readFileSync(configFile, 'utf8'));
      if (fileConfig.github) {
        if (!config.token && fileConfig.github.token) config.token = fileConfig.github.token;
        if (!config.project_id && fileConfig.github.project_id) config.project_id = fileConfig.github.project_id;
        if (fileConfig.github.org) config.org = fileConfig.github.org;
        if (fileConfig.github.status_field_id) config.status_field_id = fileConfig.github.status_field_id;
        if (fileConfig.github.status_options) config.status_options = fileConfig.github.status_options;
      }
    } catch (e) { log.debug('github-sync: failed to read config:', e.message); }
  }

  return config;
}

function isConfigured() {
  const config = getGitHubConfig();
  return !!(config.token && config.project_id);
}

// --- GraphQL client ---

function graphql(token, query, variables) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ query, variables: variables || {} });
    const req = https.request({
      hostname: 'api.github.com',
      path: '/graphql',
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'neohive-github-sync',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          if (parsed.errors) {
            reject(new Error(parsed.errors.map(e => e.message).join('; ')));
          } else {
            resolve(parsed);
          }
        } catch (e) {
          reject(new Error('Invalid JSON response from GitHub API'));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('GitHub API timeout')); });
    req.write(data);
    req.end();
  });
}

// --- Sync mapping file ---
// Tracks neohive task ID → GitHub project item ID mapping

const SYNC_MAP_FILE = path.join(DATA_DIR, 'github-sync-map.json');

function getSyncMap() {
  if (!fs.existsSync(SYNC_MAP_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(SYNC_MAP_FILE, 'utf8')); } catch { return {}; }
}

function saveSyncMap(map) {
  fs.writeFileSync(SYNC_MAP_FILE, JSON.stringify(map, null, 2));
}

// --- Status mapping ---

const DEFAULT_STATUS_MAP = {
  pending: 'Todo',
  in_progress: 'In Progress',
  in_review: 'In Review',
  done: 'Done',
  blocked: 'Blocked',
  blocked_permanent: 'Blocked',
};

// --- Core sync functions ---

/**
 * Sync a single task to GitHub Projects.
 * Creates a draft issue if new, updates status field if existing.
 * Non-blocking — errors are logged but not thrown.
 */
async function syncTask(task) {
  if (!isConfigured()) return null;

  const config = getGitHubConfig();
  const syncMap = getSyncMap();

  try {
    const itemId = syncMap[task.id];

    if (!itemId) {
      // New task — create draft issue
      const body = [
        task.description || '',
        '',
        `---`,
        `Neohive ID: \`${task.id}\``,
        task.assignee ? `Assignee: ${task.assignee}` : '',
        `Status: ${task.status}`,
        `Created by: ${task.created_by || 'unknown'}`,
      ].filter(Boolean).join('\n');

      const result = await graphql(config.token,
        `mutation($projectId: ID!, $title: String!, $body: String) {
          addProjectV2DraftIssue(input: {projectId: $projectId, title: $title, body: $body}) {
            projectItem { id }
          }
        }`,
        { projectId: config.project_id, title: task.title, body }
      );

      const newItemId = result.data.addProjectV2DraftIssue.projectItem.id;
      syncMap[task.id] = newItemId;
      saveSyncMap(syncMap);

      log.info(`github-sync: created draft issue for task "${task.title}" → ${newItemId}`);

      // Update status field if configured
      if (config.status_field_id && config.status_options[task.status]) {
        await updateStatusField(config, newItemId, task.status);
      }

      return { action: 'created', item_id: newItemId };
    } else {
      // Existing task — update status field
      if (config.status_field_id && config.status_options[task.status]) {
        await updateStatusField(config, itemId, task.status);
        log.info(`github-sync: updated status for "${task.title}" → ${task.status}`);
        return { action: 'updated', item_id: itemId, status: task.status };
      }
      return { action: 'no_update', item_id: itemId, reason: 'status field not configured' };
    }
  } catch (e) {
    log.warn(`github-sync: failed to sync task "${task.title}":`, e.message);
    return { action: 'error', error: e.message };
  }
}

async function updateStatusField(config, itemId, status) {
  const optionId = config.status_options[status];
  if (!optionId) return;

  await graphql(config.token,
    `mutation($projectId: ID!, $itemId: ID!, $fieldId: ID!, $optionId: String!) {
      updateProjectV2ItemFieldValue(input: {
        projectId: $projectId, itemId: $itemId,
        fieldId: $fieldId, value: {singleSelectOptionId: $optionId}
      }) { projectV2Item { id } }
    }`,
    { projectId: config.project_id, itemId, fieldId: config.status_field_id, optionId }
  );
}

/**
 * Sync all tasks from tasks.json to GitHub Projects.
 * Creates missing items, updates status for existing ones.
 */
async function syncAllTasks() {
  if (!isConfigured()) return { error: 'GitHub sync not configured. Set GITHUB_TOKEN and GITHUB_PROJECT_ID.' };

  const tasksFile = path.join(DATA_DIR, 'tasks.json');
  if (!fs.existsSync(tasksFile)) return { error: 'No tasks.json found' };

  let tasks;
  try { tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch { return { error: 'Invalid tasks.json' }; }

  const results = { created: 0, updated: 0, errors: 0, skipped: 0 };
  for (const task of tasks) {
    const result = await syncTask(task);
    if (!result) { results.skipped++; continue; }
    if (result.action === 'created') results.created++;
    else if (result.action === 'updated') results.updated++;
    else if (result.action === 'error') results.errors++;
    else results.skipped++;
  }

  return { success: true, ...results, total: tasks.length };
}

/**
 * Discover project fields — helper for initial setup.
 * Returns field IDs and single-select options for status mapping.
 */
async function discoverFields() {
  if (!isConfigured()) return { error: 'GitHub sync not configured.' };

  const config = getGitHubConfig();
  const result = await graphql(config.token,
    `query($projectId: ID!) {
      node(id: $projectId) {
        ... on ProjectV2 {
          title
          fields(first: 20) {
            nodes {
              ... on ProjectV2FieldCommon { id name }
              ... on ProjectV2SingleSelectField {
                id name
                options { id name }
              }
            }
          }
        }
      }
    }`,
    { projectId: config.project_id }
  );

  const project = result.data.node;
  return {
    project_title: project.title,
    fields: project.fields.nodes.map(f => ({
      id: f.id,
      name: f.name,
      ...(f.options && { options: f.options }),
    })),
    hint: 'Find the Status field, copy its id to github.status_field_id in .neohive/config.json. Map each status option id to github.status_options: { "pending": "OPTION_ID", "in_progress": "OPTION_ID", ... }',
  };
}

/**
 * Get sync status — how many tasks are synced, unsynced, stale.
 */
function getSyncStatus() {
  const configured = isConfigured();
  const syncMap = getSyncMap();
  const tasksFile = path.join(DATA_DIR, 'tasks.json');
  let tasks = [];
  if (fs.existsSync(tasksFile)) {
    try { tasks = JSON.parse(fs.readFileSync(tasksFile, 'utf8')); } catch {}
  }

  const synced = tasks.filter(t => syncMap[t.id]).length;
  const unsynced = tasks.filter(t => !syncMap[t.id]).length;

  return {
    configured,
    total_tasks: tasks.length,
    synced,
    unsynced,
    sync_map_entries: Object.keys(syncMap).length,
    status_mapping: DEFAULT_STATUS_MAP,
  };
}

module.exports = {
  isConfigured,
  getGitHubConfig,
  syncTask,
  syncAllTasks,
  discoverFields,
  getSyncStatus,
  DEFAULT_STATUS_MAP,
};
