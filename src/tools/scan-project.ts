import path from 'node:path';
import { z } from 'zod';

import type { ServerContext } from '../server/context.js';
import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { WorkspacePaths, WorkspaceState } from '../types/workspace.js';
import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { toPosix } from '../security/path-policy.js';
import { isUnsupported, scanProject } from '../workspace/project-scanner.js';
import { formatBytes, formatDuration } from '../util/format.js';
import { workspacePathSchema } from './shared.js';

/**
 * `scan_project` — docs/TOOLS.md Phase 2. Read-only, cache-aware, and the first tool an
 * agent should call after `open_workspace`.
 */

const inputSchema = {
  path: workspacePathSchema,
  force: z.boolean().optional().describe('Ignore the cache and rescan the whole tree'),
  include: z.array(z.string()).optional().describe('Only consider paths matching these globs'),
  exclude: z.array(z.string()).optional().describe('Additional exclude patterns (names or paths)'),
};

/** The workspace part of the session context, or a typed error. */
export function requireWorkspaceContext(
  ctx: ServerContext,
  workspace: WorkspaceState,
): { config: DevPilotConfig; paths: WorkspacePaths; logger: Logger | undefined } {
  const config = ctx.workspaces.configOf(workspace.id);
  const paths = ctx.workspaces.pathsOf(workspace.id);
  if (config === undefined || paths === undefined) {
    throw errors.internal(`workspace ${workspace.id} is open but its configuration is not loaded`);
  }
  return { config, paths, logger: ctx.workspaces.loggerOf(workspace.id) };
}

export const scanProjectTool = defineTool({
  name: 'scan_project',
  title: 'Scan project',
  description:
    'Scan the opened workspace: identify languages, project type, build/test systems, entrypoints, markers, top-level layout and file statistics. Results are cached in .devpilot/cache/project.json; pass force to rescan. Call this before analysing or modifying a project.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, paths, logger } = requireWorkspaceContext(context.ctx, workspace);

    // Resolve the entry again so `path` selectors and the live state cannot diverge.
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const result = await scanProject({
      root: entry.state.root,
      paths,
      config,
      name: entry.state.name,
      force: args.force === true,
      include: args.include,
      exclude: args.exclude,
      git: entry.state.git,
      logger,
    });

    if (isUnsupported(result.profile, result.languages)) {
      throw errors.unsupportedProject(
        `${entry.state.name} has no recognized project markers and no source files (${result.stats.files} file(s) scanned)`,
      );
    }

    context.ctx.workspaces.applyScan(entry.state.id, result.profile, result.indexState);

    const { profile, stats } = result;
    const summary = [
      `${profile.name}: ${profile.languages.join('/') || 'unknown'} / ${profile.projectType}${profile.framework === undefined ? '' : ` (${profile.framework})`}`,
      `${stats.files} files, ${stats.dirs} dirs, ${formatBytes(stats.bytes)}`,
      `scanned in ${formatDuration(stats.durationMs)}${stats.fromCache ? ' (cache hit)' : ''}`,
      `entrypoints: ${profile.entrypoints.slice(0, 3).join(', ') || 'none detected'}`,
    ].join('; ');

    const warnings: string[] = [];
    if (stats.truncated) {
      warnings.push(
        `file cap reached (${stats.files} files) — the profile is partial; raise workspace.max_files or narrow with include/exclude`,
      );
    }

    return ok(
      summary,
      {
        profile,
        stats,
        topLevel: result.topLevel,
        indexState: result.indexState,
        languages: result.languages,
        notes: result.notes,
        cacheFile: toPosix(path.relative(entry.state.root, result.cacheFile)),
      },
      { warnings },
    );
  },
});
