import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { walkWorkspace } from '../../src/workspace/file-walker';
import { makeTempDir, removeDir, writeFiles } from '../helpers/index';

describe('walkWorkspace', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempDir('devpilot-walk-');
    await writeFiles(root, {
      '.gitignore': ['node_modules/', '*.log', 'ignored-dir/', '!important.log', 'src/generated.py'].join('\n'),
      'keep.py': 'print("keep")\n',
      'important.log': 'keep me\n',
      'debug.log': 'ignore me\n',
      'app.ts': 'export const x = 1;\n',
      'ignored-dir/secret.txt': 'secret\n',
      'node_modules/pkg/index.js': 'module.exports = 1;\n',
      'src/app.py': 'import os\n',
      'src/generated.py': '# generated\n',
      'src/nested/deep.py': 'x = 1\n',
      '.devpilot/config.yml': 'workspace:\n  max_files: 5\n',
      'data/big.bin': 'x'.repeat(4096),
      'docs/readme.md': '# docs\n',
    });
    await fs.symlink(
      path.join(root, 'src'),
      path.join(root, 'src-link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
  }, 30_000);

  afterAll(async () => {
    await removeDir(root);
  });

  it('honours .gitignore, never enters .devpilot, and records what it skipped', async () => {
    const result = await walkWorkspace({ root, maxFileSizeBytes: 1024 });
    const paths = result.files.map((file) => file.path);

    expect(paths).toContain('keep.py');
    expect(paths).toContain('important.log');
    expect(paths).toContain('src/app.py');
    expect(paths).toContain('src/nested/deep.py');
    expect(paths).toContain('app.ts');

    expect(paths).not.toContain('debug.log');
    expect(paths).not.toContain('ignored-dir/secret.txt');
    expect(paths).not.toContain('node_modules/pkg/index.js');
    expect(paths).not.toContain('src/generated.py');
    expect(paths.some((entry) => entry.startsWith('.devpilot'))).toBe(false);
    expect(paths.some((entry) => entry.startsWith('src-link'))).toBe(false);

    expect(result.dirs).toContain('src');
    expect(result.dirs).toContain('src/nested');
    expect(result.dirs).not.toContain('node_modules');
    expect(result.dirs).not.toContain('ignored-dir');
    expect(result.skipped.excluded).toBeGreaterThan(0);
    expect(result.skipped.oversized).toBe(1);
    expect(result.skipped.symlinks).toBeGreaterThanOrEqual(1);
    expect(result.gitignoreLayers).toBe(1);
    expect(result.truncated).toBe(false);
  }, 30_000);

  it('classifies languages and totals bytes', async () => {
    const result = await walkWorkspace({ root, maxFileSizeBytes: 1024 });
    expect(result.languages['python']?.files).toBe(3);
    expect(result.languages['typescript']?.files).toBe(1);
    expect(result.languages['markdown']?.files).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.languages['python']?.bytes).toBeGreaterThan(0);
  }, 30_000);

  it('applies config excludes at any depth', async () => {
    const result = await walkWorkspace({ root, exclude: ['docs'], maxFileSizeBytes: 1024 });
    expect(result.files.map((file) => file.path)).not.toContain('docs/readme.md');
  }, 30_000);

  it('filters by include globs', async () => {
    const result = await walkWorkspace({ root, include: ['*.py'], maxFileSizeBytes: 1024 });
    const paths = result.files.map((file) => file.path);
    expect(paths.sort()).toEqual(['keep.py', 'src/app.py', 'src/nested/deep.py']);
  }, 30_000);

  it('stops at the file cap and reports truncation', async () => {
    const result = await walkWorkspace({ root, maxFiles: 2, maxFileSizeBytes: 1024 });
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(true);
  }, 30_000);

  it('can ignore .gitignore semantics on request', async () => {
    const result = await walkWorkspace({ root, respectGitignore: false, maxFileSizeBytes: 1024 });
    const paths = result.files.map((file) => file.path);
    expect(paths).toContain('debug.log');
    expect(paths).toContain('ignored-dir/secret.txt');
    expect(result.gitignoreLayers).toBe(0);
  }, 30_000);
});
