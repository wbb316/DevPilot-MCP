import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { auditDependencies } from '../environment/dependency-audit.js';
import type { DependencyAuditResult } from '../types/dependency.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `dependency_audit` — docs/TOOLS.md Phase 9. Read-only and workspace-scoped.
 *
 * Answers "what does this project depend on, and does the lock agree?" from the manifests
 * and lockfiles themselves: declared vs transitive counts per ecosystem, plus concrete lock
 * problems (a missing lockfile, a declaration the lock never resolved, an unpinned
 * specifier, one package at two versions, a `${property}` that resolves to nothing).
 *
 * Offline by default: `outdated[]` and `vulnerable[]` need a registry, so with
 * `network: false` (the default) this tool returns `outdated: []`, omits `vulnerable` and
 * says so in `notes` and `warnings`. It never opens a socket.
 */

const inputSchema = {
  path: workspacePathSchema,
  network: z
    .boolean()
    .optional()
    .describe(
      'Allow a registry lookup for outdated/vulnerable packages. Default false (offline): no network call is made in this build',
    ),
};

export const dependencyAuditTool = defineTool({
  name: 'dependency_audit',
  title: 'Dependency audit',
  description:
    'Audit declared and locked dependencies across npm, python, maven and gradle: per-ecosystem direct/transitive counts from the real manifests and lockfiles, plus lock problems (missing lockfile, declarations the lock does not contain, unpinned specifiers, one package at two versions, unresolved ${properties}). Offline by default — outdated/vulnerable need network:true and stay empty otherwise.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, logger } = requireWorkspaceContext(context.ctx, workspace);

    // Resolve the entry again so a `path` selector and the live state cannot diverge.
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const data: DependencyAuditResult = await auditDependencies(
      {
        root: entry.state.root,
        exclude: config.workspace.exclude,
        network: args.network === true,
      },
      logger,
    );

    const ecosystemSummary = data.ecosystems
      .map((profile) => `${profile.name} ${profile.direct} direct/${profile.transitive} transitive`)
      .join(', ');

    const warnings: string[] = [];
    if (data.network) {
      warnings.push('network:true was requested but this build has no registry client — outdated[] is empty');
    } else {
      warnings.push(
        'offline (network:false, the default): outdated[] is empty and vulnerable was not checked — a registry lookup is required for both',
      );
    }
    const errorsFound = data.lockIssues.filter((issue) => issue.severity === 'ERROR').length;
    if (errorsFound > 0) {
      warnings.push(`${errorsFound} lock problem(s) are reported as ERROR in lockIssues`);
    }

    const summary = [
      `dependencies: ${data.direct} direct, ${data.transitive} transitive across ${data.ecosystems.length} ecosystem(s)`,
      ecosystemSummary === '' ? 'no manifests found' : ecosystemSummary,
      `${data.lockIssues.length} lock issue(s)`,
      `offline (network: ${String(data.network)})`,
    ].join('; ');

    return ok(summary, data, { warnings });
  },
});
