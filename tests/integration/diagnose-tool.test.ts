import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { runTestsTool } from '../../src/tools/run-tests';
import { diagnoseFailureTool } from '../../src/tools/diagnose-failure';
import { copyFixture, gitInit, makeTempDir, removeDir, writeFiles } from '../helpers/index';

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  error?: { code: string; message: string; hint?: string; details?: unknown };
  warnings?: string[];
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

interface TestData {
  failed: number;
  job: { jobId: string; logFile: string };
}

interface DiagnosisData {
  category: string;
  confidence: string;
  location?: { path: string; line?: number };
  evidence: string[];
  suspectFiles: { path: string; reason: string }[];
  relatedJob?: { jobId: string; command: string; exitCode: number | null };
  hint?: string;
  logFile?: string;
  notes?: string[];
}

/** The failing test is written so the assertion line number is known: line 3. */
const FAILING_TEST = [
  'def test_deliberate_failure():',
  '    total = 1 + 1',
  "    assert total == 3, 'one plus one is not three'",
  '',
].join('\n');

describe('diagnose_failure against a real failing run', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;
  let failingJobId: string;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-test-diagnose-home-');
    workspace = await makeTempDir('devpilot-test-diagnose-ws-');
    await copyFixture('python-project', workspace);
    await gitInit(workspace);
    // Two deliberate deltas: an untracked failing test, and a modified tracked file.
    await writeFiles(workspace, { 'tests/test_zz_failing.py': FAILING_TEST });
    await fs.appendFile(path.join(workspace, 'model.py'), '\n# touched by the diagnose test\n', 'utf8');
    context = await ServerContext.create({ home, logger: silentLogger() });
    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(opened.isError).toBe(false);
  }, 120_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(workspace);
  });

  it('reports FILE_NOT_FOUND while nothing has failed in this workspace', async () => {
    const result = await invokeTool(context, diagnoseFailureTool, {});
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('FILE_NOT_FOUND');
    expect(envelopeOf(result).error?.hint ?? '').toMatch(/run_tests/);
  });

  it('diagnoses the failing run without handing back the log', async () => {
    const run = await invokeTool(context, runTestsTool, {});
    expect(run.isError).toBe(true);
    const runEnvelope = envelopeOf<TestData>(run);
    expect(runEnvelope.error?.code).toBe('TEST_FAILED');
    const runData = runEnvelope.error?.details as TestData;
    expect(runData.failed).toBeGreaterThanOrEqual(1);
    failingJobId = runData.job.jobId;

    const result = await invokeTool(context, diagnoseFailureTool, {});
    expect(result.isError).toBe(false);
    const envelope = envelopeOf<DiagnosisData>(result);
    const data = envelope.data as DiagnosisData;

    expect(data.category).toBe('ASSERTION_FAILED');
    // A failing assertion is a weak rule (it reports a symptom, not the cause): medium is honest.
    expect(data.confidence).toBe('medium');
    expect(data.location).toEqual({ path: 'tests/test_zz_failing.py', line: 3 });
    expect(data.evidence.length).toBeGreaterThan(0);
    expect(data.evidence.length).toBeLessThanOrEqual(9);
    expect(data.evidence.join('\n')).toContain('one plus one is not three');
    expect(data.evidence[0]).toContain('tests/test_zz_failing.py:3 |');
    expect(data.relatedJob?.jobId).toBe(failingJobId);
    expect(data.relatedJob?.exitCode).not.toBe(0);
    expect(data.logFile ?? '').toMatch(/\.devpilot[\\/]logs[\\/]/);
    expect(data.hint ?? '').toMatch(/expectation/i);

    const suspects = data.suspectFiles.map((suspect) => `${suspect.reason}:${suspect.path}`);
    expect(suspects).toContain('in_stack:tests/test_zz_failing.py');
    expect(suspects).toContain('recently_changed:model.py');
    expect(envelope.summary ?? '').toMatch(/ASSERTION_FAILED/);
    expect(envelope.summary ?? '').toMatch(/tests\/test_zz_failing\.py:3/);
  }, 180_000);

  it('accepts an explicit jobId from the ledger', async () => {
    const result = await invokeTool(context, diagnoseFailureTool, { jobId: failingJobId });
    expect(result.isError).toBe(false);
    const data = envelopeOf<DiagnosisData>(result).data as DiagnosisData;
    expect(data.relatedJob?.jobId).toBe(failingJobId);
    expect(data.category).toBe('ASSERTION_FAILED');
  });

  it('can be pointed at a log file, but not one outside the workspace', async () => {
    const inside = await invokeTool(context, diagnoseFailureTool, {
      jobId: failingJobId,
      logFile: `.devpilot/logs/${failingJobId}.log`,
      maxEvidence: 2,
    });
    expect(inside.isError).toBe(false);
    expect((envelopeOf<DiagnosisData>(inside).data as DiagnosisData).evidence.length).toBeLessThanOrEqual(3);

    const outside = await invokeTool(context, diagnoseFailureTool, { logFile: '../../outside.log' });
    expect(outside.isError).toBe(true);
    expect(envelopeOf(outside).error?.code).toBe('PATH_OUTSIDE_WORKSPACE');
  });

  it('returns a structured error for an unknown job id', async () => {
    const result = await invokeTool(context, diagnoseFailureTool, { jobId: 'test-nope' });
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('FILE_NOT_FOUND');
  });
});
