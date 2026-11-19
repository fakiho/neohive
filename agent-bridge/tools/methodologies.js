'use strict';

module.exports = function (ctx) {
  const { state, helpers } = ctx;
  const { inspectMethodology, runtimeDiagnostics, dataDir } = helpers;

  function requireStatus(options) {
    if (!state.registeredName) return { error: 'You must call register() first' };
    try { return inspectMethodology(options); }
    catch (error) { return { error: error.message }; }
  }

  function methodologyStatus() {
    const status = requireStatus({ preflight: false, hashArtifacts: false });
    if (status.error) return status;
    const recommendation = status.next_action;
    const diag = runtimeDiagnostics ? runtimeDiagnostics(dataDir) : null;
    const result = Object.assign({}, status, {
      recommended_action: recommendation,
      next_action: recommendation && recommendation.workflow
        ? `Load and follow the installed ${recommendation.workflow} skill.`
        : recommendation && recommendation.reason || 'Call listen() to receive messages.',
    });
    if (diag) {
      result.runtime = {
        running_from_working_tree: diag.running_from_working_tree,
        installed_mcp_version: diag.installed_mcp_version,
        working_tree_version: diag.working_tree_version,
        stale_runtime: diag.stale_runtime,
        installed_mcp_has_bmad: diag.installed_mcp_has_bmad,
        missing_bmad_tools: diag.missing_bmad_tools_in_installed_mcp,
        data_dir: diag.data_dir,
      };
      if (!diag.installed_mcp_has_bmad && !diag.running_from_working_tree) {
        result.runtime_warning = 'The active MCP process was launched from the installed package, which does not include BMad tools. methodology_status reflects the working tree. Restart the MCP from the working tree or publish a new release to activate BMad tools in the installed MCP.';
      } else if (diag.stale_runtime) {
        result.runtime_warning = `The active MCP version (${diag.installed_mcp_version}) differs from the working tree (${diag.working_tree_version}). Restart the MCP process to pick up working-tree changes.`;
      }
    }
    return result;
  }

  function methodologyNextAction() {
    const status = requireStatus({ preflight: false, hashArtifacts: false });
    if (status.error) return status;
    return {
      methodology: status.id,
      installed: status.installed,
      enabled: status.enabled,
      compatible: status.compatible,
      mode: status.settings && status.settings.mode,
      recommendation: status.next_action,
      next_action: status.next_action && status.next_action.workflow
        ? `Load and follow the installed ${status.next_action.workflow} skill.`
        : status.next_action && status.next_action.reason || 'Call listen() to receive messages.',
    };
  }

  function methodologyDiagnostics() {
    if (!state.registeredName) return { error: 'You must call register() first' };
    const diag = runtimeDiagnostics ? runtimeDiagnostics(dataDir) : { error: 'runtimeDiagnostics helper not available' };
    const status = requireStatus({ preflight: true, hashArtifacts: false });
    const traceability = status && !status.error ? {
      stories_count: (status.stories || []).length,
      stories_with_tasks: (status.stories || []).filter((s) => s.assignment).length,
      stories_missing_tasks: (status.stories || []).filter((s) => !s.assignment).map((s) => s.id),
      gates_count: (status.gates || []).length,
      phases: status.phases || [],
      current_phase: status.current_phase || null,
      methodology_drift: !status.installed
        ? 'not_installed'
        : !status.compatible
          ? 'incompatible_version'
          : !status.enabled
            ? 'disabled'
            : 'ok',
    } : null;
    return {
      runtime: diag,
      traceability,
      preflight: status && !status.error ? status.preflight : null,
      installed: status && !status.error ? status.installed : null,
      compatible: status && !status.error ? status.compatible : null,
      version: status && !status.error ? status.version : null,
      supported_major: status && !status.error ? status.supported_major : null,
    };
  }

  function methodologyArtifacts(args) {
    const kind = String(args && args.kind || '').trim();
    const limit = Math.min(Math.max(Number(args && args.limit) || 50, 1), 200);
    const status = requireStatus({
      preflight: false,
      hashArtifacts: true,
      artifactHashLimit: limit,
      artifactHashKind: kind || null,
    });
    if (status.error) return status;
    let artifacts = status.artifacts || [];
    if (kind) artifacts = artifacts.filter((item) => item.kind === kind);
    return {
      methodology: status.id,
      count: artifacts.length,
      artifacts: artifacts.slice(0, limit),
      truncated: artifacts.length > limit,
    };
  }

  const definitions = [
    {
      name: 'methodology_status',
      description: 'Get the installed project methodology, lifecycle phases, story state, gates, artifacts, compatibility, and recommended next action. BMad files remain authoritative. Includes runtime diagnostics (source path, version, data-dir, installed-vs-working-tree signal) and a runtime_warning if the active MCP lacks BMad tools or is stale.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'methodology_next_action',
      description: 'Get the next recommended methodology workflow for this project without loading the full artifact index.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
    {
      name: 'methodology_artifacts',
      description: 'List authoritative methodology artifact references. Returns relative paths and hashes, not copied content.',
      inputSchema: {
        type: 'object',
        properties: {
          kind: { type: 'string', description: 'Optional artifact kind such as prd, architecture, story, gate, or sprint-status' },
          limit: { type: 'number', description: 'Maximum artifacts to return (default 50, max 200)' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'methodology_diagnostics',
      description: 'Full runtime and traceability diagnostics: MCP source path, neohive version, installed-vs-working-tree diff, data-dir, project-root, preflight checks, story-to-task traceability gaps, methodology drift, and missing gate signals. Use when debugging why methodology tools are unavailable or BMad state is inconsistent.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    },
  ];

  const handlers = {
    methodology_status: methodologyStatus,
    methodology_next_action: methodologyNextAction,
    methodology_artifacts: methodologyArtifacts,
    methodology_diagnostics: methodologyDiagnostics,
  };

  return { definitions, handlers };
};
