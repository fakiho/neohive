'use strict';

// Task management tools: create, update, list, suggest.
// Extracted from server.js as part of modular tool architecture.

const fs = require('fs');

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;

  const {
    getTasks, saveTasks, getAgents, isPidAlive, generateId, writeJsonFile,
    broadcastSystemMessage, sendSystemMessage, touchActivity, fireEvent,
    ensureDataDir, getProfiles, getReviews, getReputation, getDeps,
    getChannelsData, saveChannelsData, isGroupMode,
    getWorkspace, saveWorkspace, appendNotification,
    getWorkflows, saveWorkflows, saveWorkflowCheckpoint, findReadySteps,
    getMessagesFile, getHistoryFile, logViolation, cachedRead,
  } = helpers;

  const {
    TASKS_FILE, REVIEWS_FILE, DEPS_FILE,
  } = files;

  // --- Create Task ---

  function toolCreateTask(title, description, assignee) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    description = description || '';
    assignee = assignee || null;

    if (!title || !title.trim()) return { error: 'Task title cannot be empty' };
    if (title.length > 200) return { error: 'Task title too long (max 200 characters)' };
    if (description.length > 5000) return { error: 'Task description too long (max 5000 characters)' };

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
    };

    ensureDataDir();

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

    const tasks = getTasks();
    if (tasks.length >= 1000) return { error: 'Task limit reached (max 1000). Complete or remove existing tasks first.' };
    tasks.push(task);
    saveTasks(tasks);
    touchActivity();

    const result = { success: true, task_id: task.id, assignee: task.assignee, next_action: 'Call listen() to receive updates.' };
    if (taskChannel) result.channel = taskChannel;
    return result;
  }

  // --- Update Task ---

  function toolUpdateTask(taskId, status, notes) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    notes = notes || null;

    const validStatuses = ['pending', 'in_progress', 'in_review', 'done', 'blocked', 'blocked_permanent'];
    if (!validStatuses.includes(status)) return { error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` };

    const tasks = getTasks();
    const task = tasks.find(t => t.id === taskId);
    if (!task) return { error: `Task not found: ${taskId}` };

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
      saveTasks(tasks);
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
          saveTasks(tasks);
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

    saveTasks(tasks);
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
                  fs.appendFileSync(getMessagesFile(state.currentBranch), JSON.stringify(hMsg) + '\n');
                  fs.appendFileSync(getHistoryFile(state.currentBranch), JSON.stringify(hMsg) + '\n');
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
    return { success: true, task_id: task.id, status: task.status, title: task.title, next_action: nextAction };
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
  ];

  // Handler dispatch map
  const handlers = {
    create_task: function (args) { return toolCreateTask(args.title, args.description, args.assignee); },
    update_task: function (args) { return toolUpdateTask(args.task_id, args.status, args.notes); },
    list_tasks: function (args) { return toolListTasks(args.status, args.assignee); },
    suggest_task: function () { return toolSuggestTask(); },
  };

  return { definitions, handlers };
};
