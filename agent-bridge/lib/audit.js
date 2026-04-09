'use strict';

// Audit logging module for comprehensive MCP tool call tracking
// Based on research in kb:audit-logging-research

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Configuration
const AUDIT_MAX_SIZE = parseInt(process.env.NEOHIVE_AUDIT_MAX_SIZE) || 10485760; // 10MB
const AUDIT_RETENTION_DAYS = parseInt(process.env.NEOHIVE_AUDIT_RETENTION_DAYS) || 30;
const AUDIT_ARGS_MAX_LENGTH = parseInt(process.env.NEOHIVE_AUDIT_ARGS_MAX_LENGTH) || 50000;
const AUDIT_RESULT_MAX_LENGTH = parseInt(process.env.NEOHIVE_AUDIT_RESULT_MAX_LENGTH) || 10000;
const AUDIT_LEVEL = process.env.NEOHIVE_AUDIT_LEVEL || 'standard';

// Tool categories for classification
const TOOL_CATEGORIES = {
  // Agent Lifecycle
  'register': 'agent-lifecycle',
  'list_agents': 'agent-lifecycle',
  
  // Messaging
  'send_message': 'messaging',
  'broadcast': 'messaging', 
  'listen': 'messaging',
  'listen_codex': 'messaging',
  'wait_for_reply': 'messaging',
  'check_messages': 'messaging',
  'consume_messages': 'messaging',
  'get_notifications': 'messaging',
  'ack_message': 'messaging',
  'get_history': 'messaging',
  'search_messages': 'messaging',
  
  // Task Management
  'create_task': 'tasks',
  'update_task': 'tasks',
  'list_tasks': 'tasks',
  
  // Workflows
  'create_workflow': 'workflows',
  'advance_workflow': 'workflows',
  'workflow_status': 'workflows',
  
  // Knowledge Base
  'kb_write': 'knowledge',
  'kb_read': 'knowledge',
  'kb_list': 'knowledge',
  'log_decision': 'knowledge',
  'get_decisions': 'knowledge',
  'get_briefing': 'knowledge',
  'get_compressed_history': 'knowledge',
  'update_progress': 'knowledge',
  'get_progress': 'knowledge',
  'get_summary': 'knowledge',
  
  // Governance
  'call_vote': 'governance',
  'cast_vote': 'governance',
  'vote_status': 'governance',
  'request_review': 'governance',
  'submit_review': 'governance',
  'request_push_approval': 'governance',
  'ack_push': 'governance',
  'add_rule': 'governance',
  'remove_rule': 'governance',
  'toggle_rule': 'governance',
  'log_violation': 'governance',
  
  // File Safety
  'lock_file': 'safety',
  'unlock_file': 'safety',
  'declare_dependency': 'safety',
  'check_dependencies': 'safety',
  
  // System
  'workspace_write': 'system',
  'workspace_read': 'system',
  'workspace_list': 'system',
  'update_profile': 'system',
  'list_branches': 'system',
  'fork_conversation': 'system',
  'switch_branch': 'system',
  'set_conversation_mode': 'system',
  
  // Channels
  'join_channel': 'channels',
  'leave_channel': 'channels',
  'list_channels': 'channels',
  
  // Autonomy
  'get_work': 'autonomy',
  'verify_and_advance': 'autonomy',
  'retry_with_improvement': 'autonomy',
  'start_plan': 'autonomy',
  'distribute_prompt': 'autonomy',
  'claim_manager': 'autonomy',
  'yield_floor': 'autonomy',
  'set_phase': 'autonomy',
  
  // Utilities
  'share_file': 'utilities',
  'handoff': 'utilities',
  'reset': 'utilities',
  'get_guide': 'utilities',
  'get_reputation': 'utilities',
  'listen_group': 'utilities'
};

// Audit levels configuration
const AUDIT_LEVELS = {
  minimal: ['governance'], // Only governance tools (current behavior)
  standard: ['messaging', 'tasks', 'workflows', 'governance', 'safety'], // Core tools
  full: Object.keys(TOOL_CATEGORIES) // All categories
};

let auditFile = null;
let pendingWrites = [];
let writeTimer = null;

function init(dataDir) {
  auditFile = path.join(dataDir, 'audit_log.jsonl');
  
  // Ensure audit file exists
  if (!fs.existsSync(auditFile)) {
    try {
      fs.writeFileSync(auditFile, '', 'utf8');
    } catch (e) {
      console.error('[audit] Failed to create audit log:', e.message);
    }
  }
  
  // Start cleanup timer for old archives
  setInterval(cleanupOldArchives, 24 * 60 * 60 * 1000); // Daily cleanup
}

function shouldLogTool(toolName) {
  if (AUDIT_LEVEL === 'disabled') return false;
  
  const category = TOOL_CATEGORIES[toolName] || 'unknown';
  const allowedCategories = AUDIT_LEVELS[AUDIT_LEVEL] || AUDIT_LEVELS.standard;
  
  return allowedCategories.includes(category);
}

function truncateContent(content, maxLength) {
  if (typeof content !== 'string') {
    content = JSON.stringify(content);
  }
  
  if (content.length <= maxLength) return content;
  return content.substring(0, maxLength - 3) + '...';
}

function redactSensitiveArgs(toolName, args) {
  if (!args || typeof args !== 'object') return args;
  
  const redacted = { ...args };
  
  // Redact message content for messaging tools
  if (TOOL_CATEGORIES[toolName] === 'messaging' && redacted.content) {
    redacted.content = truncateContent(redacted.content, 100);
  }
  
  // Redact sensitive fields
  const sensitiveFields = ['token', 'password', 'secret', 'key', 'auth'];
  for (const field of sensitiveFields) {
    if (redacted[field]) {
      redacted[field] = '[REDACTED]';
    }
  }
  
  return redacted;
}

function generateRequestId() {
  return 'req_' + crypto.randomBytes(6).toString('hex');
}

function logToolCall(agent, toolName, args, result, durationMs, context = {}) {
  if (!shouldLogTool(toolName)) return;
  
  const entry = {
    timestamp: new Date().toISOString(),
    request_id: generateRequestId(),
    agent: agent || 'unknown',
    tool: toolName,
    category: TOOL_CATEGORIES[toolName] || 'unknown',
    args: redactSensitiveArgs(toolName, args),
    result: result ? {
      success: !result.error,
      ...(result.error ? { error: truncateContent(result.error, 200) } : {}),
      ...(result.messageId ? { messageId: result.messageId } : {}),
      ...(result.success !== undefined ? { success: result.success } : {})
    } : null,
    duration_ms: Math.round(durationMs || 0),
    context: {
      ...context,
      session_id: context.session_id || 'sess_' + crypto.randomBytes(4).toString('hex')
    }
  };
  
  // Truncate large args/results only when serializing (never parse truncated JSON)
  const argsStr = JSON.stringify(entry.args);
  if (argsStr && argsStr.length > AUDIT_ARGS_MAX_LENGTH) {
    entry.args = { _truncated: true, preview: argsStr.substring(0, AUDIT_ARGS_MAX_LENGTH) };
  }
  const resultStr = JSON.stringify(entry.result);
  if (resultStr && resultStr.length > AUDIT_RESULT_MAX_LENGTH) {
    entry.result = { _truncated: true, preview: resultStr.substring(0, AUDIT_RESULT_MAX_LENGTH) };
  }
  
  // Add to pending writes for batch processing
  pendingWrites.push(entry);
  
  // Schedule batch write
  if (!writeTimer) {
    writeTimer = setTimeout(flushPendingWrites, 100); // 100ms batch window
  }
}

function flushPendingWrites() {
  if (pendingWrites.length === 0) return;
  
  const entries = [...pendingWrites];
  pendingWrites = [];
  writeTimer = null;
  
  // Async write to avoid blocking MCP calls
  setImmediate(() => {
    try {
      const lines = entries.map(entry => JSON.stringify(entry)).join('\n') + '\n';
      fs.appendFileSync(auditFile, lines, 'utf8');
      
      // Check if rotation is needed
      checkRotation();
    } catch (e) {
      console.error('[audit] Failed to write entries:', e.message);
      // Re-queue failed entries
      pendingWrites.unshift(...entries);
    }
  });
}

function checkRotation() {
  if (!auditFile || !fs.existsSync(auditFile)) return;
  
  try {
    const stats = fs.statSync(auditFile);
    if (stats.size >= AUDIT_MAX_SIZE) {
      rotateAuditFile();
    }
  } catch (e) {
    console.error('[audit] Failed to check file size:', e.message);
  }
}

function rotateAuditFile() {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const archiveName = `audit_log_${timestamp}.jsonl`;
  const archivePath = path.join(path.dirname(auditFile), archiveName);
  
  try {
    // Move current file to archive
    fs.renameSync(auditFile, archivePath);
    
    // Create new audit file
    fs.writeFileSync(auditFile, '', 'utf8');
    
    console.log(`[audit] Rotated audit log to ${archiveName}`);
    
    // Compress archive in background
    setImmediate(() => compressArchive(archivePath));
  } catch (e) {
    console.error('[audit] Failed to rotate audit log:', e.message);
  }
}

function compressArchive(archivePath) {
  try {
    const zlib = require('zlib');
    const readStream = fs.createReadStream(archivePath);
    const writeStream = fs.createWriteStream(archivePath + '.gz');
    const gzip = zlib.createGzip();
    
    readStream.pipe(gzip).pipe(writeStream);
    
    writeStream.on('finish', () => {
      // Remove uncompressed archive
      fs.unlinkSync(archivePath);
      console.log(`[audit] Compressed archive: ${path.basename(archivePath)}.gz`);
    });
  } catch (e) {
    console.error('[audit] Failed to compress archive:', e.message);
  }
}

function cleanupOldArchives() {
  if (!auditFile) return;
  
  const auditDir = path.dirname(auditFile);
  const cutoffTime = Date.now() - (AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000);
  
  try {
    const files = fs.readdirSync(auditDir);
    for (const file of files) {
      if (file.startsWith('audit_log_') && (file.endsWith('.jsonl') || file.endsWith('.jsonl.gz'))) {
        const filePath = path.join(auditDir, file);
        const stats = fs.statSync(filePath);
        
        if (stats.mtime.getTime() < cutoffTime) {
          fs.unlinkSync(filePath);
          console.log(`[audit] Cleaned up old archive: ${file}`);
        }
      }
    }
  } catch (e) {
    console.error('[audit] Failed to cleanup old archives:', e.message);
  }
}

function readAuditLog(filters = {}) {
  if (!auditFile || !fs.existsSync(auditFile)) return [];
  
  try {
    const content = fs.readFileSync(auditFile, 'utf8');
    const lines = content.trim().split('\n').filter(line => line.trim());
    
    let entries = lines.map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    }).filter(entry => entry !== null);
    
    // Apply filters
    if (filters.agent) {
      entries = entries.filter(e => e.agent === filters.agent);
    }
    if (filters.tool) {
      entries = entries.filter(e => e.tool === filters.tool);
    }
    if (filters.category) {
      entries = entries.filter(e => e.category === filters.category);
    }
    if (filters.since) {
      const sinceTime = new Date(filters.since).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() >= sinceTime);
    }
    if (filters.until) {
      const untilTime = new Date(filters.until).getTime();
      entries = entries.filter(e => new Date(e.timestamp).getTime() <= untilTime);
    }
    
    // Sort by timestamp (newest first)
    entries.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
    
    // Apply limit
    const limit = parseInt(filters.limit) || 100;
    return entries.slice(0, limit);
  } catch (e) {
    console.error('[audit] Failed to read audit log:', e.message);
    return [];
  }
}

function getAuditStats(filters = {}) {
  const entries = readAuditLog(filters);
  
  const stats = {
    total_calls: entries.length,
    agents: {},
    tools: {},
    categories: {},
    success_rate: 0,
    avg_duration_ms: 0
  };
  
  let successCount = 0;
  let totalDuration = 0;
  
  for (const entry of entries) {
    // Agent stats
    stats.agents[entry.agent] = (stats.agents[entry.agent] || 0) + 1;
    
    // Tool stats
    stats.tools[entry.tool] = (stats.tools[entry.tool] || 0) + 1;
    
    // Category stats
    stats.categories[entry.category] = (stats.categories[entry.category] || 0) + 1;
    
    // Success tracking
    if (entry.result && entry.result.success !== false) {
      successCount++;
    }
    
    // Duration tracking
    if (entry.duration_ms) {
      totalDuration += entry.duration_ms;
    }
  }
  
  stats.success_rate = entries.length > 0 ? Math.round((successCount / entries.length) * 100) : 0;
  stats.avg_duration_ms = entries.length > 0 ? Math.round(totalDuration / entries.length) : 0;
  
  return stats;
}

module.exports = {
  init,
  logToolCall,
  readAuditLog,
  getAuditStats,
  shouldLogTool,
  TOOL_CATEGORIES,
  AUDIT_LEVELS
};