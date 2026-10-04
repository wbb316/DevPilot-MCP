import { promises as fs } from 'node:fs';
import path from 'node:path';

import { splitCommandLine } from './process-runner.js';

/**
 * Build command planning (docs/ROADMAP.md Phase 4). Rule based, never LLM-based: the same
 * markers always produce the same command, and anything the rules cannot map is refused
 * with a reason that names the fix (declare `project.build_command` in .devpilot/config.yml).
 */

export type BuildTarget = 'compile' | 'test-compile' | 'package';

export const BUILD_TARGETS: readonly BuildTarget[] = ['compile', 'test-compile', 'package'];

export interface BuildPlanInput {
  root: string;
  buildSystem?: string;
  projectType: string;
  framework?: string;
  markers: readonly string[];
  scripts?: Record<string, string>;
  sourceDirs: readonly string[];
  /** config.project.build_command — wins over every rule. */
  override?: string | null;
}

export interface BuildPlan {
  /** 'maven' | 'gradle' | 'npm' | 'pnpm' | 'yarn' | 'python' | 'poetry' | 'config' | 'unknown' */
  system: string;
  command: string;
  args: string[];
  /** Set when a project-local wrapper (mvnw / gradlew) must be used instead of PATH lookup. */
  resolvedPath?: string;
  supported: boolean;
  reason?: string;
  notes: string[];
}

function planFromOverride(override: string, notes: string[]): BuildPlan {
  const { command, args } = splitCommandLine(override);
  return { system: 'config', command, args, supported: true, notes };
}

function mavenPlan(input: BuildPlanInput, target: BuildTarget, clean: boolean, notes: string[]): BuildPlan {
  const wrapper = input.markers.includes('mvnw.cmd')
    ? 'mvnw.cmd'
    : input.markers.includes('mvnw')
      ? 'mvnw'
      : undefined;
  const args = ['-q'];
  if (clean) args.push('clean');
  if (target === 'package') args.push('-DskipTests', 'package');
  else if (target === 'test-compile') args.push('test-compile');
  else args.push('compile');

  if (wrapper !== undefined) {
    notes.push(`using the project wrapper ${wrapper}`);
    const plan: BuildPlan = {
      system: 'maven',
      command: wrapper,
      args,
      resolvedPath: path.join(input.root, wrapper),
      supported: true,
      notes,
    };
    return plan;
  }
  return { system: 'maven', command: 'mvn', args, supported: true, notes };
}

function gradlePlan(input: BuildPlanInput, target: BuildTarget, clean: boolean, notes: string[]): BuildPlan {
  const isWin = process.platform === 'win32';
  const wrapperName = isWin ? 'gradlew.bat' : 'gradlew';
  const wrapper = input.markers.includes(wrapperName) ? wrapperName : undefined;
  const args: string[] = [];
  if (clean) args.push('clean');
  if (target === 'package') args.push('build', '-x', 'test');
  else if (target === 'test-compile') args.push('testClasses');
  else args.push('compileJava');
  args.push('--no-daemon');

  if (wrapper !== undefined) {
    notes.push(`using the project wrapper ${wrapper}`);
    return {
      system: 'gradle',
      command: wrapper,
      args,
      resolvedPath: path.join(input.root, wrapper),
      supported: true,
      notes,
    };
  }
  notes.push('no gradle wrapper in the project; relying on `gradle` from PATH');
  return { system: 'gradle', command: 'gradle', args, supported: true, notes };
}

function nodePlan(input: BuildPlanInput, target: BuildTarget, clean: boolean, notes: string[]): BuildPlan {
  const manager = input.buildSystem === 'pnpm' || input.buildSystem === 'yarn' ? input.buildSystem : 'npm';
  const scripts = input.scripts ?? {};
  const script =
    target === 'test-compile'
      ? scripts['typecheck'] !== undefined
        ? 'typecheck'
        : scripts['build'] !== undefined
          ? 'build'
          : undefined
      : scripts['build'] !== undefined
        ? 'build'
        : undefined;

  if (script === undefined) {
    return {
      system: manager,
      command: manager,
      args: [],
      supported: false,
      reason:
        target === 'test-compile'
          ? 'package.json has neither a "typecheck" nor a "build" script'
          : 'package.json has no "build" script',
      notes,
    };
  }
  if (clean) notes.push('`clean` is not a concept for npm scripts; the build script decides caching');
  if (target === 'package') notes.push('npm "package" maps onto the existing build script');
  return { system: manager, command: manager, args: ['run', script], supported: true, notes };
}

function pythonPlan(input: BuildPlanInput, target: BuildTarget, notes: string[]): BuildPlan {
  const poetry = input.buildSystem === 'poetry';
  const command = poetry ? 'poetry' : 'python';
  // The interpreter is already the command unless we go through poetry.
  const prefix = poetry ? ['run', 'python'] : [];
  const targets = input.sourceDirs.length > 0 ? input.sourceDirs.slice(0, 8) : ['.'];

  if (target === 'package') {
    if (!input.markers.includes('pyproject.toml')) {
      return {
        system: poetry ? 'poetry' : 'python',
        command,
        args: prefix,
        supported: false,
        reason: 'no pyproject.toml: there is no standard packaging entry point',
        notes,
      };
    }
    notes.push('packaging runs `python -m build`; the `build` module must be installed');
    return {
      system: poetry ? 'poetry' : 'python',
      command,
      args: poetry ? ['build'] : ['-m', 'build'],
      supported: true,
      notes,
    };
  }

  notes.push(`syntax check over ${targets.join(' ')} (no true compile step in Python)`);
  return {
    system: poetry ? 'poetry' : 'python',
    command,
    args: [...prefix, '-m', 'compileall', '-q', ...targets],
    supported: true,
    notes,
  };
}

export function planBuild(input: BuildPlanInput, target: BuildTarget, clean: boolean): BuildPlan {
  const notes: string[] = [];
  if (input.override !== null && input.override !== undefined && input.override.trim() !== '') {
    return planFromOverride(input.override.trim(), ['config.project.build_command takes precedence']);
  }

  switch (input.buildSystem) {
    case 'maven':
      return mavenPlan(input, target, clean, notes);
    case 'gradle':
      return gradlePlan(input, target, clean, notes);
    case 'npm':
    case 'pnpm':
    case 'yarn':
      return nodePlan(input, target, clean, notes);
    case 'pip':
    case 'poetry':
      return pythonPlan(input, target, notes);
    default:
      return {
        system: 'unknown',
        command: '',
        args: [],
        supported: false,
        reason: `no supported build system detected (buildSystem=${input.buildSystem ?? 'none'})`,
        notes,
      };
  }
}

/** Package artifacts worth pointing at after a successful `package` build. */
export async function findBuildArtifacts(root: string, system: string): Promise<string[]> {
  const dirs =
    system === 'maven'
      ? [path.join(root, 'target')]
      : system === 'gradle'
        ? [path.join(root, 'build', 'libs')]
        : [];
  const found: string[] = [];
  for (const dir of dirs) {
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!/\.(jar|war|zip|tar\.gz)$/.test(entry)) continue;
      found.push(`${path.relative(root, path.join(dir, entry)).split(path.sep).join('/')}`);
      if (found.length >= 5) return found;
    }
  }
  return found;
}
