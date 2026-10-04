import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { GitManager } from '../../src/git/git-manager';
import {
  analyzeDiff,
  parseHunkRanges,
  parseNameStatus,
  parseNumstat,
  resolveRenameSpec,
  unquoteGitPath,
} from '../../src/git/diff-analyzer';
import { writeBaseline } from '../../src/git/baseline';
import { ensureWorkspaceLayout, workspacePaths } from '../../src/storage/paths';
import type { ChangedFile } from '../../src/types/git';
import { gitInit, makeTempDir, removeDir, writeFiles } from '../helpers/index';

describe('diff text parsing', () => {
  it('parses numstat including binaries and renames', () => {
    const parsed = parseNumstat(
      ['12\t3\tsrc/a.ts', '-\t-\tassets/logo.png', '5\t2\tsrc/{old => new}/f.ts', '1\t0\tplain.ts'].join('\n'),
    );
    expect(parsed.get('src/a.ts')).toEqual({ addedLines: 12, deletedLines: 3, binary: false });
    expect(parsed.get('assets/logo.png')).toEqual({ addedLines: 0, deletedLines: 0, binary: true });
    expect(parsed.get('src/new/f.ts')).toEqual({ addedLines: 5, deletedLines: 2, binary: false });
    expect(parsed.get('plain.ts')?.addedLines).toBe(1);
  });

  it('parses name-status, keeping the new name of a rename', () => {
    const parsed = parseNameStatus(['M\tsrc/a.ts', 'R100\told/a.ts\tnew/a.ts', 'D\tgone.txt', 'A\tfresh.txt'].join('\n'));
    expect(parsed.get('src/a.ts')).toBe('modified');
    expect(parsed.get('new/a.ts')).toBe('renamed');
    expect(parsed.get('gone.txt')).toBe('deleted');
    expect(parsed.get('fresh.txt')).toBe('added');
  });

  it('collects new-side line ranges from --unified=0 hunks', () => {
    const diff = [
      'diff --git a/src/a.ts b/src/a.ts',
      '--- a/src/a.ts',
      '+++ b/src/a.ts',
      '@@ -1,2 +1,3 @@',
      '+added',
      '@@ -10 +11,2 @@',
      '+x',
      '+y',
      'diff --git a/gone.txt b/gone.txt',
      '--- a/gone.txt',
      '+++ /dev/null',
      '@@ -1 +0,0 @@',
      '-bye',
    ].join('\n');
    const ranges = parseHunkRanges(diff);
    expect(ranges.get('src/a.ts')).toEqual([
      [1, 3],
      [11, 12],
    ]);
    // A deletion has no new-side range at all.
    expect(ranges.get('gone.txt')).toBeUndefined();
  });

  it('unquotes git paths and resolves rename specs', () => {
    expect(unquoteGitPath('"src/a\\tb.ts"')).toBe('src/a\tb.ts');
    expect(unquoteGitPath('src/plain.ts')).toBe('src/plain.ts');
    expect(resolveRenameSpec('src/{old => new}/f.ts')).toBe('src/new/f.ts');
    expect(resolveRenameSpec('old/a.ts => new/a.ts')).toBe('new/a.ts');
  });
});

describe('analyzeDiff against a real repository', () => {
  it('reviews status, symbols, risk, affected tests and pre-existing changes', async () => {
    const root = await makeTempDir('devpilot-diff-');
    try {
      await writeFiles(root, {
        'src/app.py': 'def run(x):\n    return x + 1\n\ndef other():\n    return 2\n',
        'tests/test_app.py': 'def test_run():\n    assert True\n',
        'config/settings.yml': 'debug: false\n',
        'README.md': '# demo\n',
      });

      const init = await gitInit(root);
      if (!init.available) {
        // No git on this machine: the pure-parser tests above still cover the analysis.
        return;
      }

      await writeFiles(root, {
        'src/app.py': 'def run(x):\n    value = x + 1\n    return value\n\ndef other():\n    return 2\n',
        'tests/test_app.py': 'def test_run():\n    assert 2 + 2 == 4\n',
        '.env': 'SECRET=1\n',
      });
      await fs.rm(path.join(root, 'config', 'settings.yml'));

      const paths = workspacePaths(root);
      await ensureWorkspaceLayout(paths);
      await writeBaseline(paths, {
        capturedAt: new Date().toISOString(),
        changed: ['src/app.py'],
        untracked: [],
      });

      const git = new GitManager({ cwd: root });
      const { review } = await analyzeDiff({ root, paths, git, includePatch: true });
      const byPath = new Map<string, ChangedFile>(review.files.map((file) => [file.path, file]));

      expect(byPath.get('src/app.py')?.status).toBe('modified');
      expect(byPath.get('src/app.py')?.changedSymbols).toContain('run');
      expect(byPath.get('.env')?.status).toBe('untracked');
      expect(byPath.get('.env')?.risk).toBe('HIGH');
      expect(byPath.get('config/settings.yml')?.status).toBe('deleted');
      expect(byPath.get('config/settings.yml')?.risk).toBe('HIGH');

      expect(review.riskLevel).toBe('HIGH');
      expect(review.highRisk).toContain('.env');
      expect(review.highRisk).toContain('config/settings.yml');
      expect(review.affectedTests).toContain('tests/test_app.py');
      expect(review.totals.addedLines).toBeGreaterThan(0);

      // The baseline is what separates the user's earlier edit from this session's work.
      expect(review.preExistingChanges).toEqual(['src/app.py']);
      expect(review.notes?.some((note) => note.includes('unrelatedFiles is empty'))).toBe(true);

      expect(review.patchArtifact).toMatch(/^\.devpilot\/logs\/diff-.*\.patch$/);
      const patch = await fs.readFile(path.join(root, (review.patchArtifact as string).split('/').join(path.sep)), 'utf8');
      expect(patch).toContain('src/app.py');
    } finally {
      await removeDir(root);
    }
  }, 60_000);
});
