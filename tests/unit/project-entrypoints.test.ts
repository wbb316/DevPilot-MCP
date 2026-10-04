import { afterAll, describe, expect, it } from 'vitest';

import { detectProject } from '../../src/workspace/project-detector';
import { copyFixture, makeTempDir, removeDir } from '../helpers/index';
import { projectProfileShape } from './project-detector.shape';

/**
 * Phase 10 regression: the entry-point candidate list only covered fixed paths, so a project
 * whose entry point lives inside a package (`src/app/cli.py`) reported no run command at all.
 * Such a file cannot be started as a path either — relative imports require `python -m pkg.mod`
 * with the directory above the package on PYTHONPATH.
 */
describe('entry-point discovery', () => {
  const roots: string[] = [];

  async function prepare(fixture: string): Promise<string> {
    const dir = await makeTempDir(`devpilot-entry-${fixture}-`);
    await copyFixture(fixture, dir);
    roots.push(dir);
    return dir;
  }

  afterAll(async () => {
    for (const dir of roots) await removeDir(dir);
  });

  it('finds an entry point nested in a src-layout package and runs it as a module', async () => {
    const root = await prepare('python-src-layout');
    const profile = await detectProject(root, { name: 'python-src-layout' });
    projectProfileShape(profile);

    expect(profile.entrypoints).toContain('src/app/cli.py');
    expect(profile.candidates.run).toBe('python -m app.cli');
    expect(profile.candidates.runEnv).toEqual({ PYTHONPATH: 'src' });
  });

  it('never mistakes a test file for an entry point', async () => {
    const root = await prepare('python-src-layout');
    const profile = await detectProject(root, { name: 'python-src-layout' });
    expect(profile.entrypoints.filter((entry) => /test_|_test\./.test(entry))).toHaveLength(0);
  });

  it('keeps a root-level script as a plain path with no extra environment', async () => {
    const root = await prepare('python-project');
    const profile = await detectProject(root, { name: 'python-project' });
    expect(profile.candidates.run).toMatch(/^python train\.py$/);
    expect(profile.candidates.runEnv).toBeUndefined();
  });

  it('prefers a declared project run command over the inferred module form', async () => {
    const root = await prepare('python-src-layout');
    const { defaultConfig } = await import('../../src/config/config-schema');
    const config = defaultConfig();
    config.project.run_command = 'python -m app.cli --verbose';
    const profile = await detectProject(root, { name: 'python-src-layout', config });
    expect(profile.candidates.run).toBe('python -m app.cli --verbose');
  });
});
