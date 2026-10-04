import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { closeWorkspaceTool } from '../../src/tools/close-workspace';
import { impactAnalysisTool } from '../../src/tools/impact-analysis';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { copyFixture, makeTempDir, removeDir } from '../helpers/index';

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  error?: { code: string; message: string; hint?: string };
  warnings?: string[];
}

interface AffectedFile {
  path: string;
  reason: string;
  confidence: string;
  distance: number;
  lines?: number[];
}

interface AffectedSymbol {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  reason: string;
}

interface ImpactData {
  target: string;
  targetKind: string;
  method: string;
  extractor: string;
  confidence: string;
  definition?: { name: string; kind: string; path: string; startLine: number; endLine: number };
  affectedFiles: AffectedFile[];
  affectedSymbols: AffectedSymbol[];
  relatedTests: string[];
  risks: { level: string; reason: string }[];
  riskLevel: string;
  notes: string[];
  truncated: boolean;
  totalAffected: number;
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

function dataOf(result: CallToolResult): ImpactData {
  return envelopeOf<ImpactData>(result).data as ImpactData;
}

describe('impact_analysis through the registry (Phase 8)', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-impact-home-');
    workspace = await makeTempDir('devpilot-impact-ws-');
    await copyFixture('python-project', workspace);
    context = await ServerContext.create({ home, logger: silentLogger() });
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(workspace);
  });

  it('refuses impact analysis before a workspace is open', async () => {
    const result = await invokeTool(context, impactAnalysisTool, { target: 'CausalSelfAttention' });
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('WORKSPACE_NOT_OPEN');
  });

  it('maps a symbol to its declaration, uses, importers and tests', async () => {
    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(opened.isError).toBe(false);

    const result = await invokeTool(context, impactAnalysisTool, { target: 'CausalSelfAttention' });
    expect(result.isError).toBe(false);
    const data = dataOf(result);

    expect(data.targetKind).toBe('symbol');
    expect(data.method).toBe('heuristic');
    expect(data.extractor).toBe('heuristic-regex');
    expect(data.definition).toMatchObject({ name: 'CausalSelfAttention', kind: 'class', path: 'model.py', startLine: 14 });
    expect(data.confidence).toBe('high');

    const paths = data.affectedFiles.map((file) => file.path);
    expect(paths).toContain('model.py');
    expect(paths).toContain('train.py');
    expect(data.affectedFiles.find((file) => file.path === 'model.py')?.reason).toBe('declaration');

    // The declaration itself is listed with its scope, and callers are resolved to their scope.
    expect(
      data.affectedSymbols.some(
        (symbol) => symbol.name === 'CausalSelfAttention' && symbol.reason === 'definition',
      ),
    ).toBe(true);

    // tests/ is a declared test directory, so relatedTests is populated and the risk is stated.
    expect(data.relatedTests).toContain('tests/test_model.py');
    expect(['HIGH', 'MEDIUM', 'LOW']).toContain(data.riskLevel);
    expect(data.risks.length).toBeGreaterThan(0);
    expect(data.notes.some((note) => note.includes('method heuristic'))).toBe(true);
    expect(data.notes.some((note) => note.includes('depth'))).toBe(true);
    expect(envelopeOf<ImpactData>(result).summary).toContain('heuristic');
  }, 60_000);

  it('treats an existing path as a file target', async () => {
    const result = await invokeTool(context, impactAnalysisTool, { target: 'model.py' });
    const data = dataOf(result);

    expect(data.targetKind).toBe('file');
    expect(data.affectedFiles.find((file) => file.path === 'model.py')?.reason).toBe('target');
    const declared = data.affectedSymbols.map((symbol) => symbol.name);
    expect(declared).toContain('CausalSelfAttention');
    expect(declared).toContain('GPT');
    // Symbols declared elsewhere that reference this file's symbols are not silently dropped.
    expect(data.affectedFiles.some((file) => file.path === 'train.py')).toBe(true);
  }, 60_000);

  it('treats a directory as a directory target', async () => {
    const result = await invokeTool(context, impactAnalysisTool, { target: 'tests' });
    const data = dataOf(result);

    expect(data.targetKind).toBe('directory');
    expect(data.affectedFiles.some((file) => file.path.startsWith('tests/'))).toBe(true);
    expect(data.affectedFiles.find((file) => file.path.startsWith('tests/'))?.reason).toBe('directory_member');
  }, 60_000);

  it('honours includeTests, depth and limit without hiding the tests', async () => {
    const result = await invokeTool(context, impactAnalysisTool, {
      target: 'GPT',
      includeTests: false,
      depth: 1,
      limit: 5,
    });
    const data = dataOf(result);

    expect(data.affectedFiles.length).toBeLessThanOrEqual(5);
    expect(data.relatedTests.length).toBeGreaterThan(0);
    expect(data.affectedFiles.some((file) => data.relatedTests.includes(file.path))).toBe(false);
    expect(data.notes.some((note) => note.includes('includeTests is false'))).toBe(true);
    expect(data.notes.some((note) => note.includes('depth 1'))).toBe(true);
  }, 60_000);

  it('stays honest about a name it cannot resolve', async () => {
    const result = await invokeTool(context, impactAnalysisTool, { target: 'NoSuchThingAnywhere' });
    expect(result.isError).toBe(false);
    const data = dataOf(result);

    expect(data.confidence).toBe('low');
    expect(data.definition).toBeUndefined();
    expect(data.affectedFiles).toHaveLength(0);
    expect(data.notes.some((note) => note.includes('lexical index'))).toBe(true);
    const warnings = envelopeOf<ImpactData>(result).warnings ?? [];
    expect(warnings.some((warning) => warning.includes('method heuristic'))).toBe(true);
  }, 60_000);

  it('closes the workspace cleanly afterwards', async () => {
    const closed = await invokeTool(context, closeWorkspaceTool, {});
    expect(closed.isError).toBe(false);
  });
});
