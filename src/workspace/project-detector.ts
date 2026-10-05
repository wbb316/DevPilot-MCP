import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import { DEFAULT_EXCLUDES } from '../config/config-schema.js';
import type { ProjectProfile } from '../types/workspace.js';
import { isGeneratedAssetName } from './file-walker.js';

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

/**
 * Entry-point shaped file names, most likely first. Real projects keep their entry point
 * inside a package (`src/catalog/cli.py`), which the fixed candidate list above cannot see —
 * the Phase 10 real-project run found such a project with an empty `candidates.run`.
 */
const ENTRYPOINT_NAMES: readonly string[] = [
  'main.py',
  'cli.py',
  '__main__.py',
  'app.py',
  'run.py',
  'server.py',
  'manage.py',
  'train.py',
  'sample.py',
  'index.ts',
  'index.js',
  'main.ts',
  'main.js',
  'server.ts',
  'server.js',
  'app.ts',
  'app.js',
];

const MAX_DISCOVERED_ENTRYPOINTS = 8;

/**
 * Directories that hold examples, throwaways or web assets — never the project's entry point.
 * The Phase 10 real-project run picked `scratch/main.py` (an MNIST toy) over the real training
 * script and pulled `app/static/js/app.js` into the entrypoint list; both live here.
 */
const NON_ENTRY_DIRS: ReadonlySet<string> = new Set([
  'scratch',
  'tmp',
  'temp',
  'sandbox',
  'playground',
  'examples',
  'example',
  'demo',
  'demos',
  'static',
  'public',
  'assets',
  'vendor',
  'vendors',
  'third_party',
  'thirdparty',
  'bower_components',
  'docs',
  'doc',
  'notebooks',
]);

/** Names a framework makes primary — PyTorch's entry is the training script, not a web server. */
const FRAMEWORK_ENTRYPOINTS: Record<string, readonly string[]> = {
  PyTorch: ['train.py', 'pretrain.py', 'finetune.py', 'sample.py', 'generate.py', 'evaluate.py', 'main.py'],
  FastAPI: ['main.py', 'app.py', 'server.py'],
  Flask: ['app.py', 'main.py', 'server.py'],
  Django: ['manage.py'],
  'Next.js': ['index.ts', 'index.js', 'main.ts', 'main.js'],
};

const PY_MAIN_GUARD = /^\s*if\s+__name__\s*==\s*['"]__main__['"]/m;
const JS_MAIN_GUARD = /require\.main\s*===\s*module|import\.meta\.main/;
/** Only this many candidates get their contents read; the read itself is size-capped. */
const ENTRY_PROBE_LIMIT = 12;
const ENTRY_READ_LIMIT_BYTES = 2 * 1024 * 1024;

function isTestPath(relative: string): boolean {
  if (/(^|\/)(tests?|spec|specs|__tests__)\//.test(relative)) return true;
  return /[._](test|spec)\.(py|ts|tsx|js|jsx|mjs|cjs)$/.test(relative);
}

function isNonEntryPath(relative: string): boolean {
  const segments = relative.split('/');
  for (let index = 0; index < segments.length - 1; index += 1) {
    const segment = segments[index];
    if (segment !== undefined && NON_ENTRY_DIRS.has(segment.toLowerCase())) return true;
  }
  return false;
}

/** Framework-preferred names sort before the generic list (which keeps its frozen order). */
function rankOf(base: string, framework: string | undefined): number {
  const preferred = framework === undefined ? undefined : FRAMEWORK_ENTRYPOINTS[framework];
  const preferredRank = preferred?.indexOf(base) ?? -1;
  if (preferredRank >= 0) return preferredRank;
  const rank = ENTRYPOINT_NAMES.indexOf(base);
  return rank === -1 ? -1 : 100 + rank;
}

async function readEntryText(root: string, relative: string): Promise<string | undefined> {
  const absolute = path.join(root, ...relative.split('/'));
  try {
    const stats = await fs.stat(absolute);
    if (stats.size > ENTRY_READ_LIMIT_BYTES) return undefined;
    return await fs.readFile(absolute, 'utf8');
  } catch {
    return undefined;
  }
}

export interface EntryDetail {
  path: string;
  /** The file runs something when executed (`if __name__ == "__main__"`, `require.main`). */
  mainGuard: boolean;
  /** Top-level modules this entry imports that exist at the workspace root. */
  rootImports: string[];
}

/**
 * Bounded inspection of the leading entry candidates: a file that executes under a main guard
 * is a real entry, and an entry outside a package that imports root-level modules needs the
 * root on `PYTHONPATH`.
 */
async function inspectEntrypoints(
  root: string,
  entrypoints: readonly string[],
  files: readonly string[],
): Promise<EntryDetail[]> {
  const details: EntryDetail[] = [];
  for (const entry of entrypoints) {
    const text = await readEntryText(root, entry);
    if (text === undefined) continue;
    const rootImports: string[] = [];
    for (const line of text.split(/\r?\n/)) {
      const match = /^\s*(?:from|import)\s+([A-Za-z_][A-Za-z0-9_]*)/.exec(line);
      const name = match?.[1];
      if (name === undefined) continue;
      if (!files.includes(`${name}.py`) && !files.includes(`${name}/__init__.py`)) continue;
      if (!rootImports.includes(name)) rootImports.push(name);
    }
    details.push({
      path: entry,
      mainGuard: PY_MAIN_GUARD.test(text) || JS_MAIN_GUARD.test(text),
      rootImports,
    });
  }
  return details;
}

interface EntryCandidate {
  path: string;
  rank: number;
  depth: number;
  mainGuard: boolean;
}

/** Entry points discovered anywhere under the source tree, not only at the hard-coded paths. */
async function discoverEntrypoints(
  root: string,
  files: readonly string[],
  already: readonly string[],
  framework: string | undefined,
): Promise<string[]> {
  const seen = new Set(already);
  const candidates: EntryCandidate[] = [];
  for (const file of files) {
    if (seen.has(file) || isTestPath(file) || isNonEntryPath(file)) continue;
    if (isGeneratedAssetName(file)) continue;
    const base = file.split('/').pop() ?? '';
    const rank = rankOf(base, framework);
    if (rank === -1) continue;
    candidates.push({ path: file, rank, depth: file.split('/').length, mainGuard: false });
  }
  candidates.sort(
    (a, b) =>
      a.rank - b.rank || a.depth - b.depth || a.path.length - b.path.length || a.path.localeCompare(b.path),
  );

  const probed = candidates.slice(0, ENTRY_PROBE_LIMIT);
  for (const candidate of probed) {
    const text = await readEntryText(root, candidate.path);
    if (text === undefined) continue;
    candidate.mainGuard = PY_MAIN_GUARD.test(text) || JS_MAIN_GUARD.test(text);
  }
  probed.sort(
    (a, b) =>
      Number(b.mainGuard) - Number(a.mainGuard) ||
      a.rank - b.rank ||
      a.depth - b.depth ||
      a.path.length - b.path.length ||
      a.path.localeCompare(b.path),
  );
  return probed.slice(0, MAX_DISCOVERED_ENTRYPOINTS).map((entry) => entry.path);
}

/** Directories whose contents are data, output, docs or vendored code — never "source". */
const NON_SOURCE_DIRS: ReadonlySet<string> = new Set([
  'tests',
  'test',
  'spec',
  'specs',
  '__tests__',
  'docs',
  'doc',
  'notebooks',
  'data',
  'data1',
  'dataset',
  'datasets',
  'result',
  'results',
  'log',
  'logs',
  'checkpoints',
  'scratch',
  'tmp',
  'temp',
  'examples',
  'demo',
  'demos',
  'review_bundle',
  'build',
  'dist',
  'out',
  'target',
  'coverage',
  'node_modules',
  '__pycache__',
  '.venv',
  'venv',
  '.idea',
]);

const SOURCE_EXT =
  /\.(?:py|pyi|java|kt|kts|ts|tsx|mts|cts|js|jsx|mjs|cjs|c|cc|cpp|cxx|h|hpp|go|rs|cs|rb|php)$/i;

/**
 * Top-level source directories, counted rather than hard-coded. `SOURCE_DIR_CANDIDATES` only
 * knows `src`/`app`/`lib`, so a project laid out as `model/` + `train/` reported a single
 * source directory (the real-project run).
 */
function discoverSourceDirs(files: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const file of files) {
    if (!SOURCE_EXT.test(file) || isGeneratedAssetName(file)) continue;
    const segments = file.split('/');
    if (segments.length < 2) continue;
    const top = segments[0];
    if (top === undefined || top.startsWith('.')) continue;
    if (NON_SOURCE_DIRS.has(top.toLowerCase())) continue;
    counts.set(top, (counts.get(top) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] === a[1] ? (a[0] < b[0] ? -1 : 1) : b[1] - a[1]))
    .slice(0, 8)
    .map(([dir]) => dir);
}


/**
 * How to run a Python file. A file inside a package can only be started as `python -m pkg.mod`
 * (a relative import inside it breaks `python path/to/file.py` — measured on the demo project),
 * and the directory above the outermost package must be on `PYTHONPATH`.
 */
function pythonRunTarget(
  relative: string,
  files: readonly string[],
): { target: string; pythonPath?: string } {
  const segments = relative.split('/');
  const file = segments.pop() ?? relative;
  const moduleName = file.replace(/\.py$/, '');
  const parts: string[] = [];
  let current = segments.join('/');
  while (current !== '' && files.includes(`${current}/__init__.py`)) {
    const lastSlash = current.lastIndexOf('/');
    parts.unshift(lastSlash === -1 ? current : current.slice(lastSlash + 1));
    current = lastSlash === -1 ? '' : current.slice(0, lastSlash);
  }
  if (parts.length === 0) return { target: relative };
  const modulePath = moduleName === '__main__' ? parts.join('.') : [...parts, moduleName].join('.');
  return current === '' ? { target: `-m ${modulePath}` } : { target: `-m ${modulePath}`, pythonPath: current };
}

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

  const rootEntrypoints = await existingRelative(root, ENTRYPOINT_CANDIDATES);
  const entrypoints = [
    ...rootEntrypoints,
    ...(await discoverEntrypoints(root, files, rootEntrypoints, framework ?? projectType)),
  ];
  const entryDetails = await inspectEntrypoints(root, entrypoints.slice(0, 3), files);
  const fixedSourceDirs = await existingRelative(root, SOURCE_DIR_CANDIDATES);
  const sourceDirs = [
    ...fixedSourceDirs,
    ...discoverSourceDirs(files).filter((dir) => !fixedSourceDirs.includes(dir)),
  ];
  const testDirs = await existingRelative(root, TEST_DIR_CANDIDATES);
  const configDirs = await existingRelative(root, CONFIG_DIR_CANDIDATES);

  const candidates = inferCommands({
    buildSystem,
    framework,
    entrypoints,
    entryDetails,
    files,
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
  /** Bounded inspection of the leading entries (main guard + root-level imports). */
  entryDetails?: readonly EntryDetail[];
  files: readonly string[];
  testFramework: string;
  scripts: Record<string, string>;
  config?: DevPilotConfig;
}

/** Deterministic command inference, overridable through .devpilot/config.yml. */
function inferCommands(inputs: CommandInputs): {
  build?: string;
  test?: string;
  run?: string;
  runEnv?: Record<string, string>;
} {
  const candidates: {
    build?: string;
    test?: string;
    run?: string;
    runEnv?: Record<string, string>;
  } = {};

  switch (inputs.buildSystem) {
    case 'maven':
      // `-B` (batch) instead of `-q` on every Maven candidate: quiet mode hides the
      // `Tests run:`/startup lines DevPilot parses, which is how a green suite ended up
      // advertised as "0 tests" (Phase 10 acceptance).
      candidates.build = 'mvn -B -DskipTests package';
      candidates.test = 'mvn -B test';
      if (inputs.framework === 'Spring Boot') candidates.run = 'mvn -B spring-boot:run';
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
      else if (inputs.entrypoints[0] !== undefined) candidates.run = `node ${inputs.entrypoints[0]}`;
      break;
    }
    case 'pip':
    case 'poetry': {
      const prefix = inputs.buildSystem === 'poetry' ? 'poetry run ' : '';
      candidates.test = `${prefix}python -m pytest -q`;
      const entry = inputs.entrypoints[0];
      if (entry !== undefined) {
        const target = pythonRunTarget(entry, inputs.files);
        candidates.run = `${prefix}python ${target.target}`;
        if (target.pythonPath !== undefined) {
          candidates.runEnv = { PYTHONPATH: target.pythonPath };
        } else if (entry.includes('/')) {
          // Outside a package Python puts the *script's* directory on sys.path, so an entry
          // like `train/train.py` cannot import `model/...` unless the root is on PYTHONPATH.
          // Claimed only when the entry really imports a root-level module.
          const detail = inputs.entryDetails?.find((candidate) => candidate.path === entry);
          if (detail !== undefined && detail.rootImports.length > 0) {
            candidates.runEnv = { PYTHONPATH: '.' };
          }
        }
      }
      break;
    }
    default:
      break;
  }

  const project = inputs.config?.project;
  if (project?.build_command) candidates.build = project.build_command;
  if (project?.test_command) candidates.test = project.test_command;
  if (project?.run_command) candidates.run = project.run_command;

  const cleaned: {
    build?: string;
    test?: string;
    run?: string;
    runEnv?: Record<string, string>;
  } = {};
  if (candidates.build !== undefined) cleaned.build = candidates.build;
  if (candidates.test !== undefined) cleaned.test = candidates.test;
  if (candidates.run !== undefined) cleaned.run = candidates.run;
  if (candidates.runEnv !== undefined) cleaned.runEnv = candidates.runEnv;
  return cleaned;
}
