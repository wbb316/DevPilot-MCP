import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { acquireSymbolIndex } from '../code/index-registry.js';
import type { ReferenceHit, SymbolKind } from '../types/code.js';
import { SYMBOL_KINDS } from '../types/code.js';
import { pathFilterSchema, resolvePathFilter } from './shared.js';
import { requireWorkspaceContext } from './scan-project.js';

/**
 * `find_symbol` — docs/TOOLS.md Phase 3. Returns definitions plus the first page of
 * references, so one call answers "where is it and who uses it".
 */

const kindSchema = z.enum(SYMBOL_KINDS as unknown as [string, ...string[]]);

const inputSchema = {
  name: z
    .string()
    .min(1)
    .describe('Symbol name; `Container.member` is accepted for a qualified lookup'),
  kind: z.array(kindSchema).optional().describe('Restrict to these symbol kinds'),
  path: pathFilterSchema,
  caseSensitive: z.boolean().optional().describe('Default false (case-insensitive)'),
  limit: z.number().int().positive().max(200).optional().describe('Max definitions (default 50)'),
};

export const findSymbolTool = defineTool({
  name: 'find_symbol',
  title: 'Find symbol',
  description:
    'Find where a class/function/method/field is defined in the opened workspace, with the first references. The index is incremental (mtime+size) and reports its engine and confidence: matching is lexical, not a compiler. Prefer this over grepping by hand.',
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
    const search = index.findSymbols(args.name, {
      ...(args.kind === undefined ? {} : { kinds: args.kind as SymbolKind[] }),
      ...(pathFilter === undefined ? {} : { pathFilter }),
      ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });

    let references: ReferenceHit[] = [];
    if (search.total > 0) {
      const answer = await index.findReferences(args.name, {
        ...(pathFilter === undefined ? {} : { pathFilter }),
        ...(args.caseSensitive === undefined ? {} : { caseSensitive: args.caseSensitive }),
        limit: 20,
      });
      references = answer.result.results;
    }

    const first = search.results[0];
    const summary =
      search.total === 0
        ? `No definition found for "${args.name}" (engine ${search.engine}, ${index.counts().files} files indexed).`
        : `${search.total} definition(s) for "${args.name}"; first at ${first?.path}:${first?.startLine} (${first?.kind})${references.length > 0 ? `, ${references.length} reference(s)` : ''}.`;

    const warnings = [...report.notes];
    if (search.total === 0) {
      warnings.push(
        pathFilter === undefined
          ? 'no definition matched: check the spelling, or run scan_project { force: true } if the file was just added'
          : `no definition matched under the path filter "${pathFilter}" — the symbol may exist elsewhere in the workspace; drop or widen \`path\``,
      );
    } else if (first?.doc === undefined && first?.signature === undefined) {
      warnings.push('the matched definition has no signature/doc extracted (lexical parser)');
    }

    return ok(
      summary,
      {
        query: args.name,
        engine: search.engine,
        extractor: 'heuristic-regex',
        confidence: search.confidence,
        truncated: search.truncated,
        total: search.total,
        definitions: search.results,
        references,
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
