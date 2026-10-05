import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

import { projectProfileShape } from './project-detector.shape';
import { detectProject } from '../../src/workspace/project-detector';
import { copyFixture, makeTempDir, removeDir, writeFiles } from '../helpers/index';

/**
 * Detection is rule-based and must stay deterministic (docs/ARCHITECTURE.md §4.8).
 * Assertions are contract-level on purpose: they pin the frozen enum values in
 * docs/DATA-MODEL.md §3 without over-fitting the internals of the detector.
 */
describe('project detection', () => {
  const roots: string[] = [];

  async function prepare(fixture: string): Promise<string> {
    const dir = await makeTempDir(`devpilot-detect-${fixture}-`);
    await copyFixture(fixture, dir);
    roots.push(dir);
    return dir;
  }

  afterAll(async () => {
    for (const dir of roots) await removeDir(dir);
  });

  it('recognises the Python / PyTorch fixture', async () => {
    const root = await prepare('python-project');
    const profile = await detectProject(root, { name: 'python-project' });
    projectProfileShape(profile);

    expect(profile.name).toBe('python-project');
    expect(profile.languages).toContain('Python');
    expect(profile.projectType).toBe('PyTorch');
    expect(profile.markers).toContain('pyproject.toml');
    expect(profile.entrypoints).toContain('train.py');
    expect(profile.testFramework).toBe('pytest');
    expect(profile.testDirs).toContain('tests');
    expect(profile.candidates.test).toMatch(/pytest/);
    expect(profile.candidates.run).toMatch(/train\.py/);
  });

  /**
   * The Phase 10 real-project layout: `model/` + `train/` + `scratch/` + `app/static/`.
   * The old heuristics answered `python scratch/main.py` (an MNIST toy) and reported a single
   * source directory, so the run command the agent was handed could not start the project.
   */
  it('prefers the framework entry point over a scratch script and finds every source dir', async () => {
    const root = await makeTempDir('devpilot-detect-real-');
    roots.push(root);
    await writeFiles(root, {
      'requirements.txt': 'torch>=2.1\npytest>=7.0\n',
      'model/__init__.py': '',
      'model/attention.py': 'class Attention:\n    pass\n',
      'train/train.py':
        'from model.attention import Attention\n\nif __name__ == "__main__":\n    Attention()\n',
      'scratch/main.py': 'print("toy")\n\nif __name__ == "__main__":\n    pass\n',
      'app/static/js/app.js': 'export function boot() {\n  return 1;\n}\n',
      'docs/plot.py': 'import matplotlib\n',
      'test/test_attention.py': 'from model.attention import Attention\n\n\ndef test_x():\n    assert Attention\n',
    });

    const profile = await detectProject(root, { name: 'real-shaped' });
    projectProfileShape(profile);

    expect(profile.projectType).toBe('PyTorch');
    expect(profile.entrypoints[0]).toBe('train/train.py');
    expect(profile.entrypoints).not.toContain('scratch/main.py');
    expect(profile.entrypoints).not.toContain('app/static/js/app.js');
    expect(profile.candidates.run).toBe('python train/train.py');
    // The entry sits outside a package and imports `model`, so root must be on PYTHONPATH.
    expect(profile.candidates.runEnv?.PYTHONPATH).toBe('.');

    expect(profile.sourceDirs).toContain('model');
    expect(profile.sourceDirs).toContain('train');
    expect(profile.sourceDirs).not.toContain('scratch');
    expect(profile.sourceDirs).not.toContain('docs');
    expect(profile.sourceDirs).not.toContain('test');
  });

  it('recognises the Maven / JUnit fixture', async () => {
    const root = await prepare('maven-project');
    const profile = await detectProject(root, { name: 'maven-project' });
    projectProfileShape(profile);

    expect(profile.languages).toContain('Java');
    expect(profile.buildSystem).toBe('maven');
    expect(profile.testFramework).toBe('junit');
    expect(profile.markers).toContain('pom.xml');
    expect(profile.sourceDirs.join(' ')).toMatch(/src[\\/]main[\\/]java/);
    expect(profile.candidates.build).toMatch(/mvn/);
    expect(profile.candidates.test).toMatch(/mvn/);
  });

  it('recognises the Node fixture', async () => {
    const root = await prepare('node-project');
    const profile = await detectProject(root, { name: 'node-project' });
    projectProfileShape(profile);

    expect(profile.languages).toContain('JavaScript');
    expect(['npm', 'pnpm']).toContain(profile.buildSystem);
    expect(profile.markers).toContain('package.json');
    expect(profile.candidates.build).toMatch(/npm/);
    expect(profile.candidates.test).toMatch(/npm/);
  });

  it('honours the configured project type override', async () => {
    const root = await prepare('node-project');
    const { defaultConfig } = await import('../../src/config/config-schema');
    const config = defaultConfig();
    config.project.type = 'Custom-Type';
    const profile = await detectProject(root, { name: 'node-project', config });
    expect(profile.projectType).toBe('Custom-Type');
  });

  it('returns an Unknown profile for a project with no markers', async () => {
    const dir = await makeTempDir('devpilot-detect-empty-');
    roots.push(dir);
    await fs.writeFile(path.join(dir, 'notes.txt'), 'hello\n', 'utf8');
    const profile = await detectProject(dir, {});
    projectProfileShape(profile);
    expect(profile.projectType).toBe('Unknown');
    expect(profile.markers).toHaveLength(0);
  });
});
