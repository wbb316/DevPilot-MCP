import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  formatCommandLine,
  resolveExecutable,
  runExecutable,
  runProcess,
  splitCommandLine,
} from '../../src/runner/process-runner';
import { makeTempDir, removeDir } from '../helpers/index';

describe('process runner (the single gate to the OS)', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await makeTempDir('devpilot-process-');
  });

  afterAll(async () => {
    await removeDir(dir);
  });

  it('captures stdout, stderr and the exit code', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'console.log("out");console.error("err");process.exit(3)'],
      cwd: dir,
    });
    expect(result.exitCode).toBe(3);
    expect(result.stdout.trim()).toBe('out');
    expect(result.stderr.trim()).toBe('err');
    expect(result.timedOut).toBe(false);
    expect(result.spawnError).toBeUndefined();
  });

  it('terminates a process that exceeds its timeout', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'setTimeout(() => {}, 30000)'],
      cwd: dir,
      timeoutMs: 1500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.durationMs).toBeLessThan(25_000);
  }, 30_000);

  it('caps output and flags truncation', async () => {
    const result = await runProcess({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("x".repeat(50000))'],
      cwd: dir,
      maxStdoutBytes: 1024,
    });
    expect(result.stdoutTruncated).toBe(true);
    expect(Buffer.byteLength(result.stdout, 'utf8')).toBeLessThanOrEqual(1024);
    expect(result.stdoutBytes).toBeGreaterThanOrEqual(1024);
  });

  it('tees raw output into a log file', async () => {
    const logFile = path.join(dir, 'nested', 'job.log');
    await runProcess({
      command: process.execPath,
      args: ['-e', 'console.log("logged")'],
      cwd: dir,
      logFile,
    });
    const text = await fs.readFile(logFile, 'utf8');
    expect(text).toContain('# command :');
    expect(text).toContain('logged');
    expect(text).toContain('# exit    : 0');
  });

  it('reports a missing binary as a spawn error instead of throwing', async () => {
    const result = await runProcess({ command: 'definitely-not-a-real-binary-xyz', args: [], cwd: dir });
    expect(result.spawnError).toBeDefined();
    expect(result.exitCode).toBeNull();
  });

  it('resolves executables without a shell', async () => {
    const git = await resolveExecutable('git');
    expect(git).toBeDefined();
    expect(await resolveExecutable('definitely-not-a-real-binary-xyz')).toBeUndefined();
  });

  // Regression: npm/mvn/gradlew are .cmd shims on Windows. Node escapes the quotes around
  // the shim path as \" when passing them to cmd.exe, which cmd does not understand, so
  // every one of those commands failed with "is not recognized as an internal command".
  it.skipIf(process.platform !== 'win32')(
    'runs a Windows .cmd shim whose path and arguments contain spaces',
    async () => {
      const shim = path.join(dir, 'probe shim.cmd');
      await fs.writeFile(
        shim,
        '@echo off\r\necho shim-arg:%1\r\necho shim-cwd:%CD%\r\nexit /b 0\r\n',
        'utf8',
      );
      const result = await runExecutable({
        command: shim,
        args: ['hello world'],
        cwd: dir,
        timeoutMs: 30_000,
      });
      expect(result.spawnError).toBeUndefined();
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('hello world');
      expect(result.stdout).toContain(`shim-cwd:${dir}`);
    },
    30_000,
  );

  it.skipIf(process.platform !== 'win32')('refuses shell syntax passed to a shim', async () => {
    const shim = path.join(dir, 'probe-refuse.cmd');
    await fs.writeFile(shim, '@echo off\r\nexit /b 0\r\n', 'utf8');
    await expect(runExecutable({ command: shim, args: ['a & b'], cwd: dir })).rejects.toThrow(
      /Windows command shim/,
    );
  });
});

describe('command line helpers', () => {
  it('formats a command line for logs', () => {
    expect(formatCommandLine('mvn', ['-q', 'test'])).toBe('mvn -q test');
    expect(formatCommandLine('node', ['-e', 'a b'])).toBe('node -e "a b"');
  });

  it('splits a rule-derived command line without shell expansion', () => {
    expect(splitCommandLine('python train.py --epochs 2')).toEqual({
      command: 'python',
      args: ['train.py', '--epochs', '2'],
    });
    expect(splitCommandLine('   ').command).toBe('');
  });
});
