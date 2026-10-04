import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { CliIo } from '../../src/cli/cli';
import { parseArgv, runCli } from '../../src/cli/cli';
import { copyFixture, gitInit, makeTempDir, removeDir } from '../helpers/index';

function capture(env: NodeJS.ProcessEnv, cwd: string): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      stdout: (text) => out.push(text),
      stderr: (text) => err.push(text),
      cwd,
      env,
    },
    out,
    err,
  };
}

describe('CLI', () => {
  let home: string;
  let workspace: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-cli-home-');
    workspace = await makeTempDir('devpilot-cli-ws-');
    await copyFixture('python-project', workspace);
    await gitInit(workspace);
    env = { ...process.env, DEVPILOT_HOME: home };
  });

  afterAll(async () => {
    await removeDir(home);
    await removeDir(workspace);
  });

  it('parses commands, positionals and flags', () => {
    expect(parseArgv(['init', 'D:/x', '--write-gitignore'])).toMatchObject({
      command: 'init',
      positionals: ['D:/x'],
    });
    expect(parseArgv(['status', '--json']).flags.get('json')).toBe(true);
    expect(parseArgv(['--home=C:/h']).flags.get('home')).toBe('C:/h');
    expect(parseArgv([]).command).toBeUndefined();
  });

  it('prints usage and version', async () => {
    const help = capture(env, workspace);
    expect(await runCli(['help'], help.io)).toBe(0);
    expect(help.out.join('')).toMatch(/Usage: devpilot/);

    const version = capture(env, workspace);
    expect(await runCli(['version'], version.io)).toBe(0);
    expect(version.out.join('').trim()).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it('rejects unknown commands with exit code 2', async () => {
    const unknown = capture(env, workspace);
    expect(await runCli(['frobnicate'], unknown.io)).toBe(2);
    expect(unknown.err.join('')).toMatch(/Unknown command: frobnicate/);
  });

  it('runs doctor against this machine', async () => {
    const doctor = capture(env, workspace);
    const code = await runCli(['doctor', workspace], doctor.io);
    expect([0, 1]).toContain(code);
    expect(doctor.out.join('')).toMatch(/Toolchains:/);
    expect(doctor.out.join('')).toMatch(/Overall: (OK|WARNING|ERROR)/);
  }, 120_000);

  it('scans a project, prints the summary and reuses the cache', async () => {
    const first = capture(env, workspace);
    expect(await runCli(['scan', workspace], first.io)).toBe(0);
    const output = first.out.join('');
    expect(output).toMatch(/Type\s+: Python \/ PyTorch/);
    expect(output).toMatch(/Files\s+: \d+ files/);
    expect(output).toMatch(/Entrypoints : train\.py/);
    expect(output).toMatch(/Cache\s+: \.devpilot\/cache\/project\.json/);

    const json = capture(env, workspace);
    expect(await runCli(['scan', workspace, '--json'], json.io)).toBe(0);
    const payload = JSON.parse(json.out.join('')) as {
      stats: { files: number; fromCache: boolean };
      profile: { projectType: string };
    };
    expect(payload.profile.projectType).toBe('PyTorch');
    expect(payload.stats.files).toBeGreaterThan(0);
    expect(payload.stats.fromCache).toBe(true);

    const forced = capture(env, workspace);
    expect(await runCli(['scan', workspace, '--force'], forced.io)).toBe(0);
    expect(forced.out.join('')).toMatch(/Cache bypassed|Note\s+: cache bypassed/);
  }, 30_000);

  it('initialises a workspace and edits .gitignore only when asked', async () => {
    const first = capture(env, workspace);
    expect(await runCli(['init', workspace], first.io)).toBe(0);
    expect(first.out.join('')).toMatch(/Initialised DevPilot workspace/);
    expect(first.out.join('')).toMatch(/--write-gitignore/);
    await expect(fs.access(path.join(workspace, '.devpilot', 'config.yml'))).resolves.toBeUndefined();
    await expect(fs.access(path.join(workspace, '.gitignore'))).rejects.toThrow();

    const second = capture(env, workspace);
    expect(await runCli(['init', workspace, '--write-gitignore'], second.io)).toBe(0);
    expect(await fs.readFile(path.join(workspace, '.gitignore'), 'utf8')).toMatch(/^\.devpilot\/$/m);
  }, 30_000);

  it('reports status for a project as text and as JSON', async () => {
    const text = capture(env, workspace);
    expect(await runCli(['status', workspace], text.io)).toBe(0);
    const output = text.out.join('');
    expect(output).toMatch(/Workspace\s+:/);
    expect(output).toMatch(/Python \/ PyTorch/);
    expect(output).toMatch(/Git\s+: main/);

    const json = capture(env, workspace);
    expect(await runCli(['status', workspace, '--json'], json.io)).toBe(0);
    const payload = JSON.parse(json.out.join('')) as {
      workspace: { root: string; profile: { projectType: string } };
      index: { state: string };
      devpilotHome: string;
    };
    expect(payload.workspace.profile.projectType).toBe('PyTorch');
    expect(payload.index.state).toBe('none');
    expect(payload.devpilotHome).toBe(home);
  }, 30_000);

  it('runs the detected test suite from the CLI', async () => {
    const text = capture(env, workspace);
    expect(await runCli(['test', workspace], text.io)).toBe(0);
    const output = text.out.join('');
    expect(output).toMatch(/Framework\s+: pytest/);
    expect(output).toMatch(/Status\s+: passed/);
    expect(output).toMatch(/Tests\s+: \d+\/\d+ passed, 0 failed/);

    const json = capture(env, workspace);
    expect(await runCli(['test', workspace, '--json'], json.io)).toBe(0);
    const payload = JSON.parse(json.out.join('')) as {
      status: string;
      framework: string;
      total: number;
      failed: number;
      parsed: boolean;
    };
    expect(payload.status).toBe('passed');
    expect(payload.framework).toBe('pytest');
    expect(payload.parsed).toBe(true);
    expect(payload.total).toBeGreaterThanOrEqual(3);
    expect(payload.failed).toBe(0);
  }, 120_000);

  it('fails cleanly, without a stack trace, for a missing path', async () => {
    const io = capture(env, workspace);
    expect(await runCli(['status', path.join(workspace, 'nope')], io.io)).toBe(2);
    const stderr = io.err.join('');
    expect(stderr).toMatch(/FILE_NOT_FOUND/);
    expect(stderr).not.toMatch(/\n\s+at /);
  }, 30_000);
});
