'use strict';

const agentLaunchProfiles = require('./agent-launch-profiles');
const bmad = require('./bmad-provider');

const RUNTIMES = Object.freeze({
  claude: {
    id: 'claude',
    label: 'Claude Code',
    capabilities: { mcp: true, filesystem: true, shell: true, skills: true, interactive: true },
  },
  gemini: {
    id: 'gemini',
    label: 'Gemini CLI',
    capabilities: { mcp: true, filesystem: true, shell: true, skills: true, interactive: true },
  },
  codex: {
    id: 'codex',
    label: 'Codex CLI',
    capabilities: { mcp: true, filesystem: true, shell: true, skills: true, interactive: true },
  },
  cursor: {
    id: 'cursor',
    label: 'Cursor Agent',
    capabilities: { mcp: true, filesystem: true, shell: true, skills: true, interactive: true },
  },
  opencode: {
    id: 'opencode',
    label: 'OpenCode',
    capabilities: { mcp: true, filesystem: true, shell: true, skills: true, interactive: true },
  },
  'ollama-claude': {
    id: 'ollama-claude',
    label: 'Claude Code via Ollama',
    capabilities: { mcp: true, filesystem: true, shell: true, skills: true, interactive: true, subagents: false },
  },
  'ollama-responder': {
    id: 'ollama-responder',
    label: 'Ollama responder',
    capabilities: { mcp: false, filesystem: false, shell: false, skills: false, interactive: true },
  },
});

const PROVIDERS = Object.freeze({
  bmad: {
    id: bmad.ID,
    label: bmad.LABEL,
    description: 'Structured analysis, planning, solutioning, and implementation workflows.',
    compatibility_label: 'Compatible with BMad Method v6',
    supported_major: bmad.SUPPORTED_MAJOR,
    modes: [
      { id: 'quick', label: 'Quick', description: 'Clarify, plan, implement, review, and present small changes.' },
      { id: 'full', label: 'Full', description: 'Use the complete analysis-to-implementation lifecycle.' },
    ],
    workflows: bmad.WORKFLOWS,
    required_capabilities: ['mcp', 'filesystem', 'shell', 'skills'],
  },
});

function getRuntime(runtime) {
  const descriptor = RUNTIMES[String(runtime || '')];
  if (!descriptor) throw new Error('Unsupported agent runtime');
  return descriptor;
}

function getMethodology(methodology) {
  const id = typeof methodology === 'string'
    ? methodology
    : methodology && methodology.id;
  if (!id || id === 'none') return null;
  const provider = PROVIDERS[String(id)];
  if (!provider) throw new Error('Unsupported methodology');
  return provider;
}

function assertRuntimeCompatibility(runtime, methodology) {
  const descriptor = getRuntime(runtime);
  const provider = getMethodology(methodology);
  if (!provider) return descriptor;
  const missing = provider.required_capabilities.filter((name) => descriptor.capabilities[name] !== true);
  if (missing.length) {
    throw new Error(`${provider.label} requires a tool-capable runtime; ${descriptor.label} is missing ${missing.join(', ')}`);
  }
  return descriptor;
}

function normalizeSelection(selection) {
  const provider = getMethodology(selection);
  if (!provider) return null;
  const raw = typeof selection === 'object' && selection ? selection : {};
  const normalized = bmad.normalizeModeWorkflow(raw.mode || 'quick', raw.workflow);
  return {
    id: provider.id,
    mode: normalized.mode,
    workflow: normalized.workflow,
  };
}

// AD-3: single source of the Neohive role -> BMad persona-skill mapping.
// Extend this table only — no per-call-site hardcoding. Unmapped/absent
// role resolves to null: no persona loaded, no error.
const ROLE_PERSONA_SKILLS = Object.freeze({
  analyst: 'bmad-agent-analyst',
  architect: 'bmad-agent-architect',
  dev: 'bmad-agent-dev',
  pm: 'bmad-agent-pm',
  ux: 'bmad-agent-ux-designer',
  'tech-writer': 'bmad-agent-tech-writer',
});

function getPersonaSkillForRole(role) {
  const key = String(role || '').trim().toLowerCase();
  return ROLE_PERSONA_SKILLS[key] || null;
}

function composeLaunchPrompt({ role, name, runtime, methodology, basePrompt }) {
  const suppliedPrompt = String(basePrompt || '').trim();
  const rolePrompt = suppliedPrompt || agentLaunchProfiles.buildRolePrompt(role, name);
  const selection = normalizeSelection(methodology);
  assertRuntimeCompatibility(runtime, selection);
  const personaSkill = selection ? getPersonaSkillForRole(role) : null;
  const personaLine = personaSkill
    ? `\nLoad the "${personaSkill}" BMad persona skill for this role before starting work.`
    : '';
  if (!selection) return { prompt: rolePrompt, methodology: null };
  const instructions = bmad.composeInstructions(selection);
  return {
    prompt: `${rolePrompt}\n${instructions}${personaLine}`,
    methodology: selection,
    persona_skill: personaSkill,
  };
}

function listMethodologies() {
  return {
    methodologies: Object.values(PROVIDERS),
    runtimes: Object.values(RUNTIMES),
  };
}

module.exports = {
  PROVIDERS,
  RUNTIMES,
  ROLE_PERSONA_SKILLS,
  assertRuntimeCompatibility,
  composeLaunchPrompt,
  getMethodology,
  getPersonaSkillForRole,
  getRuntime,
  listMethodologies,
  normalizeSelection,
};
