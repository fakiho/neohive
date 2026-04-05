'use strict';

// Workflow tools: create, advance, status.
// Extracted from server.js as part of modular tool architecture.

const fs = require('fs');

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;

  const {
    getWorkflows, saveWorkflows, saveWorkflowCheckpoint, findReadySteps,
    getAgents, isPidAlive, getTasks, saveTasks, generateId, ensureDataDir,
    broadcastSystemMessage, sendSystemMessage, touchActivity, appendNotification,
    getMessagesFile, getHistoryFile, canSendTo, generateCompletionReport,
  } = helpers;

  // --- Create Workflow ---

  function toolCreateWorkflow(name, steps, autonomous, parallel) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    autonomous = !!autonomous;
    parallel = !!parallel;
    if (!name || typeof name !== 'string' || name.length > 50) return { error: 'name must be 1-50 chars' };
    if (!Array.isArray(steps) || steps.length < 2 || steps.length > 30) return { error: 'steps must be array of 2-30 items' };

    const agents = getAgents();
    const workflows = getWorkflows();
    const workflowId = 'wf_' + generateId();

    const parsedSteps = steps.map((s, i) => {
      const step = typeof s === 'string' ? { description: s } : s;
      if (!step.description) return null;
      return {
        id: i + 1,
        description: step.description.substring(0, 200),
        assignee: step.assignee || null,
        depends_on: Array.isArray(step.depends_on) ? step.depends_on : [],
        requires_approval: !!step.requires_approval,
        status: 'pending',
        started_at: null,
        completed_at: null,
        notes: '',
      };
    });
    if (parsedSteps.includes(null)) return { error: 'Each step must have a description' };

    const stepIds = parsedSteps.map(s => s.id);
    for (const step of parsedSteps) {
      for (const depId of step.depends_on) {
        if (!stepIds.includes(depId)) return { error: `Step ${step.id} depends_on non-existent step ${depId}` };
        if (depId >= step.id) return { error: `Step ${step.id} cannot depend on step ${depId} (must depend on earlier steps)` };
      }
    }

    const readySteps = parsedSteps.filter(s => s.depends_on.length === 0);
    if (parallel) {
      for (const s of readySteps) {
        s.status = 'in_progress';
        s.started_at = new Date().toISOString();
      }
    } else {
      readySteps[0].status = 'in_progress';
      readySteps[0].started_at = new Date().toISOString();
    }

    const workflow = {
      id: workflowId,
      name,
      steps: parsedSteps,
      status: 'active',
      autonomous,
      parallel,
      created_by: state.registeredName,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    if (workflows.length >= 500) return { error: 'Workflow limit reached (max 500).' };
    workflows.push(workflow);
    ensureDataDir();
    saveWorkflows(workflows);

    const startedSteps = parsedSteps.filter(s => s.status === 'in_progress');
    for (const step of startedSteps) {
      if (step.assignee && agents[step.assignee] && step.assignee !== state.registeredName) {
        const handoffContent = `[Workflow "${name}"] Step ${step.id} assigned to you: ${step.description}` +
          (autonomous ? '\n\nThis is an AUTONOMOUS workflow. Call get_work() to enter the proactive work loop. Do NOT wait for approval.' : '');
        state.messageSeq++;
        const msg = { id: generateId(), seq: state.messageSeq, from: state.registeredName, to: step.assignee, content: handoffContent, timestamp: new Date().toISOString(), type: 'handoff' };
        fs.appendFileSync(getMessagesFile(state.currentBranch), JSON.stringify(msg) + '\n');
        fs.appendFileSync(getHistoryFile(state.currentBranch), JSON.stringify(msg) + '\n');
      }
    }
    touchActivity();

    return {
      success: true,
      workflow_id: workflowId,
      name,
      step_count: parsedSteps.length,
      autonomous,
      parallel,
      started_steps: startedSteps.map(s => ({ id: s.id, description: s.description, assignee: s.assignee })),
      next_action: autonomous ? 'Call get_work() for your assignment.' : 'Call listen() to receive updates.',
    };
  }

  // --- Advance Workflow ---

  function toolAdvanceWorkflow(workflowId, notes) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const workflows = getWorkflows();
    const wf = workflows.find(w => w.id === workflowId);
    if (!wf) return { error: `Workflow not found: ${workflowId}` };
    if (wf.status !== 'active') return { error: 'Workflow is not active' };

    const currentStep = wf.steps.find(s => s.status === 'in_progress');
    if (!currentStep) return { error: 'No step currently in progress' };

    currentStep.status = 'done';
    currentStep.completed_at = new Date().toISOString();
    if (notes) currentStep.notes = notes.substring(0, 500);

    saveWorkflowCheckpoint(wf, currentStep);

    // Auto-sync: mark matching in_progress tasks as done
    try {
      const tasks = getTasks();
      const matchingTask = tasks.find(t =>
        t.status === 'in_progress' && t.assignee === state.registeredName
      );
      if (matchingTask) {
        matchingTask.status = 'done';
        matchingTask.updated_at = new Date().toISOString();
        matchingTask.notes.push({ by: '__system__', text: `Auto-completed via workflow step "${currentStep.description}"`, at: new Date().toISOString() });
        saveTasks(tasks);
      }
    } catch (e) { /* auto-complete task on workflow advance failed */ }

    const nextSteps = findReadySteps(wf);
    if (nextSteps.length > 0) {
      const agents = getAgents();
      for (const step of nextSteps) {
        if (step.requires_approval) {
          step.status = 'awaiting_approval';
          step.approval_requested_at = new Date().toISOString();
          sendSystemMessage('__user__',
            `[APPROVAL NEEDED] Workflow "${wf.name}" — Step ${step.id}: "${step.description}". Approve or reject from the dashboard.`
          );
          continue;
        }
        step.status = 'in_progress';
        step.started_at = new Date().toISOString();
        if (step.assignee && agents[step.assignee] && step.assignee !== state.registeredName && canSendTo(state.registeredName, step.assignee)) {
          const handoffContent = `[Workflow "${wf.name}"] Step ${step.id} assigned to you: ${step.description}`;
          state.messageSeq++;
          const msg = { id: generateId(), seq: state.messageSeq, from: state.registeredName, to: step.assignee, content: handoffContent, timestamp: new Date().toISOString(), type: 'handoff' };
          fs.appendFileSync(getMessagesFile(state.currentBranch), JSON.stringify(msg) + '\n');
          fs.appendFileSync(getHistoryFile(state.currentBranch), JSON.stringify(msg) + '\n');
        }
      }
    } else if (wf.steps.every(s => s.status === 'done')) {
      wf.status = 'completed';
    }
    wf.updated_at = new Date().toISOString();
    saveWorkflows(workflows);
    touchActivity();

    const doneCount = wf.steps.filter(s => s.status === 'done').length;
    const pct = Math.round((doneCount / wf.steps.length) * 100);
    appendNotification('workflow_advanced', state.registeredName, `Workflow "${wf.name}" step ${currentStep.id} done (${pct}%)`, wf.id);

    return {
      success: true,
      workflow_id: wf.id,
      completed_step: currentStep.id,
      next_steps: nextSteps.length > 0 ? nextSteps.map(s => ({ id: s.id, description: s.description, assignee: s.assignee })) : null,
      progress: `${doneCount}/${wf.steps.length} (${pct}%)`,
      workflow_status: wf.status,
      next_action: wf.autonomous ? 'Call get_work() for your next assignment.' : 'Call listen() to receive the next step.',
    };
  }

  // --- Workflow Status ---

  function toolWorkflowStatus(workflowId, action, checkpointIndex) {
    const workflows = getWorkflows();

    if (action === 'rollback' && workflowId && checkpointIndex !== undefined) {
      const wf = workflows.find(w => w.id === workflowId);
      if (!wf) return { error: `Workflow not found: ${workflowId}` };
      if (!wf.checkpoints || !wf.checkpoints[checkpointIndex]) return { error: 'Checkpoint not found' };
      const checkpoint = wf.checkpoints[checkpointIndex];
      for (const savedStep of checkpoint.step_states) {
        const step = wf.steps.find(s => s.id === savedStep.id);
        if (step) { step.status = savedStep.status; step.assignee = savedStep.assignee; }
      }
      wf.updated_at = new Date().toISOString();
      saveWorkflows(workflows);
      broadcastSystemMessage(`[WORKFLOW] Rolled back "${wf.name}" to checkpoint: step "${checkpoint.step_description}"`);
      return { success: true, rolled_back_to: checkpoint };
    }

    if (workflowId) {
      const wf = workflows.find(w => w.id === workflowId);
      if (!wf) return { error: `Workflow not found: ${workflowId}` };
      const doneCount = wf.steps.filter(s => s.status === 'done').length;
      const pct = Math.round((doneCount / wf.steps.length) * 100);
      const result = { workflow: wf, progress: `${doneCount}/${wf.steps.length} (${pct}%)` };
      if (wf.checkpoints) result.checkpoints = wf.checkpoints.length;
      if (wf.status === 'completed') result.report = generateCompletionReport(wf);
      return result;
    }
    return {
      count: workflows.length,
      workflows: workflows.map(w => {
        const doneCount = w.steps.filter(s => s.status === 'done').length;
        return { id: w.id, name: w.name, status: w.status, steps: w.steps.length, done: doneCount, progress: Math.round((doneCount / w.steps.length) * 100) + '%', checkpoints: w.checkpoints ? w.checkpoints.length : 0 };
      }),
    };
  }

  // --- MCP tool definitions ---

  const definitions = [
    {
      name: 'create_workflow',
      description: 'Create a multi-step workflow pipeline. Each step can have a description, assignee, and depends_on (step IDs). Set autonomous=true for proactive work loop (agents auto-advance, no human gates). Set parallel=true to run independent steps simultaneously.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Workflow name (max 50 chars)' },
          steps: {
            type: 'array',
            description: 'Array of steps. Each step is a string (description) or {description, assignee, depends_on: [stepIds]}.',
            items: {
              oneOf: [
                { type: 'string' },
                { type: 'object', properties: { description: { type: 'string' }, assignee: { type: 'string' }, depends_on: { type: 'array', items: { type: 'number' }, description: 'Step IDs this step depends on (must complete first)' } }, required: ['description'] },
              ],
            },
          },
          autonomous: { type: 'boolean', default: false, description: 'If true, agents auto-advance through steps without waiting for approval. Enables proactive work loop, relaxed send limits, fast cooldowns, and 30s listen cap.' },
          parallel: { type: 'boolean', default: false, description: 'If true, steps with met dependencies run in parallel (multiple agents work simultaneously)' },
        },
        required: ['name', 'steps'],
        additionalProperties: false,
      },
    },
    {
      name: 'advance_workflow',
      description: 'Mark the current step as done and start the next step. Auto-sends a handoff message to the next assignee.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Workflow ID' },
          notes: { type: 'string', description: 'Optional completion notes (max 500 chars)' },
        },
        required: ['workflow_id'],
        additionalProperties: false,
      },
    },
    {
      name: 'workflow_status',
      description: 'Get status of a specific workflow or all workflows. Shows step progress, checkpoints, and completion percentage. Use action="rollback" to rollback to a checkpoint.',
      inputSchema: {
        type: 'object',
        properties: {
          workflow_id: { type: 'string', description: 'Workflow ID (optional — omit for all workflows)' },
          action: { type: 'string', enum: ['status', 'rollback'], description: 'Action (default: status)' },
          checkpoint_index: { type: 'number', description: 'Checkpoint index to rollback to (for rollback action)' },
        },
        additionalProperties: false,
      },
    },
  ];

  const handlers = {
    create_workflow: function (args) { return toolCreateWorkflow(args.name, args.steps, args.autonomous, args.parallel); },
    advance_workflow: function (args) { return toolAdvanceWorkflow(args.workflow_id, args.notes); },
    workflow_status: function (args) { return toolWorkflowStatus(args.workflow_id, args.action, args.checkpoint_index); },
  };

  return { definitions, handlers };
};
