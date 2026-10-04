import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import type { ProjectProfile } from '../types/workspace.js';
import { splitCommandLine } from '../runner/process-runner.js';

/**
 * Test framework detection and command planning (docs/TOOLS.md Phase 5).
 *
 * Deterministic rule table, never an LLM call: the project's own declared commands win, then
 * the build system, then the language. A runner we cannot map is refused as
 * `UNSUPPORTED_PROJECT` instead of guessing a command.
 */

export type TestFramework =
  | 'pytest'
  | 'unittest'
  | 'junit'
  | 'jest'
  | 'vitest'
  | 'node-test'
  | 'script'
  | 'unknown';

export interface NodeTestManifest {
  scripts: Record<string, string>;
  dependencies: string[];
}

/** package.json is read at run time; `ProjectProfile` deliberately does not carry scripts. */
export async function readNodeTestManifest(root: string): Promise<NodeTestManifest> {
  try {
    const raw = await fs.readFile(path.join(root, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as {
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return {
      scripts: parsed.scripts ?? {},
      dependencies: [
        ...Object.keys(parsed.dependencies ?? {}),
        ...Object.keys(parsed.devDependencies ?? {}),
      ],
    };
  } catch {
    return { scripts: {}, dependencies: [] };
  }
}

export interface TestPlanInput {
  root: string;
  profile: ProjectProfile;
  config: DevPilotConfig;
  manifest: NodeTestManifest;
}

export interface TestPlanOptions {
  /** Framework-level filter (`-k`, `-Dtest=`, `--tests`, `-t`). */
  filter?: string;
  /** Restrict the run to one test file (workspace-relative or absolute inside the workspace). */
  file?: string;
  failFast?: boolean;
  extraArgs?: string[];
}

export interface TestPlan {
  supported: boolean;
  reason?: string;
  framework: TestFramework;
  command: string;
  args: string[];
  /** `config` when `.devpilot/config.yml` decided the command, `rules` otherwise. */
  source: 'config' | 'rules';
  notes: string[];
}

const PYTHON_PROJECT_TYPES = new Set(['PyTorch', 'FastAPI', 'Flask', 'Django']);
const PYTHON_BUILD_SYSTEMS = new Set(['pip', 'poetry']);

function isNodeBuildSystem(buildSystem: string): boolean {
  return buildSystem === 'npm' || buildSystem === 'pnpm' || buildSystem === 'yarn';
}

export function isPythonProject(profile: ProjectProfile): boolean {
  const buildSystem = profile.buildSystem ?? '';
  return (
    PYTHON_BUILD_SYSTEMS.has(buildSystem) ||
    PYTHON_PROJECT_TYPES.has(profile.projectType) ||
    profile.languages.includes('Python')
  );
}

export function detectTestFramework(input: TestPlanInput): TestFramework {
  const { profile, manifest } = input;
  const buildSystem = profile.buildSystem ?? '';

  if (buildSystem === 'maven' || buildSystem === 'gradle') return 'junit';

  const dependencies = manifest.dependencies.map((name) => name.toLowerCase());
  const testScript = (manifest.scripts['test'] ?? '').toLowerCase();
  if (dependencies.includes('vitest') || testScript.includes('vitest')) return 'vitest';
  if (dependencies.includes('jest') || testScript.includes('jest')) return 'jest';
  if (testScript.includes('node --test') || testScript.includes('node:test')) return 'node-test';
  if (isNodeBuildSystem(buildSystem)) {
    return manifest.scripts['test'] === undefined ? 'unknown' : 'script';
  }
  if (isPythonProject(profile)) {
    return profile.testFramework === 'unittest' ? 'unittest' : 'pytest';
  }
  return 'unknown';
}

/** `python` for pip projects, `poetry run python` for poetry projects. */
function pythonLauncher(profile: ProjectProfile): { command: string; prefix: string[] } {
  if (profile.buildSystem === 'poetry') return { command: 'poetry', prefix: ['run', 'python'] };
  return { command: 'python', prefix: [] };
}

function nodeManager(profile: ProjectProfile): string {
  const buildSystem = profile.buildSystem ?? 'npm';
  return isNodeBuildSystem(buildSystem) ? buildSystem : 'npm';
}

function gradleCommand(profile: ProjectProfile): string {
  if (profile.markers.includes('gradlew.bat')) return 'gradlew.bat';
  if (profile.markers.includes('gradlew')) return 'gradlew';
  return 'gradle';
}

export function planTests(input: TestPlanInput, options: TestPlanOptions = {}): TestPlan {
  const { config, profile } = input;
  const extraArgs = options.extraArgs ?? [];
  const framework = detectTestFramework(input);
  const notes: string[] = [];

  const override = config.project.test_command;
  if (override !== null && override.trim() !== '') {
    const split = splitCommandLine(override);
    return {
      supported: true,
      framework,
      command: split.command,
      args: [...split.args, ...extraArgs],
      source: 'config',
      notes: [`test command taken from .devpilot/config.yml (${override})`],
    };
  }

  const base = { framework, source: 'rules' as const, notes };

  switch (framework) {
    case 'pytest': {
      const launcher = pythonLauncher(profile);
      // No `-q` here on purpose: a project whose own addopts already contains `-q` would end
      // up at `-qq`, which suppresses the summary line we parse — a silent "0 failures".
      // `-p no:cacheprovider` keeps .pytest_cache out of the user's working tree.
      const args = [...launcher.prefix, '-m', 'pytest', '-p', 'no:cacheprovider'];
      if (options.file !== undefined && options.file !== '') args.push(options.file);
      if (options.filter !== undefined && options.filter !== '') args.push('-k', options.filter);
      if (options.failFast === true) args.push('-x');
      args.push(...extraArgs);
      return { ...base, supported: true, command: launcher.command, args };
    }
    case 'unittest': {
      const launcher = pythonLauncher(profile);
      const args = [...launcher.prefix, '-m', 'unittest'];
      if (options.file !== undefined && options.file !== '') args.push(options.file);
      if (options.filter !== undefined && options.filter !== '') args.push('-k', options.filter);
      if (options.failFast === true) args.push('-f');
      args.push(...extraArgs);
      return { ...base, supported: true, command: launcher.command, args };
    }
    case 'junit': {
      const selector = options.file !== undefined && options.file !== '' ? options.file : options.filter;
      if (profile.buildSystem === 'gradle') {
        const args = ['test', '--no-daemon'];
        if (selector !== undefined && selector !== '') args.push('--tests', selector);
        if (options.failFast === true) args.push('--fail-fast');
        args.push(...extraArgs);
        return { ...base, supported: true, command: gradleCommand(profile), args };
      }
      // No `-q` on purpose (Phase 10): on success Surefire prints its `Tests run:` summary at
      // INFO level, so quiet mode hides the only line we can parse and a green suite reads as
      // "0 tests". `-B` keeps output stable without muting the summary.
      const args = ['-B', 'test'];
      if (selector !== undefined && selector !== '') args.push(`-Dtest=${selector}`);
      if (options.failFast === true) args.push('-Dsurefire.skipAfterFailureCount=1');
      args.push(...extraArgs);
      return { ...base, supported: true, command: 'mvn', args };
    }
    case 'vitest': {
      const passthrough = ['run'];
      if (options.file !== undefined && options.file !== '') passthrough.push(options.file);
      if (options.filter !== undefined && options.filter !== '') passthrough.push('-t', options.filter);
      if (options.failFast === true) passthrough.push('--bail=1');
      passthrough.push(...extraArgs);
      return {
        ...base,
        supported: true,
        command: nodeManager(profile),
        args: ['test', '--', ...passthrough],
      };
    }
    case 'jest': {
      const passthrough = ['--ci'];
      if (options.file !== undefined && options.file !== '') passthrough.push(options.file);
      if (options.filter !== undefined && options.filter !== '') passthrough.push('-t', options.filter);
      if (options.failFast === true) passthrough.push('--bail=1');
      passthrough.push(...extraArgs);
      return {
        ...base,
        supported: true,
        command: nodeManager(profile),
        args: ['test', '--', ...passthrough],
      };
    }
    case 'node-test': {
      const passthrough: string[] = [];
      if (options.file !== undefined && options.file !== '') passthrough.push(options.file);
      passthrough.push(...extraArgs);
      const args = ['test'];
      if (passthrough.length > 0) args.push('--', ...passthrough);
      return { ...base, supported: true, command: nodeManager(profile), args };
    }
    case 'script': {
      const args = ['test'];
      if (extraArgs.length > 0) args.push('--', ...extraArgs);
      return {
        ...base,
        supported: true,
        command: nodeManager(profile),
        args,
        notes: [
          ...notes,
          'package.json declares a test script; output is parsed heuristically because the underlying runner is unknown',
        ],
      };
    }
    default:
      return {
        ...base,
        supported: false,
        command: '',
        args: [],
        reason: `no test runner could be detected (build system: ${profile.buildSystem ?? 'none'}, type: ${profile.projectType})`,
      };
  }
}
