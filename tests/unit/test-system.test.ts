import { afterAll, describe, expect, it } from 'vitest';

import { defaultConfig } from '../../src/config/config-schema';
import { detectProject } from '../../src/workspace/project-detector';
import {
  detectTestFramework,
  planTests,
  readNodeTestManifest,
} from '../../src/test/test-system';
import { copyFixture, makeTempDir, removeDir } from '../helpers/index';

async function prepare(fixture: string): Promise<string> {
  const root = await makeTempDir(`devpilot-testsystem-${fixture}-`);
  await copyFixture(fixture, root);
  return root;
}

describe('planTests', () => {
  const roots: string[] = [];
  const config = defaultConfig();

  afterAll(async () => {
    for (const root of roots) await removeDir(root);
  });

  async function planFixture(fixture: string, options: Parameters<typeof planTests>[1] = {}) {
    const root = await prepare(fixture);
    roots.push(root);
    const profile = await detectProject(root);
    const manifest = await readNodeTestManifest(root);
    return {
      root,
      plan: planTests({ root, profile, config, manifest }, options),
      framework: detectTestFramework({ root, profile, config, manifest }),
    };
  }

  it('plans pytest for the Python fixture without stacking a quiet flag', async () => {
    const { plan, framework } = await planFixture('python-project');
    expect(framework).toBe('pytest');
    expect(plan.supported).toBe(true);
    expect(plan.command).toBe('python');
    // `-q` is deliberately absent: the fixture's own addopts already has one, and `-qq`
    // suppresses the summary line that the counts are parsed from.
    expect(plan.args).toEqual(['-m', 'pytest', '-p', 'no:cacheprovider']);
    expect(plan.args).not.toContain('-q');
  });

  it('maps a file, a filter and failFast onto pytest arguments', async () => {
    const { plan } = await planFixture('python-project', {
      file: 'tests/test_model.py',
      filter: 'shape',
      failFast: true,
      extraArgs: ['--no-header'],
    });
    expect(plan.args).toEqual([
      '-m',
      'pytest',
      '-p',
      'no:cacheprovider',
      'tests/test_model.py',
      '-k',
      'shape',
      '-x',
      '--no-header',
    ]);
  });

  it('plans Maven Surefire for the Maven fixture and passes -Dtest', async () => {
    const { plan, framework } = await planFixture('maven-project', { filter: 'UserServiceTest#lengthOfTitle' });
    expect(framework).toBe('junit');
    expect(plan.command).toBe('mvn');
    expect(plan.args).toEqual(['-B', 'test', '-Dtest=UserServiceTest#lengthOfTitle']);
  });

  it('plans the declared node --test script for the Node fixture', async () => {
    const { plan, framework } = await planFixture('node-project', { file: 'test/index.test.js' });
    expect(framework).toBe('node-test');
    expect(plan.command).toBe('npm');
    expect(plan.args).toEqual(['test', '--', 'test/index.test.js']);
  });

  it('refuses a directory with no recognisable test runner', async () => {
    const root = await makeTempDir('devpilot-testsystem-empty-');
    roots.push(root);
    const profile = await detectProject(root);
    const manifest = await readNodeTestManifest(root);
    const plan = planTests({ root, profile, config, manifest });
    expect(plan.supported).toBe(false);
    expect(plan.reason ?? '').toMatch(/no test runner/i);
  });

  it('lets .devpilot/config.yml override the planned command', async () => {
    const root = await prepare('python-project');
    roots.push(root);
    const profile = await detectProject(root);
    const manifest = await readNodeTestManifest(root);
    const overridden = {
      ...config,
      project: { ...config.project, test_command: 'python -m pytest tests/test_model.py' },
    };
    const plan = planTests({ root, profile, config: overridden, manifest });
    expect(plan.source).toBe('config');
    expect(plan.command).toBe('python');
    expect(plan.args).toEqual(['-m', 'pytest', 'tests/test_model.py']);
  });

  it('keeps the poetry launcher for poetry projects', async () => {
    const root = await prepare('python-project');
    roots.push(root);
    const profile = { ...(await detectProject(root)), buildSystem: 'poetry' };
    const manifest = await readNodeTestManifest(root);
    const plan = planTests({ root, profile, config, manifest });
    expect(plan.command).toBe('poetry');
    expect(plan.args.slice(0, 4)).toEqual(['run', 'python', '-m', 'pytest']);
  });
});
