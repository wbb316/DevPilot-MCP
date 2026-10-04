import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { parseTestTarget, runTestTool } from '../../src/tools/run-test';
import { runTestsTool } from '../../src/tools/run-tests';
import { copyFixture, makeTempDir, removeDir } from '../helpers/index';

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  /** Error envelopes carry the structured result here (docs/TOOLS.md Phase 4 note). */
  error?: { code: string; message: string; hint?: string; details?: T };
  warnings?: string[];
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

interface TestData {
  status: string;
  framework: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  failures: { name: string; path?: string; line?: number; message: string }[];
  parsed: boolean;
  commandLine: string;
  logFile: string;
  parser: string;
  selection?: { target: string; file?: string; filter?: string };
}

async function readTool(path_: string): Promise<string> {
  return fs.readFile(path.join(process.cwd(), path_), 'utf8');
}

describe('run_tests / run_test against real runners', () => {
  let context: ServerContext;
  let home: string;
  let pythonWorkspace: string;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-test-tools-home-');
    pythonWorkspace = await makeTempDir('devpilot-test-tools-py-');
    await copyFixture('python-project', pythonWorkspace);
    context = await ServerContext.create({ home, logger: silentLogger() });
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(pythonWorkspace);
  });

  it('refuses to run tests with no workspace open', async () => {
    const result = await invokeTool(context, runTestsTool, {});
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('WORKSPACE_NOT_OPEN');
  });

  it('runs the Python fixture suite and returns parsed counts', async () => {
    const opened = await invokeTool(context, openWorkspaceTool, { path: pythonWorkspace });
    expect(opened.isError).toBe(false);

    const result = await invokeTool(context, runTestsTool, {});
    expect(result.isError).toBe(false);
    const envelope = envelopeOf<TestData>(result);
    const data = envelope.data as TestData;
    expect(data.framework).toBe('pytest');
    expect(data.parsed).toBe(true);
    expect(data.status).toBe('passed');
    expect(data.failed).toBe(0);
    expect(data.total).toBeGreaterThanOrEqual(3);
    expect(data.passed).toBe(data.total);
    expect(data.commandLine).toContain('pytest');
    expect(data.logFile).toMatch(/jobs|test/);
    expect(envelope.summary ?? '').toMatch(/passed/);
  }, 120_000);

  it('selects a single Python test through run_test', async () => {
    const result = await invokeTool(context, runTestTool, {
      target: 'tests/test_model.py::test_causal_attention_keeps_shape',
    });
    expect(result.isError).toBe(false);
    const data = envelopeOf<TestData>(result).data as TestData;
    expect(data.selection?.file).toBe('tests/test_model.py');
    expect(data.selection?.filter).toBe('test_causal_attention_keeps_shape');
    expect(data.total).toBe(1);
    expect(data.failed).toBe(0);
  }, 120_000);

  it('returns TEST_FAILED with the failing test extracted, not a log dump', async () => {
    const failing = await makeTempDir('devpilot-test-tools-fail-');
    try {
      await copyFixture('node-project', failing);
      await fs.writeFile(
        path.join(failing, 'test', 'zz_failing.test.js'),
        [
          "import test from 'node:test';",
          "import assert from 'node:assert/strict';",
          '',
          "test('subtract works', () => {",
          '  assert.equal(2 - 1, 2);',
          '});',
          '',
        ].join('\n'),
        'utf8',
      );

      const opened = await invokeTool(context, openWorkspaceTool, { path: failing });
      expect(opened.isError).toBe(false);

      const result = await invokeTool(context, runTestsTool, {});
      expect(result.isError).toBe(true);
      const envelope = envelopeOf<TestData>(result);
      expect(envelope.error?.code).toBe('TEST_FAILED');
      const data = envelope.error?.details as TestData;
      expect(data.status).toBe('failed');
      expect(data.parsed).toBe(true);
      expect(data.failed).toBeGreaterThanOrEqual(1);
      expect(data.failures.map((failure) => failure.name)).toContain('subtract works');
      expect(data.failures[0]?.message ?? '').toMatch(/expected|equal|2/i);
      expect(envelope.error?.message ?? '').toMatch(/failing tests/i);
    } finally {
      await removeDir(failing);
    }
  }, 180_000);
});

describe('parseTestTarget', () => {
  it('splits file::test, Class#method, files and bare names', () => {
    expect(parseTestTarget('tests/test_model.py::test_add')).toEqual({
      target: 'tests/test_model.py::test_add',
      file: 'tests/test_model.py',
      filter: 'test_add',
    });
    expect(parseTestTarget('UserServiceTest#lengthOfTitle')).toEqual({
      target: 'UserServiceTest#lengthOfTitle',
      filter: 'UserServiceTest#lengthOfTitle',
    });
    expect(parseTestTarget('src/foo.test.ts')).toEqual({
      target: 'src/foo.test.ts',
      file: 'src/foo.test.ts',
    });
    expect(parseTestTarget('test_add')).toEqual({ target: 'test_add', filter: 'test_add' });
  });

  it('rejects an empty target', () => {
    expect(() => parseTestTarget('   ')).toThrowError(/must not be empty/);
  });

  it('fixture paths used by this suite really exist', async () => {
    const body = await readTool('fixtures/python-project/tests/test_model.py');
    expect(body).toContain('def test_causal_attention_keeps_shape');
  });
});
