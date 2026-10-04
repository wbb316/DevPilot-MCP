import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { acquireSymbolIndex } from '../code/index-registry.js';
import { pathFilterSchema, resolvePathFilter } from './shared.js';
import { requireWorkspaceContext } from './scan-project.js';

/**
 * `find_references` — docs/TOOLS.md Phase 3. Answers "where is this used?" with per-file
 * grouping and source snippets, and says plainly when there is no definition to anchor on.
 */

const inputSchema = {
  name: z
    .string()
    .min(1)
    .describe('Symbol name; `Container.member` narrows the definition by container'),
  path: pathFilterSchema,
  includeText: z
    .boolean()
    .optional()
    .describe('Also include text-kind hits (decorators/annotations). Default false'),
  caseSensitive: z.boolean().optional().describe('Default false (case-insensitive)'),
  limit: z.number().int().positive().max(500).optional().describe('Max references (default 100)'),
};

export const findReferencesTool = defineTool({
  name: 'find_references',
  title: 'Find references',
  description:
    'List the places a symbol is used in the opened workspace: call sites, type usages, imports, inheritance. Returns grouped counts, source snippets and the definition when one exists. Lexical engine with explicit confidence — check it before trusting a "nothing uses this" conclusion.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { config, paths, logger } = requireWorkspaceContext(context.ctx, workspace);

    const index = await acquireSymbolIndex({
      id: workspace.id,
      root: workspace.root,
      paths,
      config,
      ...(logger === undefined ? {} : { logger }),
    });

    let report;
    try {
      report = await index.refresh();
    } catch (error) {
      throw errors.indexFailed(
        `could not refresh the symbol index: ${error instanceof Error ? error.message : String(error)}`,
        { root: workspace.root },
      );
    }
    context.ctx.workspaces.setIndexState(workspace.id, report.indexState);

    const resolvedFilter = resolvePathFilter(args.path, workspace.root);
    if (resolvedFilter.outside !== undefined) {
      throw errors.pathOutsideWorkspace(resolvedFilter.outside, workspace.root);
    }
    const pathFilter = resolvedFilter.filter;
    const answer = await index.findReferences(args.name, {
      ...(pathFilter === undefined ? {} : { pathFilter }),
      ...(args.includeText === undefined ? {} : { includeText: args.includeText }),
      ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });

    const fileCount = answer.grouped.length;
    const summary =
      answer.result.total === 0
        ? `No references to "${args.name}" in ${index.counts().files} indexed files${answer.definition === undefined ? ' (no definition either)' : ''}.`
        : `${answer.result.total} reference(s) to "${args.name}" in ${fileCount} file(s)${answer.definition === undefined ? '; no definition found — these are textual usages' : `; defined at ${answer.definition.path}:${answer.definition.startLine}`}.`;

    const warnings = [...report.notes];
    if (answer.definition === undefined && answer.result.total > 0) {
      warnings.push(
        'no definition in the index for this name: hits may include same-named symbols from other scopes',
      );
    }
    if (answer.result.total === 0) {
      if (pathFilter !== undefined) {
        warnings.push(
          `no reference matched under the path filter "${pathFilter}" — usage may exist elsewhere in the workspace; drop or widen \`path\``,
        );
      }
      warnings.push(
        'a lexical index can miss dynamic usage (getattr, reflection, string-built names): absence of references is not proof of dead code',
      );
    }
    if (answer.result.truncated) {
      warnings.push(`reference list truncated at ${answer.result.results.length} of ${answer.result.total}`);
    }

    return ok(
      summary,
      {
        query: args.name,
        engine: answer.result.engine,
        extractor: 'heuristic-regex',
        confidence: answer.result.confidence,
        truncated: answer.result.truncated,
        total: answer.result.total,
        references: answer.result.results,
        definitions: answer.definitions,
        ...(answer.definition === undefined ? {} : { definition: answer.definition }),
        grouped: answer.grouped,
        index: {
          state: index.indexState,
          store: index.persistenceKind,
          files: index.counts().files,
          symbols: index.counts().symbols,
          refs: index.counts().refs,
          reused: report.reused,
          parsed: report.parsed,
        },
      },
      { warnings },
    );
  },
});
