import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { buildProjectMap } from '../workspace/project-map.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/**
 * `get_project_map` — docs/TOOLS.md Phase 2. The navigation view an agent needs instead of
 * a directory dump: entrypoints, modules, their notable symbols and the dependency edges.
 */

const inputSchema = {
  path: workspacePathSchema,
  depth: z.number().int().min(1).max(10).default(3).describe('Graph hops explored around `focus`'),
  focus: z.string().optional().describe('Centre the map on this module (file or directory)'),
  includeTests: z.boolean().default(false).describe('Include test files as modules'),
};

export const getProjectMapTool = defineTool({
  name: 'get_project_map',
  title: 'Get project map',
  description:
    'Return the project map: entrypoints with import counts, every source module with its notable symbols, and the dependsOn/usedBy edges between them. Use it to understand where a change belongs before editing. Set focus to centre the map on one module (with depth hops of context). Java projects also get a layers hint.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, logger } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const map = await buildProjectMap({
      root: entry.state.root,
      profile: entry.state.profile,
      config,
      depth: args.depth,
      focus: args.focus,
      includeTests: args.includeTests,
      logger,
    });

    const entrypointList = map.entrypoints.map((entrypoint) => entrypoint.path).join(', ') || 'none detected';
    const summary = [
      `${map.modules.length} module(s) mapped`,
      `entrypoints: ${entrypointList}`,
      `${map.engine} engine`,
      map.layers === undefined ? '' : `layers: ${map.layers.join(' → ')}`,
    ]
      .filter((part) => part !== '')
      .join('; ');

    const warnings: string[] = [];
    if (map.truncated) {
      warnings.push('module cap reached — the map is partial; narrow the map with focus or raise the cap');
    }

    return ok(
      summary,
      {
        entrypoints: map.entrypoints,
        modules: map.modules,
        ...(map.layers === undefined ? {} : { layers: map.layers }),
        notes: map.notes,
        engine: map.engine,
        truncated: map.truncated,
      },
      { warnings },
    );
  },
});
