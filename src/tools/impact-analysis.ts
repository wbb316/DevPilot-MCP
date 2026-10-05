import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { errors } from '../errors/devpilot-error.js';
import { acquireSymbolIndex } from '../code/index-registry.js';
import { analyzeImpact, DEFAULT_IMPACT_DEPTH } from '../impact/impact-analyzer.js';
import { requireWorkspaceContext } from './scan-project.js';

/**
 * `impact_analysis` — docs/TOOLS.md Phase 8.
 *
 * Answers "what does changing this touch?" before a single line is edited: declarations,
 * reference sites, importers up to `depth` hops, the tests that cover them, and the risks the
 * structure itself implies. Heuristic and explicit about it — the agent decides, DevPilot
 * supplies evidence.
 */

const inputSchema = {
  target: z
    .string()
    .min(1)
    .describe('Symbol name (optionally Container.member), workspace-relative file path, or directory'),
  kind: z
    .enum(['symbol', 'file', 'auto'])
    .optional()
    .describe('How to read `target`. Default auto: existing file/directory wins, else symbol'),
  depth: z
    .number()
    .int()
    .min(0)
    .max(5)
    .optional()
    .describe(`Import hops to follow from the direct files (default ${DEFAULT_IMPACT_DEPTH})`),
  includeTests: z
    .boolean()
    .optional()
    .describe('Keep test files in affectedFiles (default true; they stay in relatedTests either way)'),
  limit: z.number().int().positive().max(200).optional().describe('Max affected files listed (default 50)'),
};

export const impactAnalysisTool = defineTool({
  name: 'impact_analysis',
  title: 'Impact analysis',
  description:
    'Before changing code, find out what a symbol, file or directory touches: declarations, reference sites, importers up to N hops, the tests that cover them, and structural risks (high fan-in, wide reference count, manifest/config change, missing tests). Heuristic lexical analysis with stated confidence — treat it as a map, not a proof.',
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

    const result = await analyzeImpact(index, {
      target: args.target,
      root: workspace.root,
      ...(args.kind === undefined ? {} : { kind: args.kind }),
      ...(args.depth === undefined ? {} : { depth: args.depth }),
      ...(args.includeTests === undefined ? {} : { includeTests: args.includeTests }),
      ...(args.limit === undefined ? {} : { limit: args.limit }),
    });

    // A file target has no single `definition` (that field carries the symbol target's
    // declaration), so the summary counts the declarations the file itself holds — otherwise
    // it said "no declaration found" while `data.affectedSymbols` listed four of them.
    const declaredCount = result.affectedSymbols.filter((symbol) => symbol.reason === 'definition').length;
    const parts = [
      `${result.affectedFiles.length} of ${result.totalAffected} affected file(s)`,
      result.definition === undefined
        ? declaredCount > 0
          ? `${declaredCount} declaration(s) in the target`
          : 'no declaration found'
        : `declared at ${result.definition.path}:${result.definition.startLine}`,
      `${result.relatedTests.length} related test file(s)`,
    ];
    const topRisk = result.risks[0];
    const summary = `Impact of "${args.target}" (${result.targetKind}): ${parts.join(', ')}; risk ${result.riskLevel}${topRisk === undefined ? '' : ` — ${topRisk.reason}`} (heuristic, confidence ${result.confidence}).`;

    const warnings = [...report.notes];
    warnings.push(...result.notes);
    if (result.truncated) {
      warnings.push('the affected set is truncated: some affected files are not listed');
    }

    return ok(
      summary,
      {
        target: result.target,
        targetKind: result.targetKind,
        method: result.method,
        extractor: result.extractor,
        confidence: result.confidence,
        ...(result.definition === undefined ? {} : { definition: result.definition }),
        affectedFiles: result.affectedFiles,
        affectedSymbols: result.affectedSymbols,
        relatedTests: result.relatedTests,
        risks: result.risks,
        riskLevel: result.riskLevel,
        notes: result.notes,
        truncated: result.truncated,
        totalAffected: result.totalAffected,
        index: {
          state: index.indexState,
          store: index.persistenceKind,
          files: index.counts().files,
          symbols: index.counts().symbols,
          refs: index.counts().refs,
          parsed: report.parsed,
          reused: report.reused,
        },
      },
      { warnings },
    );
  },
});
