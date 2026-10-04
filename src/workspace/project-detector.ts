import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import { DEFAULT_EXCLUDES } from '../config/config-schema.js';
import type { ProjectProfile } from '../types/workspace.js';

/**
 * Rule-based project detection (docs/ARCHITECTURE.md §4.8 — deterministic, never LLM).
 * Phase 1 answers "what kind of project is this and how would one build/test/run it?" at
 * marker level; Phase 2's project-scanner reuses this and adds statistics and caching.
 */

export interface DetectProjectOptions {
  name?: string;
  config?: DevPilotConfig;
  /** Walk caps keep detection bounded on huge repositories. */
  maxScanFiles?: number;
  maxDepth?: number;
  /**
   * Pre-computed, ignore-aware file list (workspace/file-walker). When present the internal
   * walk is skipped, so `.gitignore` semantics live in exactly one place (docs/ROADMAP.md Phase 2).
   */
  files?: readonly string[];
  /** true when the caller's walk hit its file cap. */
  truncated?: boolean;
}

/** Order is stable on purpose: `markers` must be deterministic for equal trees. */
const MARKER_FILES: readonly string[] = [
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradlew',
  'gradlew.bat',
  'mvnw',
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'tsconfig.json',
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'Pipfile',
  'poetry.lock',
  'CMakeLists.txt',
  'go.mod',
  'Cargo.toml',
  'Dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
];

/** Marker ownership, used to decide which ecosystem owns a polyglot repository. */
const NODE_MARKERS = new Set([
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'tsconfig.json',
]);
const JAVA_MARKERS = new Set([
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'gradlew',
  'gradlew.bat',
  'mvnw',
]);
const PYTHON_MARKERS = new Set([
  'requirements.txt',
  'pyproject.toml',
  'setup.py',
  'Pipfile',
  'poetry.lock',
]);

const ENTRYPOINT_CANDIDATES: readonly string[] = [  'train.py',
  'sample.py',
  'main.py',
  'app.py',
  'run.py',
  'server.py',
  'manage.py',
  'cli.py',
  'src/main.py',
  'src/app.py',
  'src/server.py',
  'app/main.py',
  'src/index.ts',
  'src/index.js',
  'src/main.ts',
  'src/main.js',
  'src/server.ts',
  'index.js',
  'index.ts',
  'main.go',
  'src/main.rs',
];

const SOURCE_DIR_CANDIDATES: readonly string[] = [
  'src',
  'src/main/java',
  'src/main/kotlin',
  'src/main/resources',
  'app',
  'lib',
  'packages',
];

const TEST_DIR_CANDIDATES: readonly string[] = [
  'tests',
  'test',
  'spec',
  'specs',
  '__tests__',
  'src/test',
  'src/test/java',
];

const CONFIG_DIR_CANDIDATES: readonly string[] = [
  'config',
  'configs',
  'conf',
  'resources',
  'src/main/resources',
  '.github',
  'deploy',
];

interface TreeScan {
  /** Workspace-relative POSIX paths. */
  files: string[];
  truncated: boolean;
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(target: string): Promise<string | undefined> {
  try {
    return await fs.readFile(target, 'utf8');
  } catch {
    return undefined;
  }
}

function toPosix(relative: string): string {
  return relative.split(path.sep).join('/');
}

/** Bounded, ignore-aware walk. Nothing here mutates the tree. */
async function scanTree(
  root: string,
  exclude: readonly string[],
  maxFiles: number,
  maxDepth: number,
): Promise<TreeScan> {
  const excluded = new Set(exclude.map((entry) => entry.toLowerCase()));
  const files: string[] = [];
  let truncated = false;

  const queue: { dir: string; depth: number }[] = [{ dir: root, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) break;
    let entries;
    try {
      entries = await fs.readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const absolute = path.join(current.dir, entry.name);
      if (entry.isDirectory()) {
        if (excluded.has(entry.name.toLowerCase())) continue;
        if (entry.name.startsWith('.') && entry.name !== '.github') continue;
        if (current.depth + 1 > maxDepth) continue;
        queue.push({ dir: absolute, depth: current.depth + 1 });
        continue;
      }
      if (!entry.isFile()) continue;
      files.push(toPosix(path.relative(root, absolute)));
      if (files.length >= maxFiles) {
        truncated = true;
        return { files, truncated };
      }
    }
  }
  return { files, truncated };
}

async function existingRelative(root: string, candidates: readonly string[]): Promise<string[]> {
  const found: string[] = [];
  for (const candidate of candidates) {
    if (await pathExists(path.join(root, candidate))) found.push(toPosix(candidate));
  }
  return found;
}

function detectPython(files: readonly string[], blobs: readonly string[]): {
  languages: string[];
  projectType?: string;
  framework?: string;
  buildSystem?: string;
  testFramework?: string;
} {
  const hasPython = files.some((file) => file.endsWith('.py'));
  if (!hasPython) return { languages: [] };

  const blob = blobs.join('\n').toLowerCase();
  let projectType = 'Python';
  let framework: string | undefined;
  if (blob.includes('torch') || blob.includes('pytorch')) {
    projectType = 'PyTorch';
    framework = 'PyTorch';
  } else if (blob.includes('fastapi')) {
    projectType = 'FastAPI';
    framework = 'FastAPI';
  } else if (blob.includes('flask')) {
    projectType = 'Flask';
    framework = 'Flask';
  } else if (blob.includes('django')) {
    projectType = 'Django';
    framework = 'Django';
  }

  const testFramework = blob.includes('pytest')
    ? 'pytest'
    : blob.includes('unittest')
      ? 'unittest'
      : files.some((file) => /(^|\/)tests?\/.*test.*\.py$/.test(file))
        ? 'pytest'
        : undefined;

  return {
    languages: ['Python'],
    ...(projectType === 'Python' ? {} : { projectType }),
    ...(framework === undefined ? {} : { framework }),
    buildSystem: 'pip',
    ...(testFramework === undefined ? {} : { testFramework }),
  };
}

function detectJava(files: readonly string[], poms: readonly string[], markFilename: string): {
  languages: string[];
  projectType?: string;
  framework?: string;
  buildSystem?: string;
  testFramework?: string;
} {
  const hasJava = files.some((file) => file.endsWith('.java'));
  const hasKotlin = files.some((file) => file.endsWith('.kt') || file.endsWith('.kts'));
  if (!hasJava && !hasKotlin) return { languages: [] };

  const blob = poms.join('\n').toLowerCase();
  const spring = blob.includes('spring-boot') || blob.includes('springframework.boot');
  const gradle = markFilename.startsWith('build.gradle') || markFilename.startsWith('settings.gradle');
  return {
    languages: [...(hasJava ? ['Java'] : []), ...(hasKotlin ? ['Kotlin'] : [])],
    projectType: spring ? 'SpringBoot' : 'Java',
    ...(spring ? { framework: 'Spring Boot' } : {}),
    buildSystem: gradle ? 'gradle' : 'maven',
    testFramework: blob.includes('junit') || files.some((file) => /src\/test\//.test(file)) ? 'junit' : 'none',
  };
}

interface NodeManifest {
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  main?: string;
}

function detectNode(files: readonly string[], packageJson: string | undefined, lockfile: string | undefined): {
  languages: string[];
  projectType?: string;
  framework?: string;
  buildSystem?: string;
  testFramework?: string;
  scripts: Record<string, string>;
  main?: string;
} {
  if (packageJson === undefined) {
    return { languages: [], scripts: {} };
  }

  let manifest: NodeManifest = {};
  try {
    manifest = JSON.parse(packageJson) as NodeManifest;
  } catch {
    manifest = {};
  }

  const scripts = manifest.scripts ?? {};
  const dependencies = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };
  const names = Object.keys(dependencies).map((name) => name.toLowerCase());
  const has = (needle: string): boolean => names.some((name) => name === needle || name.startsWith(`${needle}/`));

  let projectType = 'Node';
  let framework: string | undefined;
  if (has('next')) {
    projectType = 'Next.js';
    framework = 'Next.js';
  } else if (has('react')) {
    projectType = 'React';
    framework = 'React';
  } else if (has('vue')) {
    projectType = 'Vue';
    framework = 'Vue';
  } else if (has('express')) {
    projectType = 'Express';
    framework = 'Express';
  }

  const scriptText = Object.values(scripts).join(' ');
  let testFramework: string | undefined;
  if (has('vitest') || /vitest/.test(scriptText)) testFramework = 'vitest';
  else if (has('jest') || /jest/.test(scriptText)) testFramework = 'jest';

  const languages = files.some((file) => file.endsWith('.ts') || file.endsWith('.tsx'))
    ? ['TypeScript', 'JavaScript']
    : ['JavaScript'];
  const buildSystem =
    lockfile === 'pnpm-lock.yaml'
      ? 'pnpm'
      : lockfile === 'yarn.lock'
        ? 'yarn'
        : lockfile === 'package-lock.json'
          ? 'npm'
          : 'npm';

  return {
    languages,
    projectType,
    ...(framework === undefined ? {} : { framework }),
    buildSystem,
    ...(testFramework === undefined ? {} : { testFramework }),
    scripts,
    ...(manifest.main === undefined ? {} : { main: manifest.main }),
  };
}

export async function detectProject(
  rootInput: string,
  options: DetectProjectOptions = {},
): Promise<ProjectProfile> {
  const root = path.resolve(rootInput);
  const exclude = options.config?.workspace.exclude ?? [...DEFAULT_EXCLUDES];
  const files =
    options.files ??
    (await scanTree(root, exclude, options.maxScanFiles ?? 5_000, options.maxDepth ?? 12)).files;

  // Markers: only what actually exists, in the frozen order.
  const markers: string[] = [];
  for (const marker of MARKER_FILES) {
    if (await pathExists(path.join(root, marker))) markers.push(marker);
  }
  if (await pathExists(path.join(root, '.git'))) markers.push('.git');

  const blobNames = ['requirements.txt', 'pyproject.toml', 'setup.py', 'Pipfile', 'poetry.lock'];
  const blobs: string[] = [];
  for (const name of blobNames) {
    const text = await readTextIfExists(path.join(root, name));
    if (text !== undefined) blobs.push(text);
  }

  const packageJson = await readTextIfExists(path.join(root, 'package.json'));
  const lockfile = ['pnpm-lock.yaml', 'yarn.lock', 'package-lock.json'].find((name) =>
    markers.includes(name),
  );
  const pomText = [await readTextIfExists(path.join(root, 'pom.xml')), await readTextIfExists(path.join(root, 'build.gradle'))]
    .filter((text): text is string => text !== undefined);
  const gradleMarker = markers.find((marker) => marker.startsWith('build.gradle') || marker.startsWith('settings.gradle')) ?? '';

  const python = detectPython(files, blobs);
  const java = detectJava(files, pomText, gradleMarker);
  const node = detectNode(files, packageJson, lockfile);

  const languages = [...new Set([...python.languages, ...java.languages, ...node.languages])];

  // Which ecosystem owns this repository? Root markers decide, source-file counts break the
  // tie. Without this rule a TypeScript repository whose `fixtures/` happen to contain a
  // Maven sample is reported as a Java project, and every inferred command is then wrong.
  // Deterministic on purpose (docs/ARCHITECTURE.md §4.8): never an LLM.
  const sourceCount = (extensions: readonly string[]): number =>
    files.filter((file) => extensions.some((extension) => file.endsWith(extension))).length;

  const ecosystems = [
    {
      name: 'node',
      present: node.languages.length > 0,
      markers: markers.filter((marker) => NODE_MARKERS.has(marker)).length,
      sources: sourceCount(['.js', '.jsx', '.mjs', '.cjs', '.ts', '.tsx', '.mts', '.cts']),
      detected: node,
      priority: 2,
    },
    {
      name: 'java',
      present: java.languages.length > 0,
      markers: markers.filter((marker) => JAVA_MARKERS.has(marker)).length,
      sources: sourceCount(['.java', '.kt', '.kts']),
      detected: java,
      priority: 1,
    },
    {
      name: 'python',
      present: python.languages.length > 0,
      markers: markers.filter((marker) => PYTHON_MARKERS.has(marker)).length,
      sources: sourceCount(['.py', '.pyi']),
      detected: python,
      priority: 0,
    },
  ];

  const primary =
    [...ecosystems]
      .filter((ecosystem) => ecosystem.present)
      .sort(
        (a, b) => b.markers - a.markers || b.sources - a.sources || b.priority - a.priority,
      )[0]?.name ?? 'none';
  const chosen = ecosystems.find((ecosystem) => ecosystem.name === primary)?.detected;

  // The primary ecosystem goes first so summaries read "TypeScript / Node", not "Java".
  const orderedLanguages = [
    ...(chosen?.languages ?? []),
    ...languages.filter((language) => !(chosen?.languages ?? []).includes(language)),
  ];

  const FALLBACK_TYPE: Record<string, string> = { python: 'Python', java: 'Java', node: 'Node' };
  const buildSystem = chosen?.buildSystem ?? 'none';

  let projectType = chosen?.projectType ?? FALLBACK_TYPE[primary] ?? 'Unknown';
  const framework = chosen?.framework;
  const testFramework = chosen?.testFramework ?? 'none';

  if (options.config?.project.type) projectType = options.config.project.type;

  const entrypoints = await existingRelative(root, ENTRYPOINT_CANDIDATES);
  const sourceDirs = await existingRelative(root, SOURCE_DIR_CANDIDATES);
  const testDirs = await existingRelative(root, TEST_DIR_CANDIDATES);
  const configDirs = await existingRelative(root, CONFIG_DIR_CANDIDATES);

  const candidates = inferCommands({
    buildSystem,
    framework,
    entrypoints,
    testFramework,
    scripts: node.scripts,
    config: options.config,
  });

  const profile: ProjectProfile = {
    name: options.name ?? path.basename(root),
    root,
    languages: orderedLanguages,
    projectType,
    entrypoints,
    markers,
    sourceDirs,
    testDirs,
    configDirs,
    candidates,
    detectedAt: new Date().toISOString(),
  };
  if (framework !== undefined) profile.framework = framework;
  if (buildSystem !== 'none') {
    profile.buildSystem = buildSystem;
    profile.packageManager = packageManagerOf(buildSystem);
  }
  profile.testFramework = testFramework;
  return profile;
}

function packageManagerOf(buildSystem: string): string {
  switch (buildSystem) {
    case 'maven':
      return 'mvn';
    case 'gradle':
      return 'gradle';
    case 'pip':
      return 'pip';
    case 'poetry':
      return 'poetry';
    default:
      return buildSystem;
  }
}

interface CommandInputs {
  buildSystem: string;
  framework?: string;
  entrypoints: readonly string[];
  testFramework: string;
  scripts: Record<string, string>;
  config?: DevPilotConfig;
}

/** Deterministic command inference, overridable through .devpilot/config.yml. */
function inferCommands(inputs: CommandInputs): { build?: string; test?: string; run?: string } {
  const candidates: { build?: string; test?: string; run?: string } = {};

  switch (inputs.buildSystem) {
    case 'maven':
      candidates.build = 'mvn -q -DskipTests package';
      candidates.test = 'mvn -q test';
      if (inputs.framework === 'Spring Boot') candidates.run = 'mvn -q spring-boot:run';
      break;
    case 'gradle':
      candidates.build = './gradlew build --no-daemon';
      candidates.test = './gradlew test --no-daemon';
      if (inputs.framework === 'Spring Boot') candidates.run = './gradlew bootRun --no-daemon';
      break;
    case 'npm':
    case 'pnpm':
    case 'yarn': {
      const manager = inputs.buildSystem;
      if (inputs.scripts['build'] !== undefined) candidates.build = `${manager} run build`;
      if (inputs.scripts['test'] !== undefined) candidates.test = `${manager} test`;
      if (inputs.scripts['start'] !== undefined) candidates.run = `${manager} start`;
      else if (inputs.scripts['dev'] !== undefined) candidates.run = `${manager} run dev`;
      break;
    }
    case 'pip':
    case 'poetry':
      candidates.test = `${inputs.buildSystem === 'poetry' ? 'poetry run ' : ''}python -m pytest -q`;
      if (inputs.entrypoints[0] !== undefined) {
        candidates.run = `${inputs.buildSystem === 'poetry' ? 'poetry run ' : ''}python ${inputs.entrypoints[0]}`;
      }
      break;
    default:
      break;
  }

  const project = inputs.config?.project;
  if (project?.build_command) candidates.build = project.build_command;
  if (project?.test_command) candidates.test = project.test_command;
  if (project?.run_command) candidates.run = project.run_command;

  const cleaned: { build?: string; test?: string; run?: string } = {};
  if (candidates.build !== undefined) cleaned.build = candidates.build;
  if (candidates.test !== undefined) cleaned.test = candidates.test;
  if (candidates.run !== undefined) cleaned.run = candidates.run;
  return cleaned;
}
