'use strict';

// Governance tools: voting, reviews, rules, push approval, audit logging.
// Extracted from server.js as proof of concept for modular tool architecture.
//
// Usage in server.js:
//   const governance = require('./tools/governance')(ctx);
//   // ctx = { state, helpers, files }
//   // governance.handlers.call_vote(args) => result
//   // governance.definitions => array of MCP tool schemas

const fs = require('fs');

module.exports = function (ctx) {
  const { state, helpers, files } = ctx;

  // Destructure helpers for concise access
  const {
    getVotes, getReviews, getRules, getPushRequests,
    getAgents, isPidAlive, getReputation, getTasks, saveTasks,
    generateId, readJsonFile, writeJsonFile, cachedRead, invalidateCache,
    broadcastSystemMessage, sendSystemMessage, touchActivity, fireEvent,
  } = helpers;

  const {
    VOTES_FILE, REVIEWS_FILE, RULES_FILE,
    PUSH_REQUESTS_FILE, AUDIT_LOG_FILE, REPUTATION_FILE,
  } = files;

  // --- Voting ---

  function toolCallVote(question, options) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof question !== 'string' || question.length < 1 || question.length > 200) return { error: 'Question must be 1-200 chars' };
    if (!Array.isArray(options) || options.length < 2 || options.length > 10) return { error: 'Need 2-10 options' };

    const votes = getVotes();
    if (votes.length >= 500) return { error: 'Vote limit reached (max 500).' };
    const vote = {
      id: 'vote_' + generateId(),
      question,
      options: options.map(o => String(o).substring(0, 50)),
      votes: {},
      status: 'open',
      created_by: state.registeredName,
      created_at: new Date().toISOString(),
    };
    votes.push(vote);
    writeJsonFile(VOTES_FILE, votes);

    broadcastSystemMessage(`[VOTE] ${state.registeredName} started a vote: "${question}" — Options: ${vote.options.join(', ')}. Call cast_vote("${vote.id}", "your_choice") to vote.`, state.registeredName);
    touchActivity();
    return { success: true, vote_id: vote.id, question, options: vote.options, message: 'Vote created. All agents have been notified.' };
  }

  function toolCastVote(voteId, choice) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const votes = getVotes();
    const vote = votes.find(v => v.id === voteId);
    if (!vote) return { error: `Vote not found: ${voteId}` };
    if (vote.status !== 'open') return { error: 'Vote is already closed.' };
    if (!vote.options.includes(choice)) return { error: `Invalid choice. Options: ${vote.options.join(', ')}` };

    vote.votes[state.registeredName] = { choice, voted_at: new Date().toISOString() };

    const agents = getAgents();
    const onlineAgents = Object.keys(agents).filter(n => isPidAlive(agents[n].pid, agents[n].last_activity));
    const allVoted = onlineAgents.every(n => vote.votes[n]);

    if (allVoted) {
      vote.status = 'closed';
      vote.closed_at = new Date().toISOString();
      const results = {};
      for (const opt of vote.options) results[opt] = 0;
      for (const v of Object.values(vote.votes)) results[v.choice]++;
      vote.results = results;
      const winner = Object.entries(results).sort((a, b) => b[1] - a[1])[0];
      broadcastSystemMessage(`[VOTE RESULT] "${vote.question}" — Winner: ${winner[0]} (${winner[1]} votes). Full results: ${JSON.stringify(results)}`);
    }

    writeJsonFile(VOTES_FILE, votes);
    touchActivity();
    return { success: true, vote_id: voteId, your_vote: choice, status: vote.status, votes_cast: Object.keys(vote.votes).length, agents_online: onlineAgents.length };
  }

  function toolVoteStatus(voteId) {
    const votes = getVotes();
    if (voteId) {
      const vote = votes.find(v => v.id === voteId);
      if (!vote) return { error: `Vote not found: ${voteId}` };
      return { vote };
    }
    return { votes: votes.map(v => ({ id: v.id, question: v.question, status: v.status, votes_cast: Object.keys(v.votes).length, results: v.results || null })) };
  }

  // --- Code Reviews ---

  function toolRequestReview(filePath, description) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (typeof filePath !== 'string' || filePath.length < 1) return { error: 'File path required' };

    const reviews = getReviews();
    if (reviews.length >= 500) return { error: 'Review limit reached (max 500).' };
    const review = {
      id: 'rev_' + generateId(),
      file: filePath.replace(/\\/g, '/'),
      description: (description || '').substring(0, 500),
      status: 'pending',
      requested_by: state.registeredName,
      requested_at: new Date().toISOString(),
      reviewer: null,
      feedback: null,
    };
    reviews.push(review);
    writeJsonFile(REVIEWS_FILE, reviews);

    broadcastSystemMessage(`[REVIEW REQUEST] ${state.registeredName} requests review of "${review.file}": ${review.description || 'No description'}. To review: (1) read the file "${review.file}", (2) call submit_review("${review.id}", "approved"/"changes_requested", "<your findings — min 50 chars>"). Feedback is required and must be substantive.`, state.registeredName);
    touchActivity();
    return { success: true, review_id: review.id, file: review.file, next_action: 'Call listen() to wait for the review.' };
  }

  const REVIEW_FEEDBACK_MIN_LENGTH = 50;

  function toolSubmitReview(reviewId, status, feedback) {
    if (!state.registeredName) return { error: 'You must call register() first' };

    const validStatuses = ['approved', 'changes_requested'];
    if (!validStatuses.includes(status)) return { error: `Status must be: ${validStatuses.join(' or ')}` };

    const reviews = getReviews();
    const review = reviews.find(r => r.id === reviewId);
    if (!review) return { error: `Review not found: ${reviewId}` };
    if (review.requested_by === state.registeredName) return { error: 'Cannot review your own code.' };

    // Enforce substantive feedback — rubber-stamping is not allowed
    const feedbackText = (feedback || '').trim();
    if (!feedbackText) {
      return {
        error: `Feedback is required. You must read "${review.file}" and describe what you found before submitting a review.`,
        next_action: `Read the file "${review.file}" first, then call submit_review("${reviewId}", "${status}", "<your findings>").`,
      };
    }
    if (feedbackText.length < REVIEW_FEEDBACK_MIN_LENGTH) {
      return {
        error: `Feedback too short (${feedbackText.length} chars, minimum ${REVIEW_FEEDBACK_MIN_LENGTH}). Describe specific findings — what you read, what issues you found or verified, and why you ${status === 'approved' ? 'approve' : 'request changes'}.`,
        next_action: `Read the file "${review.file}" first, then call submit_review("${reviewId}", "${status}", "<your detailed findings>").`,
      };
    }

    // Log audit entry for thin approvals (short feedback on an approval)
    if (status === 'approved' && feedbackText.length < 150) {
      logViolation('thin_review', state.registeredName, `Approved "${review.file}" with minimal feedback (${feedbackText.length} chars): "${feedbackText.substring(0, 100)}"`);
    }

    review.status = status;
    review.reviewer = state.registeredName;
    review.feedback = (feedback || '').substring(0, 2000);
    review.reviewed_at = new Date().toISOString();

    if (status === 'changes_requested') {
      review.review_round = (review.review_round || 0) + 1;

      // Circuit breaker: track consecutive rejections
      const rep = getReputation();
      if (!rep[review.requested_by]) rep[review.requested_by] = { tasks_completed: 0, reviews_done: 0, messages_sent: 0, consecutive_rejections: 0, first_seen: new Date().toISOString(), last_active: new Date().toISOString(), strengths: [], task_times: [], response_times: [] };
      rep[review.requested_by].consecutive_rejections = (rep[review.requested_by].consecutive_rejections || 0) + 1;
      if (rep[review.requested_by].consecutive_rejections >= 3) {
        rep[review.requested_by].demoted = true;
        rep[review.requested_by].demoted_at = new Date().toISOString();
        sendSystemMessage(review.requested_by, `[CIRCUIT BREAKER] You have ${rep[review.requested_by].consecutive_rejections} consecutive rejections. You are being assigned simpler tasks until your next approval. Focus on smaller, well-tested changes.`);
      }
      writeJsonFile(REPUTATION_FILE, rep);

      const tasks = getTasks();
      const relatedTask = tasks.find(t => t.title && review.file && t.title.includes(review.file)) ||
                          tasks.find(t => t.assignee === review.requested_by && t.status === 'in_progress');
      if (relatedTask) {
        relatedTask.retry_expected = true;
        relatedTask.review_feedback = review.feedback;
        relatedTask.review_round = review.review_round;
        if (review.review_round >= 2) {
          relatedTask.auto_approve_next = true;
        }
        saveTasks(tasks);
      }

      const roundMsg = `[REVIEW FEEDBACK] ${state.registeredName} requested changes on "${review.file}": ${review.feedback}. Fix and re-submit. This is review round ${review.review_round}/2.` +
        (review.review_round >= 2 ? ' FINAL ROUND — next submission will be auto-approved.' : '');
      sendSystemMessage(review.requested_by, roundMsg);
    } else {
      const rep = getReputation();
      if (rep[review.requested_by]) {
        rep[review.requested_by].consecutive_rejections = 0;
        rep[review.requested_by].demoted = false;
        writeJsonFile(REPUTATION_FILE, rep);
      }
      const agents = getAgents();
      if (agents[review.requested_by]) {
        sendSystemMessage(review.requested_by, `[REVIEW] ${state.registeredName} approved "${review.file}": ${review.feedback || 'Looks good!'}`);
      }
      fireEvent('review_approved', { file: review.file, reviewer: state.registeredName, author: review.requested_by });
    }

    // Auto-approve if exceeded max review rounds
    if (status === 'changes_requested' && review.review_round > 2) {
      review.status = 'approved';
      review.auto_approved = true;
      review.auto_approve_reason = `Auto-approved after ${review.review_round} review rounds (max 2 rounds exceeded).`;
      sendSystemMessage(review.requested_by, `[REVIEW] "${review.file}" auto-approved after ${review.review_round} review rounds. Flagged for later human review.`);
    }

    writeJsonFile(REVIEWS_FILE, reviews);
    touchActivity();

    const reviewNextAction = review.status === 'approved'
      ? 'Call listen() to continue.'
      : 'Call listen() — the author will fix and resubmit.';
    const result = { success: true, review_id: reviewId, status: review.status, next_action: reviewNextAction };
    if (review.review_round) result.review_round = review.review_round;
    if (review.auto_approved) result.auto_approved = true;
    return result;
  }

  // --- Rules ---

  function toolAddRule(text, category, scope) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (!text || !text.trim()) return { error: 'Rule text cannot be empty' };
    category = category || 'custom';
    const validCategories = ['safety', 'workflow', 'code-style', 'communication', 'custom'];
    if (!validCategories.includes(category)) return { error: `Category must be one of: ${validCategories.join(', ')}` };
    if (scope && typeof scope !== 'object') return { error: 'scope must be an object with optional fields: role, provider, agent' };

    const rules = getRules();
    const rule = {
      id: 'rule_' + generateId(),
      text: text.trim(),
      category,
      created_by: state.registeredName,
      created_at: new Date().toISOString(),
      active: true,
    };
    if (scope) {
      if (scope.role) rule.scope_role = String(scope.role).toLowerCase();
      if (scope.provider) rule.scope_provider = String(scope.provider).toLowerCase();
      if (scope.agent) rule.scope_agent = String(scope.agent);
    }
    rules.push(rule);
    writeJsonFile(RULES_FILE, rules);
    const scopeMsg = scope ? ` (scoped to ${JSON.stringify(scope)})` : '';
    return { success: true, rule_id: rule.id, message: `Rule added: "${text.substring(0, 80)}"${scopeMsg}. Matching agents will see this in their guide.` };
  }

  function toolListRules() {
    const rules = getRules();
    const active = rules.filter(r => r.active);
    const inactive = rules.filter(r => !r.active);
    return {
      rules: active,
      inactive_count: inactive.length,
      total: rules.length,
      categories: [...new Set(active.map(r => r.category))],
    };
  }

  function toolRemoveRule(ruleId) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (!ruleId) return { error: 'rule_id is required' };
    const rules = getRules();
    const idx = rules.findIndex(r => r.id === ruleId);
    if (idx === -1) return { error: `Rule not found: ${ruleId}` };
    const removed = rules.splice(idx, 1)[0];
    writeJsonFile(RULES_FILE, rules);
    return { success: true, removed: removed.text.substring(0, 80), message: 'Rule removed.' };
  }

  function toolToggleRule(ruleId) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (!ruleId) return { error: 'rule_id is required' };
    const rules = getRules();
    const rule = rules.find(r => r.id === ruleId);
    if (!rule) return { error: `Rule not found: ${ruleId}` };
    rule.active = !rule.active;
    writeJsonFile(RULES_FILE, rules);
    return { success: true, rule_id: ruleId, active: rule.active, message: `Rule ${rule.active ? 'activated' : 'deactivated'}.` };
  }

  // --- Audit log ---

  function logViolation(type, agent, details) {
    const entry = {
      timestamp: new Date().toISOString(),
      type,
      agent,
      details: (details || '').substring(0, 1000),
    };
    try {
      fs.appendFileSync(AUDIT_LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (e) { /* audit log write failed */ }
    return entry;
  }

  function toolLogViolation(type, details) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (!type) return { error: 'type is required (e.g., "review_skipped", "push_without_approval", "rule_violated")' };
    const entry = logViolation(type, state.registeredName, details);
    return { success: true, logged: entry, message: `Violation logged: ${type}` };
  }

  // --- Push approval ---

  const PUSH_AUTO_APPROVE_MS = 120000; // 2 minutes

  function toolRequestPushApproval(branch, description) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (!branch) return { error: 'branch is required' };

    const agents = getAgents();
    const aliveOthers = Object.keys(agents).filter(n => n !== state.registeredName && isPidAlive(agents[n].pid, agents[n].last_activity));

    if (aliveOthers.length === 0) {
      return { approved: true, auto: true, message: 'No other agents online — auto-approved. You may push.' };
    }

    const requests = getPushRequests();
    const id = 'push_' + generateId();
    const request = {
      id,
      branch: branch.substring(0, 100),
      description: (description || '').substring(0, 500),
      requested_by: state.registeredName,
      requested_at: new Date().toISOString(),
      status: 'pending',
      acked_by: null,
    };
    requests.push(request);
    writeJsonFile(PUSH_REQUESTS_FILE, requests);

    broadcastSystemMessage(`[PUSH REQUEST] ${state.registeredName} wants to push branch "${branch}". ${description || ''}. Call ack_push("${id}") to approve.`, state.registeredName);

    return {
      request_id: id,
      status: 'pending',
      waiting_on: aliveOthers,
      auto_approve_after: '2 minutes',
      message: `Push request created. Waiting for approval from ${aliveOthers.join(', ')}. Auto-approves in 2 minutes if no response.`,
    };
  }

  function toolAckPush(requestId) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    if (!requestId) return { error: 'request_id is required' };

    const requests = getPushRequests();
    const req = requests.find(r => r.id === requestId);
    if (!req) return { error: `Push request not found: ${requestId}` };
    if (req.requested_by === state.registeredName) return { error: 'Cannot approve your own push request.' };
    if (req.status !== 'pending') return { error: `Push request already ${req.status}.` };

    req.status = 'approved';
    req.acked_by = state.registeredName;
    req.acked_at = new Date().toISOString();
    writeJsonFile(PUSH_REQUESTS_FILE, requests);

    sendSystemMessage(req.requested_by, `[PUSH APPROVED] ${state.registeredName} approved your push of "${req.branch}". You may push now.`);

    return { success: true, request_id: requestId, message: `Push approved for ${req.requested_by} on branch "${req.branch}".` };
  }

  function checkPushAutoApprove(requestId) {
    const requests = getPushRequests();
    const req = requests.find(r => r.id === requestId);
    if (!req || req.status !== 'pending') return;

    const elapsed = Date.now() - new Date(req.requested_at).getTime();
    if (elapsed >= PUSH_AUTO_APPROVE_MS) {
      req.status = 'auto_approved';
      req.acked_by = '__system__';
      req.acked_at = new Date().toISOString();
      writeJsonFile(PUSH_REQUESTS_FILE, requests);
      sendSystemMessage(req.requested_by, `[PUSH AUTO-APPROVED] No response after 2 minutes. Push of "${req.branch}" auto-approved. You may push now.`);
    }
  }

  // --- MCP tool definitions ---

  const definitions = [
    // Voting
    {
      name: 'call_vote',
      description: 'Start a vote for the team to decide something. All online agents are notified and can cast their vote.',
      inputSchema: { type: 'object', properties: { question: { type: 'string', description: 'The question to vote on' }, options: { type: 'array', items: { type: 'string' }, description: 'Array of 2-10 options to choose from' } }, required: ['question', 'options'], additionalProperties: false },
    },
    {
      name: 'cast_vote',
      description: 'Cast your vote on an open vote. Vote auto-resolves when all online agents have voted.',
      inputSchema: { type: 'object', properties: { vote_id: { type: 'string', description: 'Vote ID' }, choice: { type: 'string', description: 'Your choice (must match one of the options)' } }, required: ['vote_id', 'choice'], additionalProperties: false },
    },
    {
      name: 'vote_status',
      description: 'Check status of a specific vote or all votes.',
      inputSchema: { type: 'object', properties: { vote_id: { type: 'string', description: 'Vote ID (optional — omit for all)' } }, additionalProperties: false },
    },
    // Reviews
    {
      name: 'request_review',
      description: 'Request a code review from the team. Creates a review request and notifies all agents.',
      inputSchema: { type: 'object', properties: { file_path: { type: 'string', description: 'File to review', maxLength: 500 }, description: { type: 'string', description: 'What to focus on in the review', maxLength: 2000 } }, required: ['file_path'], additionalProperties: false },
    },
    {
      name: 'submit_review',
      description: 'Submit a code review — approve or request changes. You MUST read the file under review before calling this. Feedback is required (minimum 50 chars) and must describe specific findings — what you read, what issues you found or confirmed. Rubber-stamp approvals are rejected.',
      inputSchema: { type: 'object', properties: { review_id: { type: 'string', description: 'Review ID', maxLength: 50 }, status: { type: 'string', enum: ['approved', 'changes_requested'], description: 'Review result' }, feedback: { type: 'string', description: 'Your findings from reading the file (required, min 50 chars). Describe what you read and what you found — bugs, security issues, correctness, or confirmation that the code is clean.', maxLength: 2000, minLength: 50 } }, required: ['review_id', 'status', 'feedback'], additionalProperties: false },
    },
    // Rules
    {
      name: 'add_rule',
      description: 'Add a project rule. Rules appear in matching agents\' guide and briefing. Use scope to limit who sees the rule (omit for all agents). Categories: safety, workflow, code-style, communication, custom.',
      inputSchema: {
        type: 'object',
        properties: {
          text: { type: 'string', description: 'The rule text', maxLength: 2000 },
          category: { type: 'string', description: 'Rule category: safety, workflow, code-style, communication, custom' },
          scope: {
            type: 'object',
            description: 'Optional scope filter. Omit for all agents.',
            properties: {
              role: { type: 'string', description: 'Only agents with this role (e.g., "quality", "backend")' },
              provider: { type: 'string', description: 'Only agents on this platform (e.g., "claude", "cursor", "gemini")' },
              agent: { type: 'string', description: 'Only this specific agent name' },
            },
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
    },
    {
      name: 'list_rules',
      description: 'List all project rules (active and inactive count).',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'remove_rule',
      description: 'Remove a project rule by ID.',
      inputSchema: { type: 'object', properties: { rule_id: { type: 'string', description: 'The rule ID to remove' } }, required: ['rule_id'], additionalProperties: false },
    },
    {
      name: 'toggle_rule',
      description: 'Toggle a rule active/inactive without deleting it.',
      inputSchema: { type: 'object', properties: { rule_id: { type: 'string', description: 'The rule ID to toggle' } }, required: ['rule_id'], additionalProperties: false },
    },
    // Audit + Push
    {
      name: 'log_violation',
      description: 'Log a workflow rule violation to the audit trail. Used automatically by review gates, or manually to flag issues.',
      inputSchema: { type: 'object', properties: { type: { type: 'string', description: 'Violation type: review_skipped, push_without_approval, rule_violated, etc.', maxLength: 100 }, details: { type: 'string', description: 'Description of the violation', maxLength: 2000 } }, required: ['type'], additionalProperties: false },
    },
    {
      name: 'request_push_approval',
      description: 'Request approval from another agent before pushing to a branch. Auto-approves after 2 minutes if no response, or immediately if no other agents are online.',
      inputSchema: { type: 'object', properties: { branch: { type: 'string', description: 'Branch name to push (e.g., "main", "feature/xyz")' }, description: { type: 'string', description: 'What changes are being pushed' } }, required: ['branch'], additionalProperties: false },
    },
    {
      name: 'ack_push',
      description: 'Approve another agent\'s push request. Cannot approve your own.',
      inputSchema: { type: 'object', properties: { request_id: { type: 'string', description: 'Push request ID from the system message' } }, required: ['request_id'], additionalProperties: false },
    },
  ];

  // Handler dispatch map: tool name -> function
  const handlers = {
    call_vote: function (args) { return toolCallVote(args.question, args.options); },
    cast_vote: function (args) { return toolCastVote(args.vote_id, args.choice); },
    vote_status: function (args) { return toolVoteStatus(args.vote_id); },
    request_review: function (args) { return toolRequestReview(args.file_path, args.description); },
    submit_review: function (args) { return toolSubmitReview(args.review_id, args.status, args.feedback); },
    add_rule: function (args) { return toolAddRule(args.text, args.category, args.scope); },
    list_rules: function () { return toolListRules(); },
    remove_rule: function (args) { return toolRemoveRule(args.rule_id); },
    toggle_rule: function (args) { return toolToggleRule(args.rule_id); },
    log_violation: function (args) { return toolLogViolation(args.type, args.details); },
    request_push_approval: function (args) { return toolRequestPushApproval(args.branch, args.description); },
    ack_push: function (args) { return toolAckPush(args.request_id); },
  };

  return {
    definitions,
    handlers,
    // Expose internal helpers that server.js still needs (e.g., checkPushAutoApprove in heartbeat)
    logViolation,
    checkPushAutoApprove,
    PUSH_AUTO_APPROVE_MS,
  };
};
