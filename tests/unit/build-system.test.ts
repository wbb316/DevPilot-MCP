import { describe, expect, it } from 'vitest';

import { planBuild } from '../../src/runner/build-system.js';

const base = {
  root: process.platform === 'win32' ? 'D:/proj' : '/proj',
  projectType: 'Java',
  markers: [] as string[],
  sourceDirs: [] as string[],
  override: null,
};

const gradleWrapper = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';

describe('planBuild — maven', () => {
  it('plans the three targets', () => {
    expect(planBuild({ ...base, buildSystem: 'maven' }, 'compile', false)).toMatchObject({
      system: 'maven',
      command: 'mvn',
      args: ['-q', 'compile'],
      supported: true,
    });
    expect(planBuild({ ...base, buildSystem: 'maven' }, 'test-compile', false).args).toEqual([
      '-q',
      'test-compile',
    ]);
    expect(planBuild({ ...base, buildSystem: 'maven' }, 'package', true).args).toEqual([
      '-q',
      'clean',
      '-DskipTests',
      'package',
    ]);
  });

  it('prefers a project-local wrapper over PATH', () => {
    const plan = planBuild({ ...base, buildSystem: 'maven', markers: ['mvnw.cmd'] }, 'compile', false);
    expect(plan.command).toBe('mvnw.cmd');
    expect(plan.resolvedPath).toContain('mvnw.cmd');
    expect(plan.notes.join(' ')).toContain('wrapper');
  });
});

describe('planBuild — gradle', () => {
  it('uses the wrapper and skips tests for package', () => {
    const plan = planBuild(
      { ...base, buildSystem: 'gradle', markers: [gradleWrapper, 'build.gradle'] },
      'package',
      false,
    );
    expect(plan.command).toBe(gradleWrapper);
    expect(plan.args).toEqual(['build', '-x', 'test', '--no-daemon']);
    expect(plan.resolvedPath).toContain(gradleWrapper);
  });

  it('falls back to gradle on PATH with a note', () => {
    const plan = planBuild({ ...base, buildSystem: 'gradle' }, 'compile', false);
    expect(plan.command).toBe('gradle');
    expect(plan.notes.join(' ')).toContain('wrapper');
  });
});

describe('planBuild — node', () => {
  it('maps targets onto package.json scripts', () => {
    const scripts = { build: 'tsc -p .', typecheck: 'tsc --noEmit' };
    expect(planBuild({ ...base, buildSystem: 'npm', scripts }, 'compile', false)).toMatchObject({
      command: 'npm',
      args: ['run', 'build'],
    });
    expect(planBuild({ ...base, buildSystem: 'npm', scripts }, 'test-compile', false).args).toEqual([
      'run',
      'typecheck',
    ]);
    expect(planBuild({ ...base, buildSystem: 'pnpm', scripts }, 'package', false).command).toBe('pnpm');
  });

  it('refuses when no build script exists', () => {
    const plan = planBuild({ ...base, buildSystem: 'npm', scripts: {} }, 'compile', false);
    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('build');
  });
});

describe('planBuild — python', () => {
  it('checks syntax over the source directories', () => {
    const plan = planBuild({ ...base, buildSystem: 'pip', sourceDirs: ['src', 'tests'] }, 'compile', false);
    expect(plan.command).toBe('python');
    expect(plan.args).toEqual(['-m', 'compileall', '-q', 'src', 'tests']);
  });

  it('uses the whole workspace when no source dir is known', () => {
    expect(planBuild({ ...base, buildSystem: 'pip' }, 'compile', false).args).toEqual([
      '-m',
      'compileall',
      '-q',
      '.',
    ]);
  });

  it('prepends `poetry run` for poetry projects', () => {
    const plan = planBuild({ ...base, buildSystem: 'poetry' }, 'compile', false);
    expect(plan.command).toBe('poetry');
    expect(plan.args.slice(0, 4)).toEqual(['run', 'python', '-m', 'compileall']);
  });

  it('refuses packaging without pyproject.toml', () => {
    const plan = planBuild({ ...base, buildSystem: 'pip' }, 'package', false);
    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('pyproject');
  });
});

describe('planBuild — precedence and gaps', () => {
  it('lets config.project.build_command win', () => {
    const plan = planBuild(
      { ...base, buildSystem: 'maven', override: 'make -j4 build' },
      'compile',
      true,
    );
    expect(plan.system).toBe('config');
    expect(plan.command).toBe('make');
    expect(plan.args).toEqual(['-j4', 'build']);
  });

  it('reports an unsupported system instead of guessing', () => {
    const plan = planBuild({ ...base, projectType: 'Unknown' }, 'compile', false);
    expect(plan.supported).toBe(false);
    expect(plan.reason).toContain('build system');
  });
});
