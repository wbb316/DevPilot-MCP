import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { JobStore, jobLogFile, newJobId } from '../../src/runner/job-store.js';
import { ensureWorkspaceLayout, workspacePaths } from '../../src/storage/paths.js';
import type { WorkspacePaths } from '../../src/types/workspace.js';
import type { JobRecord } from '../../src/types/execution.js';
import { makeTempDir, removeDir } from '../helpers/index.js';

let root: string;
let paths: WorkspacePaths;

function makeJob(id: string, overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    jobId: id,
    kind: 'build',
    command: 'python',
    args: ['-m', 'compileall', '-q', '.'],
    cwd: root,
    startedAt: new Date().toISOString(),
    exitCode: 0,
    timedOut: false,
    stdoutBytes: 10,
    stderrBytes: 0,
    stdoutTruncated: false,
    stderrTruncated: false,
    logFile: jobLogFile(paths, id),
    ...overrides,
  };
}

beforeAll(async () => {
  root = await makeTempDir('devpilot-jobs-');
  paths = workspacePaths(root);
  await ensureWorkspaceLayout(paths);
});

afterAll(async () => {
  await removeDir(root);
});

describe('JobStore', () => {
  it('records jobs and returns the newest first', async () => {
    const store = new JobStore(paths);
    await store.record(makeJob('j1'));
    await store.record(makeJob('j2'));
    await store.record(makeJob('j3', { kind: 'run', exitCode: 1 }));

    const recent = await store.recent({ limit: 2 });
    expect(recent.map((job) => job.jobId)).toEqual(['j3', 'j2']);

    const builds = await store.recent({ kind: 'build' });
    expect(builds.map((job) => job.jobId)).toEqual(['j2', 'j1']);
  });

  it('finds the last failed job', async () => {
    const store = new JobStore(paths);
    const failed = await store.lastFailed('run');
    expect(failed?.jobId).toBe('j3');
    expect(await store.lastFailed('benchmark')).toBeUndefined();
  });

  it('compacts the ledger once it exceeds twice the retention', async () => {
    const store = new JobStore(paths, 2);
    for (let i = 0; i < 6; i += 1) await store.record(makeJob(`c${i}`));
    const recent = await store.recent({ limit: 10 });
    expect(recent.length).toBeLessThanOrEqual(4);
    expect(recent[0]?.jobId).toBe('c5');
  });

  it('survives an unreadable ledger', async () => {
    const store = new JobStore({ ...paths, logsDir: `${paths.logsDir}-missing` }, 2);
    expect(await store.recent()).toEqual([]);
    expect(await store.lastFailed()).toBeUndefined();
  });
});

describe('newJobId', () => {
  it('is prefixed by kind and unique', () => {
    const a = newJobId('build', new Date('2025-01-02T03:04:05Z'));
    const b = newJobId('build', new Date('2025-01-02T03:04:05Z'));
    expect(a.startsWith('build-20250102-030405-')).toBe(true);
    expect(a).not.toBe(b);
  });
});
