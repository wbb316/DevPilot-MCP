import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runProcess } from '../../src/runner/process-runner.js';

/** Throwaway workspaces for tests — the real user directories are never touched. */
export async function makeTempDir(prefix = 'devpilot-test-'): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Best-effort removal of a throwaway directory. A file still held open (Windows) must never
 * turn into a test failure or a long retry loop: the directory is temporary either way.
 */
export async function removeDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  } catch {
    /* temporary directory: leaving a remnant behind is acceptable */
  }
}

export async function writeFiles(root: string, files: Record<string, string>): Promise<void> {
  for (const [relative, content] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content, 'utf8');
  }
}

/** Copy a fixture directory into a temp workspace (skips .git and node_modules). */
export async function copyFixture(name: string, target: string): Promise<void> {
  const source = path.resolve(import.meta.dirname, '..', '..', 'fixtures', name);
  await fs.mkdir(target, { recursive: true });
  await fs.cp(source, target, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src);
      return base !== '.git' && base !== 'node_modules' && base !== '.devpilot';
    },
  });
}

export interface GitInitResult {
  available: boolean;
  committed: boolean;
}

/** git init + one commit, using inline identity so no global git config is required. */
export async function gitInit(dir: string, message = 'initial commit'): Promise<GitInitResult> {
  const version = await runProcess({ command: 'git', args: ['--version'], cwd: dir, timeoutMs: 20_000 });
  if (version.exitCode !== 0) return { available: false, committed: false };

  const identity = [
    '-c',
    'user.email=devpilot-test@example.invalid',
    '-c',
    'user.name=DevPilot Test',
  ];

  await runProcess({ command: 'git', args: ['init', '-b', 'main'], cwd: dir, timeoutMs: 20_000 });
  await runProcess({ command: 'git', args: [...identity, 'add', '-A'], cwd: dir, timeoutMs: 20_000 });
  const commit = await runProcess({
    command: 'git',
    args: [...identity, 'commit', '-m', message, '--no-gpg-sign'],
    cwd: dir,
    timeoutMs: 20_000,
  });
  return { available: true, committed: commit.exitCode === 0 };
}

export async function readText(file: string): Promise<string> {
  return await fs.readFile(file, 'utf8');
}
