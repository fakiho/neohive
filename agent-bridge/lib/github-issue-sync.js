'use strict';

// GitHub Issues → neohive tasks mirror (pull direction).
//
// Uses the `gh` CLI, which the user authenticates themselves via `gh auth login`.
// Neohive never stores, reads, or transmits a GitHub token — if `gh` isn't
// installed or isn't authenticated, `gh` itself fails and this module just
// no-ops (errors are swallowed; see pollIfDue).
//
// Opt-in only: disabled unless .neohive/config.json has
//   { "github_issue_sync": { "enabled": true, "poll_interval_minutes": 5, "repo": "org/repo" } }
// "repo" is optional — when omitted, `gh` auto-detects it from the git remote.

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

module.exports = function (ctx) {
  const { helpers, DATA_DIR } = ctx;
  const { getTasks, saveTasks, generateId, broadcastSystemMessage } = helpers;

  const SYNC_MAP_FILE = path.join(DATA_DIR, 'github-issue-sync-map.json');
  const POLL_MARKER_FILE = path.join(DATA_DIR, '.last-github-issue-poll');
  const CONFIG_FILE = path.join(DATA_DIR, 'config.json');

  function getSyncConfig() {
    if (!fs.existsSync(CONFIG_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')).github_issue_sync || {}; }
    catch { return {}; }
  }

  function getSyncMap() {
    if (!fs.existsSync(SYNC_MAP_FILE)) return {};
    try { return JSON.parse(fs.readFileSync(SYNC_MAP_FILE, 'utf8')); } catch { return {}; }
  }

  function saveSyncMap(map) {
    fs.writeFileSync(SYNC_MAP_FILE, JSON.stringify(map, null, 2));
  }

  function runGh(args) {
    return new Promise((resolve, reject) => {
      execFile('gh', args, { timeout: 15000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(stderr || err.message));
        resolve(stdout);
      });
    });
  }

  async function fetchIssues(repo) {
    const args = ['issue', 'list', '--state', 'all', '--limit', '200',
      '--json', 'number,title,body,labels,url,state,updatedAt'];
    if (repo) args.push('--repo', repo);
    const out = await runGh(args);
    return JSON.parse(out);
  }

  function buildDescription(issue) {
    const labels = (issue.labels || []).map(l => l.name).join(', ');
    return [
      issue.body || '',
      '',
      '---',
      `GitHub issue: #${issue.number}`,
      labels ? `Labels: ${labels}` : '',
      `URL: ${issue.url}`,
    ].filter(Boolean).join('\n');
  }

  async function syncAllIssues(repoOverride) {
    const config = getSyncConfig();
    const targetRepo = repoOverride || config.repo || null;

    let issues;
    try {
      issues = await fetchIssues(targetRepo);
    } catch (e) {
      return { error: 'gh issue list failed: ' + e.message };
    }

    const tasks = getTasks();
    const syncMap = getSyncMap();
    const results = { created: 0, closed: 0, skipped: 0 };
    const newlyCreated = [];

    for (const issue of issues) {
      const key = String(issue.number);
      const existingTaskId = syncMap[key];
      const isOpen = String(issue.state).toUpperCase() === 'OPEN';

      if (isOpen) {
        if (existingTaskId) {
          results.skipped++;
          continue;
        }
        const task = {
          id: 'task_' + generateId(),
          title: `#${issue.number} ${issue.title}`,
          description: buildDescription(issue),
          status: 'pending',
          assignee: null,
          created_by: 'github-sync',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          notes: [],
        };
        tasks.push(task);
        syncMap[key] = task.id;
        results.created++;
        newlyCreated.push({ issue, task });
      } else if (existingTaskId) {
        const task = tasks.find(t => t.id === existingTaskId);
        if (task && task.status !== 'done') {
          task.status = 'done';
          task.updated_at = new Date().toISOString();
          results.closed++;
        }
      }
    }

    if (results.created > 0 || results.closed > 0) {
      saveTasks(tasks);
      saveSyncMap(syncMap);
    }

    for (const { issue, task } of newlyCreated) {
      try { broadcastSystemMessage(`[NEW ISSUE] #${issue.number} "${issue.title}" → task ${task.id} created from GitHub`); }
      catch (e) { /* messaging is best-effort; sync already succeeded */ }
    }

    return { success: true, ...results, total_issues: issues.length };
  }

  function isDue(intervalMinutes) {
    let last = 0;
    if (fs.existsSync(POLL_MARKER_FILE)) {
      try { last = parseInt(fs.readFileSync(POLL_MARKER_FILE, 'utf8').trim()) || 0; } catch (e) { /* treat as never polled */ }
    }
    return (Date.now() - last) >= intervalMinutes * 60000;
  }

  function claimPoll() {
    fs.writeFileSync(POLL_MARKER_FILE, String(Date.now()));
  }

  // Called every heartbeat tick from every registered agent's process. Self-throttles
  // via a shared timestamp file (claimed optimistically) so only one process's tick
  // actually calls `gh` per interval, mirroring triggerStandupIfDue()'s pattern.
  function pollIfDue() {
    const config = getSyncConfig();
    if (!config.enabled) return;
    const intervalMinutes = config.poll_interval_minutes || 5;
    if (!isDue(intervalMinutes)) return;
    claimPoll();
    syncAllIssues(config.repo).catch(() => {});
  }

  return { syncAllIssues, pollIfDue, getSyncConfig };
};
