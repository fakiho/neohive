'use strict';

// Safety tools: file locking, dependencies.
// Extracted from server.js as part of modular tool architecture.

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;

  const {
    getLocks, getAgents, isPidAlive, getTasks, getDeps,
    generateId, writeJsonFile, touchActivity,
  } = helpers;

  const { LOCKS_FILE, DEPS_FILE } = files;

  // --- File Locking ---

  function toolLockFile(filePath) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof filePath !== 'string' || filePath.length < 1 || filePath.length > 200) return { error: 'Invalid file path' };

    const normalized = filePath.replace(/\\/g, '/');
    const locks = getLocks();

    if (locks[normalized]) {
      const holder = locks[normalized].agent;
      if (holder === state.registeredName) return { success: true, message: 'You already hold this lock.', file: normalized };
      const agents = getAgents();
      if (agents[holder] && isPidAlive(agents[holder].pid, agents[holder].last_activity)) {
        return { error: `File "${normalized}" is locked by ${holder} since ${locks[normalized].since}. Wait for them to unlock it or message them.` };
      }
    }

    locks[normalized] = { agent: state.registeredName, since: new Date().toISOString() };
    writeJsonFile(LOCKS_FILE, locks);
    touchActivity();
    return { success: true, file: normalized, next_action: 'Edit the file, then call unlock_file() when done.' };
  }

  function toolUnlockFile(filePath) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    const normalized = (filePath || '').replace(/\\/g, '/');
    const locks = getLocks();

    if (!filePath) {
      let count = 0;
      for (const [fp, lock] of Object.entries(locks)) {
        if (lock.agent === state.registeredName) { delete locks[fp]; count++; }
      }
      writeJsonFile(LOCKS_FILE, locks);
      return { success: true, unlocked: count, message: `Unlocked ${count} file(s).`, next_action: 'Call listen() to receive messages.' };
    }

    if (!locks[normalized]) return { success: true, message: 'File was not locked.', next_action: 'Call listen() to receive messages.' };
    if (locks[normalized].agent !== state.registeredName) return { error: `File is locked by ${locks[normalized].agent}, not you.` };

    delete locks[normalized];
    writeJsonFile(LOCKS_FILE, locks);
    return { success: true, file: normalized, message: 'File unlocked.', next_action: 'Call listen() to receive messages.' };
  }

  // --- Dependencies ---

  function toolDeclareDependency(taskId, dependsOnTaskId) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const tasks = getTasks();
    const task = tasks.find(t => t.id === taskId);
    const depTask = tasks.find(t => t.id === dependsOnTaskId);
    if (!task) return { error: `Task not found: ${taskId}` };
    if (!depTask) return { error: `Dependency task not found: ${dependsOnTaskId}` };

    const deps = getDeps();
    if (deps.length >= 1000) return { error: 'Dependency limit reached (max 1000).' };
    deps.push({
      id: 'dep_' + generateId(),
      task_id: taskId,
      depends_on: dependsOnTaskId,
      declared_by: state.registeredName,
      declared_at: new Date().toISOString(),
      resolved: depTask.status === 'done',
    });
    writeJsonFile(DEPS_FILE, deps);
    touchActivity();

    if (depTask.status === 'done') {
      return { success: true, message: `Dependency declared but already resolved — "${depTask.title}" is done. You can proceed.` };
    }
    return { success: true, message: `Dependency declared: "${task.title}" is blocked until "${depTask.title}" is done. You'll be notified when it completes.` };
  }

  function toolCheckDependencies(taskId) {
    const deps = getDeps();
    const tasks = getTasks();

    if (taskId) {
      const taskDeps = deps.filter(d => d.task_id === taskId);
      return {
        task_id: taskId,
        dependencies: taskDeps.map(d => {
          const t = tasks.find(t2 => t2.id === d.depends_on);
          return { depends_on: d.depends_on, title: t ? t.title : 'unknown', status: t ? t.status : 'unknown', resolved: t ? t.status === 'done' : false };
        }),
      };
    }
    const unresolved = deps.filter(d => {
      const t = tasks.find(t2 => t2.id === d.depends_on);
      return t && t.status !== 'done';
    });
    return { unresolved_count: unresolved.length, unresolved: unresolved.map(d => ({ task_id: d.task_id, blocked_by: d.depends_on })) };
  }

  const definitions = [
    {
      name: 'lock_file',
      description: 'Lock a file for exclusive editing. Other agents will be warned if they try to edit it. Call unlock_file() when done. Locks auto-release if you disconnect.',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: 'Relative path to the file to lock' } }, required: ['file_path'], additionalProperties: false },
    },
    {
      name: 'unlock_file',
      description: 'Unlock a file you previously locked. Omit file_path to unlock all your files.',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: 'File to unlock (optional — omit to unlock all)' } }, additionalProperties: false },
    },
    {
      name: 'declare_dependency',
      description: 'Declare that a task depends on another task. You will be notified when the dependency is complete.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Your task that is blocked' }, depends_on: { type: 'string', description: 'Task ID that must complete first' } }, required: ['task_id', 'depends_on'], additionalProperties: false },
    },
    {
      name: 'check_dependencies',
      description: 'Check dependency status for a task or all unresolved dependencies.',
      inputSchema: { type: 'object', properties: { task_id: { type: 'string', description: 'Task ID to check (optional — omit for all unresolved)' } }, additionalProperties: false },
    },
  ];

  const handlers = {
    lock_file: function (args) { return toolLockFile(args.file_path); },
    unlock_file: function (args) { return toolUnlockFile(args.file_path); },
    declare_dependency: function (args) { return toolDeclareDependency(args.task_id, args.depends_on); },
    check_dependencies: function (args) { return toolCheckDependencies(args.task_id); },
  };

  return { definitions, handlers };
};
