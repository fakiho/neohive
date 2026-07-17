'use strict';

// Task management tools: create, update, list, suggest.
// Extracted from server.js as part of modular tool architecture.

const fs = require('fs');
const { invalidateCache, readJsonFile, withFileLock } = require('../lib/file-io');

const ACTIVE_EXTERNAL_REF_STATUSES = new Set(['pending', 'in_progress', 'in_review', 'blocked']);

function readTasksFresh(file) {
  const tasks = readJsonFile(file);
  return Array.isArray(tasks) ? tasks : [];
}

function saveTasksLocked(file, tasks) {
  const tmp = `${file}.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(tasks));
  fs.renameSync(tmp, file);
  invalidateCache('tasks');
}

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;

  const {
    getTasks, getAgents, isPidAlive, generateId, writeJsonFile,
    broadcastSystemMessage, sendSystemMessage, touchActivity, fireEvent,
    ensureDataDir, getProfiles, getReviews, getReputation, getDeps,
    getChannelsData, saveChannelsData, isGroupMode,
    getWorkspace, saveWorkspace, appendNotification,
    getWorkflows, saveWorkflows, saveWorkflowCheckpoint, findReadySteps,
    getMessagesFile, getHistoryFile, logViolation, cachedRead,
    enqueueDurableDelivery,
  } = helpers;

  const {
    TASKS_FILE, REVIEWS_FILE, DEPS_FILE,
  } = files;

  // --- Create Task ---

  function toolCreateTask(title, description, assignee, externalRef, bmadStoryId, size) {
    ensureDataDir();
    // Durable-delivery enqueue happens AFTER the TASKS_FILE lock is released
    // (never nested inside it) to keep a single, provable lock order: any
    // caller only ever holds at most one of {TASKS_FILE lock, deliveries lock}
    // at a time, so the two can never deadlock against each other.
    const result = withFileLock(TASKS_FILE, () => toolCreateTaskLocked(title, description, assignee, externalRef, bmadStoryId, size));
    if (result && result.success && result.assignee && result.assignee !== state.registeredName && typeof enqueueDurableDelivery === 'function') {
      // Idempotency key is scoped to this specific task_id: it dedupes a
      // retried enqueue call for the SAME already-created task (e.g. this
      // exact code path re-running after a partial failure). It does NOT
      // dedupe separate create_task() calls — each call mints a new task_id
      // and is a genuinely new assignment, so it durably enqueues separately
      // by design.
      const idempotencyKey = `task_assignment:${result.task_id}`;
      const enqueueResult = enqueueDurableDelivery({
        recipient: result.assignee,
        payload: { type: 'task_assignment', task_id: result.task_id, title, description: description || '' },
        kind: 'task',
        idempotencyKey,
        messageId: result.task_id,
      });
      // The task itself is already persisted at this point — never fail
      // create_task over a backing-delivery problem. Surface it as a
      // structured, additive field instead of silently succeeding, so a
      // caller/monitor can retry using the same idempotency_key.
      if (enqueueResult && enqueueResult.ok === false) {
        result.durable_delivery = {
          error: enqueueResult.error,
          code: enqueueResult.code,
          idempotency_key: idempotencyKey,
          retry_hint: 'The task was created successfully. Retry backing delivery with the same idempotency_key; it will not duplicate once it succeeds.',
        };
      }
    }
    return result;
  }

  function toolCreateTaskLocked(title, description, assignee, externalRef, bmadStoryId, size) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    description = description || '';
    assignee = assignee || null;

    if (!title || !title.trim()) return { error: 'Task title cannot be empty' };
    if (title.length > 200) return { error: 'Task title too long (max 200 characters)' };
    if (description.length > 5000) return { error: 'Task description too long (max 5000 characters)' };
    if (externalRef && (typeof externalRef !== 'string' || !/^bmad:(?:story|artifact|gate):[A-Za-z0-9._:-]{1,200}$/.test(externalRef))) {
      return { error: 'external_ref must be a namespaced BMad story, artifact, or gate ID' };
    }
    if (size !== undefined && size !== null && size !== 'small' && size !== 'roadmap') {
      return { error: 'size must be "small" or "roadmap"' };
    }

    const agents = getAgents();
    const otherAgents = Object.keys(agents).filter(n => n !== state.registeredName);

    if (!assignee && otherAgents.length === 1) {
      assignee = otherAgents[0];
    }

    const task = {
      id: 'task_' + generateId(),
      title,
      description,
      status: 'pending',
      assignee: assignee || null,
      created_by: state.registeredName,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      notes: [],
      external_ref: externalRef || null,
      bmad_story_id: bmadStoryId || null,
    };
    if (size === 'small' || size === 'roadmap') task.size = size;

    const tasks = readTasksFresh(TASKS_FILE);
    if (tasks.length >= 1000) return { error: 'Task limit reached (max 1000). Complete or remove existing tasks first.' };
    if (externalRef && tasks.some((item) =>
      item && item.external_ref === externalRef && ACTIVE_EXTERNAL_REF_STATUSES.has(item.status))) {
      return { error: `An active task already uses external_ref "${externalRef}". Complete it before creating another assignment.` };
    }

    // Task-channel auto-binding: with 5+ agents and an assignee, auto-create a task channel
    let taskChannel = null;
    const aliveCount = Object.values(agents).filter(a => isPidAlive(a.pid, a.last_activity)).length;
    if (assignee && aliveCount >= 5 && isGroupMode()) {
      const shortId = task.id.replace('task_', '').substring(0, 6);
      taskChannel = `task-${shortId}`;
      const channels = getChannelsData();
      if (!channels[taskChannel]) {
        channels[taskChannel] = {
          description: `Task: ${title.substring(0, 100)}`,
          members: [state.registeredName],
          created_by: '__system__',
          created_at: new Date().toISOString(),
          task_id: task.id,
        };
        if (assignee && assignee !== state.registeredName) channels[taskChannel].members.push(assignee);
        saveChannelsData(channels);
      }
      task.channel = taskChannel;
    }

    tasks.push(task);
    saveTasksLocked(TASKS_FILE, tasks);
    touchActivity();

    // Durable backing record for the assignment (if any) is enqueued by the
    // toolCreateTask wrapper AFTER this lock releases — see there for why.
    const result = { success: true, task_id: task.id, assignee: task.assignee, next_action: 'Call listen() to receive updates.' };
    if (task.external_ref) result.external_ref = task.external_ref;
    if (taskChannel) result.channel = taskChannel;
    return result;
  }

  // --- Update Task ---

  function toolUpdateTask(taskId, status, notes) {
    ensureDataDir();
    // Same lock-order rule as toolCreateTask: durable-delivery enqueues for
    // any workflow-handoffs triggered by this update happen AFTER the
    // TASKS_FILE lock is released, never nested inside it. The locked
    // function collects them in `_pendingDurableHandoffs` and we drain +
    // strip that internal field here before returning to the caller.
    const result = withFileLock(TASKS_FILE, () => toolUpdateTaskLocked(taskId, status, notes));
    if (result && Array.isArray(result._pendingDurableHandoffs)) {
      const pending = result._pendingDurableHandoffs;
      delete result._pendingDurableHandoffs;
      if (typeof enqueueDurableDelivery === 'function') {
        const failures = [];
        for (const req of pending) {
          const enqueueResult = enqueueDurableDelivery(req);
          if (enqueueResult && enqueueResult.ok === false) {
            failures.push({
              error: enqueueResult.error,
              code: enqueueResult.code,
              idempotency_key: req.idempotencyKey,
              recipient: req.recipient,
              retry_hint: 'The workflow handoff message was already sent. Retry backing delivery with the same idempotency_key; it will not duplicate once it succeeds.',
            });
          }
        }
        if (failures.length > 0) result.durable_delivery_errors = failures;
      }
    }
    return result;
  }

  function toolUpdateTaskLocked(taskId, status, notes) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    notes = notes || null;
    // Collected during this locked section, drained by toolUpdateTask AFTER
    // the lock releases (see there) — never call enqueueDurableDelivery
    // directly from within this function.
    const pendingDurableHandoffs = [];

    const validStatuses = ['pending', 'in_progress', 'in_review', 'done', 'blocked', 'blocked_permanent'];
    if (!validStatuses.includes(status)) return { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };

    const tasks = readTasksFresh(TASKS_FILE);
    const task = tasks.find(t => t.id === taskId);
    if (!task) return { error: `Task not found: ${taskId}` };
    if (task.external_ref && ACTIVE_EXTERNAL_REF_STATUSES.has(status) && tasks.some((item) =>
      item && item.id !== task.id && item.external_ref === task.external_ref && ACTIVE_EXTERNAL_REF_STATUSES.has(item.status))) {
      return { error: `Another active task already uses external_ref "${task.external_ref}". Complete it before reactivating this assignment.` };
    }

    // Prevent race condition: can't claim a task already in_progress by another agent
    if (status === 'in_progress' && task.status === 'in_progress' && task.assignee && task.assignee !== state.registeredName) {
      return { error: `Task already claimed by ${task.assignee}. Use suggest_task() to find another task.` };
    }
    if (status === 'in_progress' && !task.assignee) {
      task.assignee = state.registeredName;
    }
    if (status === 'in_progress') {
      if (!task.attempt_agents) task.attempt_agents = [];
      if (!task.attempt_agents.includes(state.registeredName)) task.attempt_agents.push(state.registeredName);
    }

    // Circuit breaker: if task goes back to pending and 3+ agents have failed, block permanently
    if (status === 'pending' && task.attempt_agents && task.attempt_agents.length >= 3) {
      task.status = 'blocked_permanent';
      task.updated_at = new Date().toISOString();
      task.block_reason = `Circuit breaker: ${task.attempt_agents.length} agents attempted and failed (${task.attempt_agents.join(', ')})`;
      saveTasksLocked(TASKS_FILE, tasks);
      broadcastSystemMessage(`[CIRCUIT BREAKER] Task "${task.title}" permanently blocked after ${task.attempt_agents.length} agents failed. Needs human review.`);
      touchActivity();
      return { success: true, task_id: task.id, status: 'blocked_permanent', circuit_breaker: true, message: 'Task permanently blocked — too many agents failed. Needs human review.' };
    }

    // Review gate: block 'done' if a quality/reviewer agent is online and no approved review exists
    if (status === 'done') {
      const agents = getAgents();
      const profiles = getProfiles();
      const hasReviewer = Object.keys(agents).some(n => {
        if (n === state.registeredName) return false;
        if (!isPidAlive(agents[n].pid, agents[n].last_activity)) return false;
        const role = (profiles[n] && profiles[n].role) || '';
        return role === 'quality' || role === 'reviewer';
      });
      if (hasReviewer) {
        const reviews = getReviews();
        const hasApproval = reviews.some(r =>
          r.status === 'approved' &&
          r.requested_by === state.registeredName &&
          (r.file && task.title && (task.title === r.file || task.title.includes(r.file)))
        );
        if (!hasApproval) {
          const reviewId = 'review_' + generateId();
          reviews.push({
            id: reviewId,
            file: task.title,
            requested_by: state.registeredName,
            status: 'pending',
            requested_at: new Date().toISOString(),
          });
          writeJsonFile(REVIEWS_FILE, reviews);
          task.status = 'in_review';
          task.updated_at = new Date().toISOString();
          saveTasksLocked(TASKS_FILE, tasks);
          broadcastSystemMessage(`[REVIEW GATE] ${state.registeredName} tried to mark "${task.title}" done but no review exists. Auto-created review ${reviewId}. A reviewer must approve before this task can be completed.`, state.registeredName);
          logViolation('review_gate_blocked', state.registeredName, `Task "${task.title}" (${task.id}) blocked — no approved review. Auto-created ${reviewId}.`);
          touchActivity();
          return {
            blocked: true,
            task_id: task.id,
            status: 'in_review',
            review_id: reviewId,
            next_action: 'Call listen() to wait for the reviewer to approve.',
            message: `Cannot mark done — a reviewer is online and no approval exists. Review ${reviewId} auto-created. Wait for approval, then try again.`,
          };
        }
      }
    }

    task.status = status;
    task.updated_at = new Date().toISOString();
    if (status !== 'blocked' && task.escalated_at) delete task.escalated_at;
    if (notes) {
      task.notes.push({ by: state.registeredName, text: notes, at: new Date().toISOString() });
    }

    saveTasksLocked(TASKS_FILE, tasks);
    touchActivity();

    // Auto-status: update agent's workspace status on task state changes
    try {
      if (status === 'in_progress') {
        saveWorkspace(state.registeredName, Object.assign(getWorkspace(state.registeredName), { _status: `Working on: ${task.title}`, _status_since: new Date().toISOString() }));
      } else if (status === 'done') {
        saveWorkspace(state.registeredName, Object.assign(getWorkspace(state.registeredName), { _status: `Completed: ${task.title}`, _status_since: new Date().toISOString() }));
      } else if (status === 'blocked') {
        saveWorkspace(state.registeredName, Object.assign(getWorkspace(state.registeredName), { _status: `BLOCKED on: ${task.title}`, _status_since: new Date().toISOString() }));
      }
    } catch (e) { /* workspace status update failed */ }

    // Task-channel auto-join: when claiming a task that has a channel, auto-join it
    if (status === 'in_progress' && task.channel) {
      const channels = getChannelsData();
      if (channels[task.channel] && !channels[task.channel].members.includes(state.registeredName)) {
        channels[task.channel].members.push(state.registeredName);
        saveChannelsData(channels);
      }
    }

    // Event hooks: task completion
    if (status === 'done') {
      fireEvent('task_complete', { title: task.title, created_by: task.created_by });
      appendNotification('task_done', state.registeredName, `Task "${task.title}" completed by ${state.registeredName}`, task.id);
      // Check if this resolves any dependencies
      const deps = getDeps();
      for (const dep of deps) {
        if (dep.depends_on === taskId && !dep.resolved) {
          dep.resolved = true;
          const blockedTask = tasks.find(t => t.id === dep.task_id);
          if (blockedTask && blockedTask.assignee) {
            fireEvent('dependency_met', { task_title: task.title, notify: blockedTask.assignee });
          }
        }
      }
      writeJsonFile(DEPS_FILE, deps);

      // Task-channel auto-cleanup: archive task channel when task is done
      if (task.channel) {
        const channels = getChannelsData();
        if (channels[task.channel]) {
          delete channels[task.channel];
          saveChannelsData(channels);
        }
      }

      // Quality gate: auto-request review when task is completed
      const agents = getAgents();
      const aliveOthers = Object.keys(agents).filter(n => n !== state.registeredName && isPidAlive(agents[n].pid, agents[n].last_activity));
      if (aliveOthers.length > 0) {
        broadcastSystemMessage(`[REVIEW NEEDED] ${state.registeredName} completed task "${task.title}". Team: please review the work and call submit_review() if applicable.`, state.registeredName);
      }

      // Auto-sync: advance matching workflow step when task is done
      try {
        const workflows = getWorkflows();
        let wfChanged = false;
        for (const wf of workflows) {
          if (wf.status !== 'active') continue;
          for (const step of wf.steps) {
            if (step.status !== 'in_progress') continue;
            if (step.assignee !== state.registeredName) continue;
            step.status = 'done';
            step.completed_at = new Date().toISOString();
            step.notes = `Auto-completed via task "${task.title}"`;
            saveWorkflowCheckpoint(wf, step);
            const nextSteps = findReadySteps(wf);
            for (const ns of nextSteps) {
              if (ns.requires_approval) {
                ns.status = 'awaiting_approval';
                ns.approval_requested_at = new Date().toISOString();
                sendSystemMessage('__user__', `[APPROVAL NEEDED] Workflow "${wf.name}" — Step ${ns.id}: "${ns.description}". Approve or reject from the dashboard.`);
              } else {
                ns.status = 'in_progress';
                ns.started_at = new Date().toISOString();
                if (ns.assignee && ns.assignee !== state.registeredName) {
                  const handoffContent = `[Workflow "${wf.name}"] Step ${ns.id} assigned to you: ${ns.description}`;
                  state.messageSeq++;
                  const hMsg = { id: generateId(), seq: state.messageSeq, from: state.registeredName, to: ns.assignee, content: handoffContent, timestamp: new Date().toISOString(), type: 'handoff' };
                  const _hmf = getMessagesFile(state.currentBranch);
                  const _hhf = getHistoryFile(state.currentBranch);
                  withFileLock(_hmf, () => { fs.appendFileSync(_hmf, JSON.stringify(hMsg) + '\n'); });
                  withFileLock(_hhf, () => { fs.appendFileSync(_hhf, JSON.stringify(hMsg) + '\n'); });

                  // Durable backing record for the handoff, keyed by workflow+step so
                  // re-running this advance (e.g. after a crash/retry) never double-enqueues.
                  // The message above remains the sole visible notification. Actually
                  // enqueued by toolUpdateTask after this lock releases (see there).
                  pendingDurableHandoffs.push({
                    recipient: ns.assignee,
                    payload: { type: 'workflow_handoff', workflow_id: wf.id, step_id: ns.id, workflow_name: wf.name, description: ns.description, message_id: hMsg.id },
                    kind: 'handoff',
                    idempotencyKey: `handoff:${wf.id}:${ns.id}`,
                    messageId: `${wf.id}:${ns.id}`,
                  });
                }
              }
            }
            if (wf.steps.every(s => s.status === 'done')) wf.status = 'completed';
            wf.updated_at = new Date().toISOString();
            wfChanged = true;
            broadcastSystemMessage(`[WORKFLOW] Step "${step.description}" auto-advanced via task completion by ${state.registeredName}`);
            break;
          }
          if (wfChanged) break;
        }
        if (wfChanged) saveWorkflows(workflows);
      } catch (e) { /* auto-advance workflow on task done failed */ }
    }

    // GitHub Projects sync — async, non-blocking, graceful if unconfigured
    try {
      const ghSync = require('../lib/github-sync');
      if (ghSync.isConfigured()) {
        ghSync.syncTask(task).catch(function () {});
      }
    } catch (e) { /* github-sync module not available */ }

    // Event hooks: notify subscribers of all task status changes
    try {
      const hooksLib = require('../lib/hooks');
      const notifications = hooksLib.emit('task.status_changed', {
        task_id: task.id, title: task.title, status: task.status,
        assignee: task.assignee, changed_by: state.registeredName,
        _source_agent: state.registeredName,
      });
      for (const n of notifications) { helpers.sendSystemMessage(n.agent, n.message); }
    } catch (e) { /* hooks not available */ }

    const nextAction = status === 'done' ? 'Send a summary of what you did via send_message(), then call listen().'
      : status === 'in_progress' ? `Do the work on "${task.title}", then call update_task("${task.id}", "done") when finished.`
      : status === 'blocked' ? 'Send a message explaining the blocker, then call listen().'
      : 'Call listen() to receive updates.';
    const finalResult = { success: true, task_id: task.id, status: task.status, title: task.title, next_action: nextAction };
    if (pendingDurableHandoffs.length > 0) finalResult._pendingDurableHandoffs = pendingDurableHandoffs;
    return finalResult;
  }

  // --- List Tasks ---

  function toolListTasks(status, assignee) {
    let tasks = getTasks();
    if (status) tasks = tasks.filter(t => t.status === status);
    if (assignee) tasks = tasks.filter(t => t.assignee === assignee);

    return {
      count: tasks.length,
      tasks: tasks.map(t => ({
        id: t.id,
        title: t.title,
        description: t.description,
        status: t.status,
        assignee: t.assignee,
        created_by: t.created_by,
        created_at: t.created_at,
        updated_at: t.updated_at,
        notes_count: Array.isArray(t.notes) ? t.notes.length : 0,
      })),
    };
  }

  // --- Suggest Task ---

  function toolSuggestTask() {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const rep = getReputation();
    const myRep = rep[state.registeredName];
    const tasks = getTasks();
    const pendingTasks = tasks.filter(t => t.status === 'pending' && !t.assignee);
    const unassignedTasks = tasks.filter(t => t.status === 'pending');

    if (pendingTasks.length === 0 && unassignedTasks.length === 0) {
      const reviews = getReviews();
      const pendingReviews = reviews.filter(r => r.status === 'pending' && r.requested_by !== state.registeredName);
      if (pendingReviews.length > 0) {
        return { suggestion: 'review', review_id: pendingReviews[0].id, file: pendingReviews[0].file, message: `No pending tasks, but there's a code review waiting: "${pendingReviews[0].file}". Call submit_review() to review it.` };
      }
      const deps = getDeps();
      const unresolved = deps.filter(d => !d.resolved);
      if (unresolved.length > 0) {
        return { suggestion: 'unblock', message: `No tasks available, but ${unresolved.length} task(s) are blocked by dependencies. Check if you can help resolve them.` };
      }
      return { suggestion: 'none', message: 'No pending tasks, reviews, or blocked items. Ask the team what needs doing next.' };
    }

    const myActiveTasks = tasks.filter(t => t.assignee === state.registeredName && t.status === 'in_progress');
    if (myActiveTasks.length >= 3) {
      return { suggestion: 'finish_first', your_active_tasks: myActiveTasks.map(t => ({ id: t.id, title: t.title })), message: `You already have ${myActiveTasks.length} tasks in progress. Finish one before taking more.` };
    }

    if (myRep && myRep.strengths.includes('reviewer')) {
      const reviews = getReviews().filter(r => r.status === 'pending' && r.requested_by !== state.registeredName);
      if (reviews.length > 0) return { suggestion: 'review', review_id: reviews[0].id, file: reviews[0].file, message: `Based on your strengths (reviewer), review "${reviews[0].file}".` };
    }

    const myDoneTasks = tasks.filter(t => t.assignee === state.registeredName && t.status === 'done');
    const myKeywords = new Set();
    for (const t of myDoneTasks) {
      const words = (t.title + ' ' + (t.description || '')).toLowerCase().split(/\W+/).filter(w => w.length > 3);
      words.forEach(w => myKeywords.add(w));
    }

    let suggested = pendingTasks[0] || unassignedTasks[0];
    if (myKeywords.size > 0 && pendingTasks.length > 1) {
      let bestScore = 0;
      for (const task of pendingTasks) {
        const taskWords = (task.title + ' ' + (task.description || '')).toLowerCase().split(/\W+/).filter(w => w.length > 3);
        const score = taskWords.filter(w => myKeywords.has(w)).length;
        if (score > bestScore) { bestScore = score; suggested = task; }
      }
    }

    const blockedTasks = tasks.filter(t => t.status === 'blocked');
    if (blockedTasks.length > 0 && pendingTasks.length === 0) {
      return { suggestion: 'unblock_task', task: { id: blockedTasks[0].id, title: blockedTasks[0].title }, message: `No pending tasks, but "${blockedTasks[0].title}" is blocked. Can you help unblock it?` };
    }

    return {
      suggestion: 'task',
      task_id: suggested.id,
      title: suggested.title,
      description: suggested.description,
      message: `Suggested: "${suggested.title}". Call update_task("${suggested.id}", "in_progress") to claim it.`,
      ...(myKeywords.size > 0 && { match_reason: 'Based on your completed task history' }),
    };
  }

  // --- Link Task to BMad Story ---

  function toolLinkTaskToStory(taskId, storyFilePath) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (!taskId || typeof taskId !== 'string') return { error: 'task_id is required' };
    if (!storyFilePath || typeof storyFilePath !== 'string') return { error: 'story_file_path is required' };

    const nodePath = require('path');

    // Resolve project root canonically (resolves symlinks)
    const projectRoot = (() => {
      try { return fs.realpathSync(nodePath.dirname(require.resolve('../package.json'))); }
      catch { return nodePath.resolve(__dirname, '..'); }
    })();

    // Resolve candidate path: relative paths are relative to project root
    const candidate = nodePath.isAbsolute(storyFilePath)
      ? storyFilePath
      : nodePath.join(projectRoot, storyFilePath);

    if (!fs.existsSync(candidate)) return { error: `Story file not found: ${storyFilePath}` };

    // Canonicalize (resolves symlinks) — must be inside project root
    let absPath;
    try { absPath = fs.realpathSync(candidate); }
    catch { return { error: `Cannot resolve story file path: ${storyFilePath}` }; }

    const rel = nodePath.relative(projectRoot, absPath);
    if (rel.startsWith('..') || nodePath.isAbsolute(rel)) {
      return { error: 'story_file_path must resolve to a file inside the project root' };
    }

    return withFileLock(TASKS_FILE, () => {
      const tasks = readTasksFresh(TASKS_FILE);
      const task = tasks.find(t => t.id === taskId);
      if (!task) return { error: `Task not found: ${taskId}` };

      const prevStoryId = task.bmad_story_id || null;
      task.bmad_story_id = storyFilePath;
      task.updated_at = new Date().toISOString();
      saveTasksLocked(TASKS_FILE, tasks);

      // Write 'Related Task' comment to the story file (idempotent, locked)
      const marker = `<!-- Related Task: ${taskId} -->`;
      const storyContent = fs.readFileSync(absPath, 'utf8');
      if (!storyContent.includes(marker)) {
        const appendResult = withFileLock(absPath, () => {
          try {
            fs.appendFileSync(absPath, `\n${marker}\n`);
            return true;
          } catch (e) {
            return { appendError: e.message };
          }
        });

        // B3: if lock denied or append failed, rollback task's bmad_story_id
        const failed = !appendResult || (appendResult && appendResult.appendError);
        if (failed) {
          const errorMsg = appendResult && appendResult.appendError
            ? `Story file append failed: ${appendResult.appendError}`
            : 'Story file lock denied — could not write Related Task comment';
          // Rollback under the same TASKS_FILE lock (already held)
          task.bmad_story_id = prevStoryId;
          task.updated_at = new Date().toISOString();
          saveTasksLocked(TASKS_FILE, tasks);
          return {
            error: errorMsg,
            task_id: taskId,
            rolled_back: true,
            previous_story_id: prevStoryId,
          };
        }
      }

      return {
        success: true,
        task_id: taskId,
        story_file_path: storyFilePath,
        previous_story_id: prevStoryId,
        next_action: 'Call listen() to continue.',
      };
    });
  }

  // --- MCP tool definitions ---

  const definitions = [
    {
      name: 'create_task',
      description: 'Create a task and optionally assign it to another agent. Use for structured work delegation in multi-agent teams.',
      inputSchema: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Short task title', maxLength: 200 },
          description: { type: 'string', description: 'Detailed task description', maxLength: 5000 },
          assignee: { type: 'string', description: 'Agent to assign to (optional, auto-assigns with 2 agents)', maxLength: 50 },
          external_ref: { type: 'string', description: 'Optional authoritative BMad reference such as bmad:story:story-one', maxLength: 230 },
          bmad_story_id: { type: 'string', description: 'Optional path to a linked BMad story file', maxLength: 500 },
          size: { type: 'string', description: 'Optional explicit size override for roadmap-size classification', enum: ['small', 'roadmap'] },
        },
        required: ['title'],
        additionalProperties: false,
      },
    },
    {
      name: 'update_task',
      description: 'Update a task status. Statuses: pending, in_progress, in_review, done, blocked.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to update', maxLength: 50 },
          status: { type: 'string', enum: ['pending', 'in_progress', 'in_review', 'done', 'blocked', 'blocked_permanent'], description: 'New status' },
          notes: { type: 'string', description: 'Optional progress note', maxLength: 2000 },
        },
        required: ['task_id', 'status'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_tasks',
      description: 'List all tasks, optionally filtered by status or assignee.',
      inputSchema: {
        type: 'object',
        properties: {
          status: { type: 'string', enum: ['pending', 'in_progress', 'in_review', 'done', 'blocked', 'blocked_permanent'], description: 'Filter by status' },
          assignee: { type: 'string', description: 'Filter by assignee agent name' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'suggest_task',
      description: 'Get a task suggestion based on your strengths, pending tasks, open reviews, and blocked dependencies. Helps you find the most useful thing to do next.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'link_task_to_story',
      description: 'Link a Neohive task to a BMad story file, bidirectionally: writes bmad_story_id on the task and appends a Related Task comment to the story file.',
      inputSchema: {
        type: 'object',
        properties: {
          task_id: { type: 'string', description: 'Task ID to link', maxLength: 50 },
          story_file_path: { type: 'string', description: 'Relative or absolute path to the BMad story .md file', maxLength: 500 },
        },
        required: ['task_id', 'story_file_path'],
        additionalProperties: false,
      },
    },
  ];

  // Handler dispatch map
  const handlers = {
    create_task: function (args) { return toolCreateTask(args.title, args.description, args.assignee, args.external_ref, args.bmad_story_id, args.size); },
    update_task: function (args) { return toolUpdateTask(args.task_id, args.status, args.notes); },
    list_tasks: function (args) { return toolListTasks(args.status, args.assignee); },
    suggest_task: function () { return toolSuggestTask(); },
    link_task_to_story: function (args) { return toolLinkTaskToStory(args.task_id, args.story_file_path); },
  };

  return { definitions, handlers };
};
