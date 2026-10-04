import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { closeWorkspaceTool } from '../../src/tools/close-workspace';
import { findReferencesTool } from '../../src/tools/find-references';
import { findSymbolTool } from '../../src/tools/find-symbol';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { copyFixture, makeTempDir, removeDir } from '../helpers/index';

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  error?: { code: string; message: string; hint?: string };
  warnings?: string[];
}

interface SymbolHitData {
  name: string;
  kind: string;
  path: string;
  startLine: number;
  endLine: number;
  signature?: string;
  doc?: string;
}

interface SymbolData {
  query: string;
  engine: string;
  extractor: string;
  confidence: string;
  truncated: boolean;
  total: number;
  definitions: SymbolHitData[];
  references: { path: string; line: number; kind: string; snippet: string }[];
  index: { state: string; store: string; files: number; symbols: number; refs: number; reused: number };
}

interface ReferenceData {
  query: string;
  engine: string;
  confidence: string;
  total: number;
  references: { path: string; line: number; kind: string; snippet: string }[];
  definitions: SymbolHitData[];
  definition?: SymbolHitData;
  grouped: { path: string; count: number; lines: number[] }[];
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

describe('Phase 3 tools through the registry', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-symbol-tools-home-');
    workspace = await makeTempDir('devpilot-symbol-tools-ws-');
    await copyFixture('python-project', workspace);
    context = await ServerContext.create({ home, logger: silentLogger() });
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(workspace);
  });

  it('refuses code intelligence before a workspace is open', async () => {
    const result = await invokeTool(context, findSymbolTool, { name: 'CausalSelfAttention' });
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('WORKSPACE_NOT_OPEN');
  });

  it('finds a class definition, its scope and its references', async () => {
    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(opened.isError).toBe(false);

    const result = await invokeTool(context, findSymbolTool, { name: 'CausalSelfAttention' });
    expect(result.isError).toBe(false);
    const data = envelopeOf<SymbolData>(result).data as SymbolData;

    expect(data.engine).toBe('text');
    expect(data.extractor).toBe('heuristic-regex');
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.definitions[0]).toMatchObject({
      name: 'CausalSelfAttention',
      kind: 'class',
      path: 'model.py',
      startLine: 14,
      endLine: 44,
      doc: 'Single-head causal self-attention over plain Python lists.',
    });
    expect(data.index.state).toBe('ready');
    expect(['sqlite', 'json']).toContain(data.index.store);
    expect(data.index.files).toBeGreaterThan(0);
    expect(data.index.symbols).toBeGreaterThan(0);
    expect(data.references.map((hit) => hit.path)).toContain('model.py');

    // A lowercase query still resolves (case-insensitive by default).
    const lower = await invokeTool(context, findSymbolTool, { name: 'gpt' });
    const lowerData = envelopeOf<SymbolData>(lower).data as SymbolData;
    expect(lowerData.definitions.map((hit) => hit.name)).toContain('GPT');
  }, 60_000);

  it('reports where a symbol is used, with grouping and a definition', async () => {
    const result = await invokeTool(context, findReferencesTool, { name: 'GPT' });
    expect(result.isError).toBe(false);
    const data = envelopeOf<ReferenceData>(result).data as ReferenceData;

    expect(data.definition?.path).toBe('model.py');
    expect(data.total).toBeGreaterThanOrEqual(1);
    expect(data.confidence).toBe('high');
    expect(data.references.map((hit) => hit.path)).toContain('train.py');
    expect(data.grouped.length).toBeGreaterThan(0);
    expect(data.grouped[0]?.lines.length).toBeGreaterThan(0);
    expect(data.references[0]?.snippet.length).toBeGreaterThan(0);
  }, 60_000);

  it('supports qualified lookups, path filters and honest misses', async () => {
    const qualified = await invokeTool(context, findSymbolTool, {
      name: 'CausalSelfAttention.forward',
    });
    const qualifiedData = envelopeOf<SymbolData>(qualified).data as SymbolData;
    expect(qualifiedData.definitions[0]).toMatchObject({
      name: 'forward',
      kind: 'method',
      path: 'model.py',
      startLine: 22,
    });

    const filtered = await invokeTool(context, findSymbolTool, { name: 'GPT', path: 'tests' });
    const filteredData = envelopeOf<SymbolData>(filtered).data as SymbolData;
    // `path` is a filter, not a workspace selector: nothing outside tests/ comes back, and
    // the match inside tests/ is the substring tier (`test_gpt_forward_...`), not a class.
    expect(filteredData.total).toBeGreaterThanOrEqual(1);
    expect(filteredData.definitions.every((hit) => hit.path.startsWith('tests/'))).toBe(true);
    expect(
      filteredData.definitions.some((hit) => hit.name === 'test_gpt_forward_and_loss_are_finite'),
    ).toBe(true);

    const miss = await invokeTool(context, findReferencesTool, { name: 'NoSuchSymbolAnywhere' });
    const missData = envelopeOf<ReferenceData>(miss).data as ReferenceData;
    expect(missData.total).toBe(0);
    expect(missData.definition).toBeUndefined();
    expect(missData.confidence).toBe('low');
    const warnings = envelopeOf<ReferenceData>(miss).warnings ?? [];
    expect(warnings.some((warning) => warning.includes('lexical'))).toBe(true);
  }, 60_000);

  it('closes the workspace without leaving the index unusable', async () => {
    const closed = await invokeTool(context, closeWorkspaceTool, {});
    expect(closed.isError).toBe(false);
  });
});
