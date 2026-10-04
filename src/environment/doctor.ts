import os from 'node:os';
import path from 'node:path';

import type { Logger } from '../log/logger.js';
import type { CheckStatus, EnvironmentReport, OsInfo, ToolchainCheck } from '../types/environment.js';
import { runProcess } from '../runner/process-runner.js';
import {
  TOOLS,
  pathExists,
  probeTool,
  probeTorch,
  readTextIfExists,
  resolvePaths,
  type ProbeOutcome,
  type ToolSpec,
} from './toolchain.js';

/**
 * `doctor` — docs/ROADMAP.md Phase 9, docs/TOOLS.md Phase 9.
 *
 * The job is to answer "why did this project fail to build on *this* machine" before the agent
 * starts guessing: which toolchains exist, which of them conflict, and which of them the project in
 * `cwd` actually needs. Diagnostics only — nothing here installs or reconfigures anything, because
 * silently changing a user's toolchain is not a thing a coding agent should do behind their back.
 */

export interface DoctorOptions {
  cwd: string;
  verbose?: boolean;
  timeoutMs?: number;
  logger?: Logger;
}

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const TORCH_TIMEOUT_MS = 30_000;
const DOCKER_TIMEOUT_MS = 8_000;

const PROJECT_MARKERS = [
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'package.json',
  'requirements.txt',
  'pyproject.toml',
  'Pipfile',
] as const;

function statusFor(outcome: ProbeOutcome, spec: ToolSpec): CheckStatus {
  if (outcome.found) return outcome.timedOut ? 'WARNING' : 'OK';
  return spec.optional === true ? 'WARNING' : 'ERROR';
}

function worst(statuses: readonly CheckStatus[]): CheckStatus {
  if (statuses.includes('ERROR')) return 'ERROR';
  if (statuses.includes('WARNING')) return 'WARNING';
  return 'OK';
}

function osInfo(cwd: string): OsInfo {
  const details: Record<string, string> = {
    node: process.version,
    cwd,
  };
  if (process.env['SHELL'] !== undefined) details['shell'] = process.env['SHELL'];
  if (process.env['ComSpec'] !== undefined) details['comspec'] = process.env['ComSpec'];
  if (process.env['JAVA_HOME'] !== undefined) details['JAVA_HOME'] = process.env['JAVA_HOME'];
  if (process.env['CONDA_DEFAULT_ENV'] !== undefined) details['condaEnv'] = process.env['CONDA_DEFAULT_ENV'];
  if (process.env['VIRTUAL_ENV'] !== undefined) details['virtualEnv'] = process.env['VIRTUAL_ENV'];

  return {
    platform: process.platform,
    release: os.release(),
    arch: process.arch,
    cpus: os.cpus().length,
    memoryGb: Math.round((os.totalmem() / 1024 ** 3) * 10) / 10,
    details,
  };
}

function normalize(target: string): string {
  const resolved = path.resolve(target);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

interface NodeEngines {
  node?: string;
}

function minimumNodeMajor(range: string): number | undefined {
  const match = /(?:>=|\^|~)?\s*v?(\d+)/.exec(range);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

export async function runDoctor(options: DoctorOptions): Promise<EnvironmentReport> {
  const cwd = path.resolve(options.cwd);
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const notes: string[] = [];
  const conflicts: ToolchainCheck[] = [];

  const outcomes = await Promise.all(
    TOOLS.map(async (spec) => ({ spec, outcome: await probeTool(spec, cwd, timeoutMs, options.logger) })),
  );

  const [pythonPaths, javaPaths, nodePaths] = await Promise.all([
    resolvePaths('python', cwd, timeoutMs),
    resolvePaths('java', cwd, timeoutMs),
    resolvePaths('node', cwd, timeoutMs),
  ]);

  const tools: ToolchainCheck[] = outcomes.map(({ spec, outcome }) => {
    const check: ToolchainCheck = { name: spec.name, status: statusFor(outcome, spec) };
    if (outcome.version !== undefined) check.version = outcome.version;
    else if (spec.name === 'gpu' && outcome.detail !== undefined) check.version = outcome.detail;
    const primary = firstPathFor(spec.name, { python: pythonPaths, java: javaPaths, node: nodePaths });
    if (primary !== undefined) check.path = primary;
    if (!outcome.found) {
      check.message = outcome.timedOut
        ? `probe timed out after ${Math.round(timeoutMs / 1000)}s`
        : outcome.spawnError !== undefined
          ? `could not be started: ${outcome.spawnError}`
          : 'not found on PATH';
      check.fix = spec.fix;
    } else if (outcome.version === undefined && spec.versionPattern !== undefined) {
      check.status = check.status === 'OK' ? 'WARNING' : check.status;
      check.message = 'present, but its version could not be parsed';
    }
    return check;
  });

  const timedOut = outcomes.filter(({ outcome }) => outcome.timedOut).map(({ spec }) => spec.name);
  if (timedOut.length > 0) {
    notes.push(`probe(s) timed out and were reported without a version: ${timedOut.join(', ')}`);
  }

  // --- project-aware requirements ---------------------------------------------------------------
  const markers: string[] = [];
  for (const marker of PROJECT_MARKERS) {
    if (await pathExists(path.join(cwd, marker))) markers.push(marker);
  }
  const needsJava = markers.some((marker) => marker.startsWith('build.gradle') || marker === 'pom.xml');
  const needsNode = markers.includes('package.json');
  const needsPython = markers.some((marker) => marker === 'requirements.txt' || marker === 'pyproject.toml' || marker === 'Pipfile');
  const has = (name: string): boolean => outcomes.find(({ spec }) => spec.name === name)?.outcome.found === true;

  if (markers.length > 0) {
    notes.push(`project markers in ${cwd}: ${markers.join(', ')}`);
  }
  const require = (name: string, need: boolean, why: string, fix: string): void => {
    if (!need || has(name)) return;
    const check: ToolchainCheck = { name, status: 'ERROR', message: `missing but required by ${why}`, fix };
    conflicts.push(check);
  };
  require('java', needsJava, 'this project (Maven/Gradle build)', 'install a JDK and set JAVA_HOME');
  require('node', needsNode, 'this project (package.json)', 'install Node.js 20.11+');
  require('python', needsPython, 'this project (Python dependencies)', 'install Python and put it on PATH');
  if (needsJava && has('java') && !has('mvn') && markers.includes('pom.xml') && !(await pathExists(path.join(cwd, 'mvnw')))) {
    conflicts.push({
      name: 'mvn',
      status: 'WARNING',
      message: 'Maven project without a mvnw wrapper and without mvn on PATH',
      fix: 'install Maven, or add the Maven wrapper to the project',
    });
  }

  // --- conflicting installations ----------------------------------------------------------------
  const multi = (name: string, paths: readonly string[]): void => {
    if (paths.length <= 1) return;
    conflicts.push({
      name,
      status: 'WARNING',
      message: `${paths.length} installations on PATH — command resolution depends on order: ${paths.join(' ; ')}`,
      fix: `keep one ${name} on PATH (or pin the project to one through a virtualenv / toolchain file)`,
      path: paths[0],
    });
  };
  multi('python', pythonPaths);
  multi('java', javaPaths);
  multi('node', nodePaths);

  const javaHome = process.env['JAVA_HOME'];
  if (javaHome !== undefined && javaPaths[0] !== undefined) {
    const home = normalize(javaHome);
    if (!normalize(javaPaths[0]).startsWith(home)) {
      conflicts.push({
        name: 'JAVA_HOME',
        status: 'WARNING',
        message: `JAVA_HOME (${javaHome}) does not contain the java that PATH resolves first (${javaPaths[0]})`,
        fix: 'point JAVA_HOME at the same JDK that PATH uses, or fix PATH order',
      });
    }
  }

  // --- CUDA / PyTorch ---------------------------------------------------------------------------
  const nvcc = outcomes.find(({ spec }) => spec.name === 'nvcc');
  const gpu = outcomes.find(({ spec }) => spec.name === 'gpu');
  if (has('python')) {
    const torch = await probeTorch('python', cwd, TORCH_TIMEOUT_MS);
    if (torch === undefined) {
      notes.push('torch could not be imported with `python` — GPU checks that need PyTorch were skipped');
    } else {
      const check: ToolchainCheck = {
        name: 'torch',
        status: 'OK',
        version: torch.version,
        message: torch.cuda === undefined ? 'CPU-only build' : `CUDA ${torch.cuda}`,
      };
      tools.push(check);

      const nvccVersion = nvcc?.outcome.version;
      if (nvccVersion !== undefined && torch.cuda !== undefined) {
        const toolkitMajor = nvccVersion.split('.')[0];
        const torchMajor = torch.cuda.split('.')[0];
        if (toolkitMajor !== undefined && torchMajor !== undefined && toolkitMajor !== torchMajor) {
          conflicts.push({
            name: 'cuda',
            status: 'WARNING',
            message: `CUDA toolkit ${nvccVersion} does not match the CUDA ${torch.cuda} this PyTorch was built for`,
            expected: torch.cuda,
            fix: 'install a CUDA toolkit matching the PyTorch wheel, or install the wheel matching the toolkit',
          });
        }
      }
      if (nvccVersion !== undefined && torch.cuda === undefined) {
        conflicts.push({
          name: 'cuda',
          status: 'WARNING',
          message: 'a CUDA toolkit is installed but PyTorch is a CPU-only build',
          fix: 'install the CUDA PyTorch wheel (see pytorch.org) if you intend to use the GPU',
        });
      }
      if (gpu?.outcome.found === true && !torch.available) {
        conflicts.push({
          name: 'torch.cuda',
          status: 'WARNING',
          message: 'an NVIDIA GPU is present but torch.cuda.is_available() is False',
          fix: 'check the driver version and that the installed wheel is the CUDA build',
        });
      }
    }
  }

  // --- Node engine expectation ------------------------------------------------------------------
  if (needsNode) {
    const manifest = await readTextIfExists(path.join(cwd, 'package.json'));
    const engines = manifest === undefined ? undefined : readEngines(manifest);
    const required = engines?.node;
    const current = outcomes.find(({ spec }) => spec.name === 'node')?.outcome.version;
    if (required !== undefined && current !== undefined) {
      const minimum = minimumNodeMajor(required);
      const actual = Number(current.split('.')[0]);
      if (minimum !== undefined && Number.isFinite(actual) && actual < minimum) {
        conflicts.push({
          name: 'node',
          status: 'WARNING',
          message: `this project requires node ${required} but ${current} is first on PATH`,
          expected: required,
          fix: 'switch Node versions (nvm/fnm/volta) before building this project',
        });
      }
    }
  }

  // --- Docker daemon ----------------------------------------------------------------------------
  if (has('docker')) {
    const info = await runProcess({
      command: 'docker',
      args: ['info', '--format', '{{.ServerVersion}}'],
      cwd,
      timeoutMs: DOCKER_TIMEOUT_MS,
      maxStdoutBytes: 4 * 1024,
      maxStderrBytes: 4 * 1024,
      ...(options.logger === undefined ? {} : { logger: options.logger }),
    });
    if (info.exitCode !== 0) {
      conflicts.push({
        name: 'docker',
        status: 'WARNING',
        message: 'the docker CLI is installed but the daemon is not reachable',
        fix: 'start Docker Desktop before running compose-based workflows',
      });
    }
  }

  const report: EnvironmentReport = {
    generatedAt: new Date().toISOString(),
    os: osInfo(cwd),
    tools,
    conflicts,
    overall: worst([...tools.map((tool) => tool.status), ...conflicts.map((conflict) => conflict.status)]),
    notes,
  };
  if (options.verbose === true) {
    report.notes.push(`verbose: probed ${outcomes.length} tool(s) with a ${Math.round(timeoutMs / 1000)}s timeout each`);
  }
  return report;
}

function firstPathFor(name: string, lists: Record<string, readonly string[]>): string | undefined {
  return lists[name]?.[0];
}

function readEngines(manifest: string): NodeEngines | undefined {
  try {
    const parsed = JSON.parse(manifest) as { engines?: NodeEngines };
    return parsed.engines;
  } catch {
    return undefined;
  }
}
