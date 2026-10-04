import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { projectProfileShape } from './project-detector.shape';
import { detectProject } from '../../src/workspace/project-detector';
import { copyFixture, makeTempDir, removeDir } from '../helpers/index';

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
