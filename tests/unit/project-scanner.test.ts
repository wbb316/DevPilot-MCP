import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig } from '../../src/config/config-schema';
import { ensureWorkspaceLayout, workspacePaths } from '../../src/storage/paths';
import { detectProject } from '../../src/workspace/project-detector';
import { isUnsupported, readProjectCache, scanProject, SCANNER_VERSION } from '../../src/workspace/project-scanner';
import { copyFixture, makeTempDir, removeDir, writeFiles } from '../helpers/index';
import { projectProfileShape } from './project-detector.shape';

async function prepareWorkspace(fixture: string): Promise<string> {
  const root = await makeTempDir(`devpilot-scan-${fixture}-`);
  await copyFixture(fixture, root);
  await ensureWorkspaceLayout(workspacePaths(root));
  return root;
}

describe('scanProject', () => {
  const roots: string[] = [];
  const config = defaultConfig();

  afterAll(async () => {
    for (const root of roots) await removeDir(root);
  });

  it('scans the Python fixture and persists the profile', async () => {
    const root = await prepareWorkspace('python-project');
    roots.push(root);

    const result = await scanProject({ root, paths: workspacePaths(root), config });
    expect(result.profile.projectType).toBe('PyTorch');
    expect(result.profile.entrypoints).toContain('train.py');
    expect(result.profile.testFramework).toBe('pytest');
    expect(result.stats.files).toBeGreaterThanOrEqual(6);
    expect(result.stats.dirs).toBeGreaterThanOrEqual(1);
    expect(result.stats.bytes).toBeGreaterThan(0);
    expect(result.stats.fromCache).toBe(false);
    expect(result.indexState).toBe('ready');
    expect(result.languages['python']?.files).toBeGreaterThanOrEqual(4);
    projectProfileShape(result.profile);

    const topLevel = new Map(result.topLevel.map((entry) => [entry.name, entry]));
    expect(topLevel.get('tests')).toMatchObject({ type: 'dir', hint: 'tests' });
    expect(topLevel.get('requirements.txt')).toMatchObject({ type: 'file', hint: 'manifest' });
    expect(topLevel.get('model.py')).toMatchObject({ type: 'file', hint: 'other' });

    // The cache is the tool's memory: status reads stats.files back out of it.
    const cached = await readProjectCache(workspacePaths(root));
    expect(cached?.stats.files).toBe(result.stats.files);
    expect(cached?.profile.projectType).toBe('PyTorch');
    expect(cached?.scannerVersion).toBe(SCANNER_VERSION);
    await expect(fs.access(path.join(root, '.devpilot', 'cache', 'project.json'))).resolves.toBeUndefined();
  }, 30_000);

  it('serves a second scan from cache, and force bypasses it', async () => {
    const root = await prepareWorkspace('python-project');
    roots.push(root);

    const first = await scanProject({ root, paths: workspacePaths(root), config });
    const second = await scanProject({ root, paths: workspacePaths(root), config });
    expect(first.stats.fromCache).toBe(false);
    expect(second.stats.fromCache).toBe(true);
    expect(second.cacheHit).toBe(true);
    expect(second.stats.files).toBe(first.stats.files);

    const forced = await scanProject({ root, paths: workspacePaths(root), config, force: true });
    expect(forced.stats.fromCache).toBe(false);
    expect(forced.notes).toContain('cache bypassed: force = true');

    // A top-level edit changes the cheap cache key, so the next scan re-walks.
    await fs.writeFile(path.join(root, 'train.py'), '# touched\n', 'utf8');
    const afterEdit = await scanProject({ root, paths: workspacePaths(root), config });
    expect(afterEdit.stats.fromCache).toBe(false);
  }, 30_000);

  it('detects the Maven fixture', async () => {
    const root = await prepareWorkspace('maven-project');
    roots.push(root);

    const result = await scanProject({ root, paths: workspacePaths(root), config });
    expect(result.profile.markers).toContain('pom.xml');
    expect(result.profile.languages).toContain('Java');
    expect(result.profile.buildSystem).toBe('maven');
    expect(result.profile.candidates.test).toBe('mvn -q test');
    expect(result.languages['java']?.files).toBeGreaterThanOrEqual(4);
  }, 30_000);

  it('detects the Node fixture and infers its npm scripts', async () => {
    const root = await prepareWorkspace('node-project');
    roots.push(root);

    const result = await scanProject({ root, paths: workspacePaths(root), config });
    expect(result.profile.markers).toContain('package.json');
    expect(result.profile.buildSystem).toBe('npm');
    expect(result.profile.candidates).toMatchObject({
      build: 'npm run build',
      test: 'npm test',
      run: 'npm start',
    });
    expect(result.languages['javascript']?.files).toBeGreaterThanOrEqual(3);
  }, 30_000);

  it('flags a directory that holds no recognizable project', async () => {
    const root = await makeTempDir('devpilot-scan-empty-');
    roots.push(root);
    await ensureWorkspaceLayout(workspacePaths(root));

    const result = await scanProject({ root, paths: workspacePaths(root), config });
    expect(isUnsupported(result.profile, result.languages)).toBe(true);
    expect(result.stats.files).toBe(0);
  }, 30_000);
});

describe('project detection reuse', () => {
  it('accepts a pre-computed file list instead of walking twice', async () => {
    const root = await makeTempDir('devpilot-detect-');
    try {
      await fs.writeFile(path.join(root, 'main.py'), 'print(1)\n', 'utf8');
      const profile = await detectProject(root, { files: ['main.py'] });
      expect(profile.entrypoints).toContain('main.py');
      // A file list that omits the only source file must change the verdict: proof the
      // scanner's walk, not a second hidden walk, decides what is seen.
      const empty = await detectProject(root, { files: [] });
      expect(empty.languages).toEqual([]);
    } finally {
      await removeDir(root);
    }
  }, 30_000);
});

describe('polyglot repositories', () => {
  it('lets root markers decide which ecosystem owns the repo', async () => {
    const root = await makeTempDir('devpilot-scan-polyglot-');
    try {
      await writeFiles(root, {
        'package.json': JSON.stringify({ name: 'polyglot', scripts: { build: 'tsc', test: 'vitest run' } }),
        'tsconfig.json': '{}\n',
        'src/index.ts': 'export const x = 1;\n',
        'fixtures/maven-sample/pom.xml': '<project><artifactId>sample</artifactId></project>\n',
        'fixtures/maven-sample/src/main/java/com/example/Sample.java':
          'package com.example;\npublic class Sample {\n}\n',
      });

      const result = await scanProject({ root, paths: workspacePaths(root), config: defaultConfig() });
      // The Maven sample is real (it keeps 'Java' in languages) but it does not own the repo.
      expect(result.profile.projectType).toBe('Node');
      expect(result.profile.buildSystem).toBe('npm');
      expect(result.profile.candidates.test).toBe('npm test');
      expect(result.profile.languages).toContain('Java');
      expect(result.profile.languages[0]).toBe('TypeScript');
    } finally {
      await removeDir(root);
    }
  }, 30_000);
});

describe('scanProject with a dirty git tree', () => {
  let root: string;
  beforeAll(async () => {
    root = await makeTempDir('devpilot-scan-git-');
    await copyFixture('python-project', root);
    await ensureWorkspaceLayout(workspacePaths(root));
  }, 30_000);
  afterAll(async () => {
    await removeDir(root);
  });

  it('still serves the cache but says out loud that only the top level is covered', async () => {
    const config = defaultConfig();
    const dirty = { available: true, isRepo: true, branch: 'main', head: 'abc123', dirty: true };
    const first = await scanProject({ root, paths: workspacePaths(root), config, git: dirty });
    const second = await scanProject({ root, paths: workspacePaths(root), config, git: dirty });
    expect(first.stats.fromCache).toBe(false);
    expect(second.stats.fromCache).toBe(true);
    expect(second.notes.some((note) => /dirty/.test(note))).toBe(true);
  }, 30_000);
});
