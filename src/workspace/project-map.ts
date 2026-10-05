import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { ProjectProfile } from '../types/workspace.js';
import { resolveLimits } from '../config/config-schema.js';
import { SOURCE_LANGUAGES, walkWorkspace, type FileLanguage, type WalkedFile } from './file-walker.js';

/**
 * Project map (docs/ROADMAP.md Phase 2, docs/TOOLS.md `get_project_map`).
 *
 * The map is what an agent needs instead of a file tree: which files are entrypoints, what
 * each module declares, and who depends on whom. Everything here is rule-based and
 * deterministic — never an LLM (docs/ARCHITECTURE.md §4.8).
 *
 * Engine honesty: V1 extracts imports and top-level symbols with hand-written regexes
 * (`engine: 'heuristic-regex'`). Phase 3 replaces it with a real AST-based symbol index;
 * until then the map is a *navigation aid*, not a compiler-grade call graph, and every
 * response says so in `notes`.
 */

export type ModuleRole = 'entrypoint' | 'source' | 'test';

export interface MapModule {
  /** workspace-relative POSIX path */
  path: string;
  role: ModuleRole;
  /** notable top-level declarations (class/function/const names) */
  symbols: string[];
  /** workspace-relative paths this module imports */
  dependsOn: string[];
  /** workspace-relative paths importing this module */
  usedBy: string[];
  /** raw import specifiers, including ones that resolve outside the workspace */
  imports: string[];
  lines: number;
  bytes: number;
  language: FileLanguage;
}

export interface MapEntrypoint {
  path: string;
  imports: number;
  summary: string;
}

export interface ProjectMap {
  entrypoints: MapEntrypoint[];
  modules: MapModule[];
  layers?: string[];
  notes: string[];
  engine: 'heuristic-regex';
  truncated: boolean;
}

export interface BuildMapOptions {
  root: string;
  profile: ProjectProfile;
  config?: DevPilotConfig;
  /** Graph hops explored around `focus` (default 3). */
  depth?: number;
  /** Module (file or directory) to centre the map on. */
  focus?: string;
  includeTests?: boolean;
  maxModules?: number;
  maxTotalBytes?: number;
  logger?: Logger;
}

export interface ParsedFile {
  imports: string[];
  symbols: string[];
  annotations: string[];
  lines: number;
}

/* ------------------------------------------------------------------ parsing */

const PY_IMPORT = /^\s*import\s+([^\n#]+)/;
const PY_FROM = /^\s*from\s+([.\w]+)\s+import\s+/;
const PY_CLASS = /^class\s+(\w+)/;
const PY_DEF = /^(\s*)def\s+(\w+)/;

export function parsePython(text: string): ParsedFile {
  const imports: string[] = [];
  const symbols: string[] = [];
  let currentClass: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    const from = PY_FROM.exec(line);
    if (from?.[1] !== undefined) {
      imports.push(from[1]);
      continue;
    }
    const plain = PY_IMPORT.exec(line);
    if (plain?.[1] !== undefined) {
      for (const part of plain[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/)[0]?.trim();
        if (name !== undefined && name !== '') imports.push(name);
      }
      continue;
    }

    const cls = PY_CLASS.exec(line);
    if (cls?.[1] !== undefined) {
      currentClass = cls[1];
      symbols.push(cls[1]);
      continue;
    }
    const def = PY_DEF.exec(line);
    if (def?.[2] !== undefined) {
      const indent = def[1] ?? '';
      if (indent === '') {
        currentClass = undefined;
        symbols.push(def[2]);
      } else if (currentClass !== undefined) {
        symbols.push(`${currentClass}.${def[2]}`);
      }
    }
  }

  return { imports, symbols: dedupe(symbols), annotations: [], lines: countLines(text) };
}

const JAVA_PACKAGE = /^\s*package\s+([\w.]+)\s*;/;
const JAVA_IMPORT = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/;
const JAVA_TYPE = /\b(?:class|interface|enum|record)\s+(\w+)/;
const JAVA_ANNOTATION = /^\s*@(\w+)/;
const JAVA_METHOD = /^\s*(?:public|protected|private)\s+(?:static\s+)?(?:final\s+)?[\w<>\[\],.\s]+\s+(\w+)\s*\(/;

export interface JavaParseResult extends ParsedFile {
  packageName?: string;
  typeName?: string;
}

export function parseJava(text: string): JavaParseResult {
  const imports: string[] = [];
  const symbols: string[] = [];
  const annotations: string[] = [];
  let packageName: string | undefined;
  let typeName: string | undefined;

  for (const line of text.split(/\r?\n/)) {
    const pkg = JAVA_PACKAGE.exec(line);
    if (pkg?.[1] !== undefined && packageName === undefined) {
      packageName = pkg[1];
      continue;
    }
    const imp = JAVA_IMPORT.exec(line);
    if (imp?.[1] !== undefined) {
      imports.push(imp[1]);
      continue;
    }
    const annotation = JAVA_ANNOTATION.exec(line);
    if (annotation?.[1] !== undefined) annotations.push(annotation[1]);

    const type = JAVA_TYPE.exec(line);
    if (type?.[1] !== undefined && typeName === undefined) {
      typeName = type[1];
      symbols.push(type[1]);
      continue;
    }
    const method = JAVA_METHOD.exec(line);
    if (method?.[1] !== undefined && method[1] !== 'if' && method[1] !== 'for' && method[1] !== 'while') {
      symbols.push(method[1]);
    }
  }

  const result: JavaParseResult = {
    imports,
    symbols: dedupe(symbols),
    annotations: dedupe(annotations),
    lines: countLines(text),
  };
  if (packageName !== undefined) result.packageName = packageName;
  if (typeName !== undefined) result.typeName = typeName;
  return result;
}

const JS_FROM = /(?:^|\s)(?:import|export)[^'"\n]*?from\s*['"]([^'"]+)['"]/;
const JS_BARE_IMPORT = /^\s*import\s*['"]([^'"]+)['"]/;
const JS_REQUIRE = /\brequire\(\s*['"]([^'"]+)['"]\s*\)/;
const JS_DYNAMIC = /\bimport\(\s*['"]([^'"]+)['"]\s*\)/;
const JS_SYMBOLS: readonly RegExp[] = [
  /^\s*export\s+(?:default\s+)?(?:async\s+)?function\s+(\w+)/,
  /^\s*export\s+(?:abstract\s+)?class\s+(\w+)/,
  /^\s*export\s+interface\s+(\w+)/,
  /^\s*export\s+type\s+(\w+)/,
  /^\s*export\s+enum\s+(\w+)/,
  /^\s*export\s+(?:const|let|var)\s+(\w+)/,
  /^\s*(?:async\s+)?function\s+(\w+)/,
  /^\s*(?:abstract\s+)?class\s+(\w+)/,
  /^\s*interface\s+(\w+)/,
];

export function parseJavaScript(text: string): ParsedFile {
  const imports: string[] = [];
  const symbols: string[] = [];

  for (const line of text.split(/\r?\n/)) {
    const from = JS_FROM.exec(line);
    if (from?.[1] !== undefined) imports.push(from[1]);
    const bare = JS_BARE_IMPORT.exec(line);
    if (bare?.[1] !== undefined) imports.push(bare[1]);
    for (const match of line.matchAll(new RegExp(JS_REQUIRE.source, 'g'))) {
      if (match[1] !== undefined) imports.push(match[1]);
    }
    for (const match of line.matchAll(new RegExp(JS_DYNAMIC.source, 'g'))) {
      if (match[1] !== undefined) imports.push(match[1]);
    }
    for (const pattern of JS_SYMBOLS) {
      const symbol = pattern.exec(line);
      if (symbol?.[1] !== undefined) {
        symbols.push(symbol[1]);
        break;
      }
    }
  }

  return { imports: dedupe(imports), symbols: dedupe(symbols), annotations: [], lines: countLines(text) };
}

export function parseSource(language: FileLanguage, text: string): ParsedFile {
  switch (language) {
    case 'python':
      return parsePython(text);
    case 'java':
    case 'kotlin':
      return parseJava(text);
    case 'typescript':
    case 'javascript':
      return parseJavaScript(text);
    default:
      return { imports: [], symbols: [], annotations: [], lines: countLines(text) };
  }
}

function countLines(text: string): number {
  if (text === '') return 0;
  return text.split(/\r?\n/).length;
}

function dedupe(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value !== ''))];
}

/* -------------------------------------------------------------- resolution */

function pythonCandidates(specifier: string, fromPath: string): string[] {
  const fromDir = path.posix.dirname(fromPath);
  if (specifier.startsWith('.')) {
    const dots = /^\.+/.exec(specifier)?.[0].length ?? 1;
    const rest = specifier.slice(dots).replace(/\./g, '/');
    const base = dots === 1 ? fromDir : path.posix.join(fromDir, ...Array(dots - 1).fill('..'));
    const target = rest === '' ? base : path.posix.join(base, rest);
    return [target === '.' ? '' : target];
  }
  return [specifier.replace(/\./g, '/')];
}

function expandCandidates(base: string): string[] {
  if (base === '') return [];
  const out = [base];
  if (!path.posix.extname(base)) {
    out.push(`${base}.py`, `${base}/__init__.py`, `${base}.pyi`);
  } else {
    out.push(`${base}/__init__.py`);
  }
  return out;
}

const JS_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const JS_INDEX = JS_EXTENSIONS.map((ext) => `/index${ext}`);

function resolveRelativeJs(specifier: string, fromPath: string): string[] {
  const base = path.posix.normalize(path.posix.join(path.posix.dirname(fromPath), specifier));
  const candidates = [base, ...JS_EXTENSIONS.map((ext) => `${base}${ext}`), ...JS_INDEX.map((suffix) => `${base}${suffix}`)];
  // `./x.js` may point at `x.ts` in a TS project.
  const ext = path.posix.extname(base);
  if (ext !== '') {
    const stem = base.slice(0, -ext.length);
    candidates.push(...JS_EXTENSIONS.map((candidate) => `${stem}${candidate}`));
  }
  return candidates;
}

/* ---------------------------------------------------------------- the map */

interface LayerRule {
  layer: string;
  namePattern: RegExp;
  annotations: readonly string[];
}

const LAYER_RULES: readonly LayerRule[] = [
  { layer: 'Controller', namePattern: /Controller$/, annotations: ['RestController', 'Controller'] },
  { layer: 'Service', namePattern: /(Service|Manager|UseCase)$/, annotations: ['Service'] },
  { layer: 'Repository', namePattern: /(Repository|Dao|Mapper)$/, annotations: ['Repository'] },
  { layer: 'Entity', namePattern: /(Entity|Model)$/, annotations: ['Entity', 'Document', 'Table'] },
  { layer: 'DTO', namePattern: /(Dto|DTO|Request|Response|Vo|VO|Payload)$/, annotations: [] },
  { layer: 'Config', namePattern: /Config(uration)?$/, annotations: ['Configuration', 'Bean'] },
];

/**
 * Java/Kotlin only: a TypeScript file that happens to export `UserService` is not a Spring
 * service, and claiming a layer that no annotation or convention backs would be a lie.
 */
function detectLayers(parsed: Map<string, ParsedFile>, languageByPath: Map<string, FileLanguage>): string[] {
  const present = new Set<string>();
  for (const [filePath, result] of parsed) {
    const language = languageByPath.get(filePath);
    if (language !== 'java' && language !== 'kotlin') continue;
    const typeName = result.symbols[0];
    const annotations = result.annotations;
    for (const rule of LAYER_RULES) {
      const byName = typeName !== undefined && rule.namePattern.test(typeName);
      const byAnnotation = annotations.some((annotation) => rule.annotations.includes(annotation));
      if (byName || byAnnotation) present.add(rule.layer);
    }
  }
  const ordered = LAYER_RULES.map((rule) => rule.layer).filter((layer) => present.has(layer));
  if (ordered.includes('Repository')) ordered.push('Database');
  return ordered;
}

function isTestPath(profile: ProjectProfile, relativePath: string): boolean {
  const inTestDir = profile.testDirs.some(
    (dir) => relativePath === dir || relativePath.startsWith(`${dir}/`),
  );
  if (inTestDir) return true;
  return /(^|\/)(test_|tests?\/|.*\.(test|spec)\.[a-z]+$)/i.test(relativePath);
}

function summarizeEntrypoint(module: MapModule): string {
  const symbolText = module.symbols.slice(0, 6).join(', ');
  return [
    `${module.lines} lines`,
    module.imports.length === 1 ? '1 import' : `${module.imports.length} imports`,
    module.symbols.length === 0 ? 'no top-level symbols' : `defines ${symbolText}${module.symbols.length > 6 ? ', …' : ''}`,
  ].join('; ');
}

/**
 * Build the project map. Always walks (the map needs file contents), so it is deliberately
 * separate from the cache-aware `scan_project`.
 */
export async function buildProjectMap(options: BuildMapOptions): Promise<ProjectMap> {
  const started = Date.now();
  const root = path.resolve(options.root);
  const notes: string[] = [];
  const limits = options.config === undefined ? undefined : resolveLimits(options.config);
  const maxModules = options.maxModules ?? 200;
  const maxTotalBytes = options.maxTotalBytes ?? 32 * 1024 * 1024;

  const walk = await walkWorkspace({
    root,
    exclude: options.config?.workspace.exclude,
    maxFiles: limits?.maxFilesIndexed ?? 20_000,
    maxDepth: limits?.walkMaxDepth ?? 32,
    maxFileSizeBytes: limits?.maxFileSizeBytes ?? 2_097_152,
  });

  const generatedSkipped = walk.files.filter(
    (file) => file.generated === true && SOURCE_LANGUAGES.includes(file.language),
  );
  const sourceFiles = walk.files.filter(
    (file) => SOURCE_LANGUAGES.includes(file.language) && file.generated !== true,
  );
  const testFiltered = sourceFiles.filter(
    (file) => options.includeTests === true || !isTestPath(options.profile, file.path),
  );

  const selected: WalkedFile[] = [];
  let readBytes = 0;
  let truncated = false;
  for (const file of testFiltered) {
    if (selected.length >= maxModules || readBytes + file.size > maxTotalBytes) {
      truncated = true;
      break;
    }
    selected.push(file);
    readBytes += file.size;
  }

  const parsed = new Map<string, ParsedFile>();
  const languageByPath = new Map<string, FileLanguage>();
  const javaFqcn = new Map<string, string>();
  for (const file of selected) {
    let text: string;
    try {
      text = await fs.readFile(file.absolute, 'utf8');
    } catch {
      notes.push(`could not read ${file.path}`);
      continue;
    }
    const result =
      file.language === 'java' ? (parseJava(text) as ParsedFile) : parseSource(file.language, text);
    parsed.set(file.path, result);
    languageByPath.set(file.path, file.language);
    if (file.language === 'java') {
      const java = result as JavaParseResult;
      if (java.packageName !== undefined && java.typeName !== undefined) {
        javaFqcn.set(`${java.packageName}.${java.typeName}`, file.path);
      }
    }
  }

  const known = new Set(parsed.keys());
  const modules = new Map<string, MapModule>();
  let unresolved = 0;

  for (const file of selected) {
    const result = parsed.get(file.path);
    if (result === undefined) continue;

    const dependsOn = new Set<string>();
    for (const specifier of result.imports) {
      let match: string | undefined;
      if (file.language === 'python') {
        match = pythonCandidates(specifier, file.path)
          .flatMap(expandCandidates)
          .find((candidate) => known.has(candidate));
      } else if (file.language === 'typescript' || file.language === 'javascript') {
        if (specifier.startsWith('.')) {
          match = resolveRelativeJs(specifier, file.path).find((candidate) => known.has(candidate));
        }
      } else if (file.language === 'java' || file.language === 'kotlin') {
        match = javaFqcn.get(specifier.replace(/\.\*$/, ''));
      }
      if (match !== undefined && match !== file.path) dependsOn.add(match);
      else if (match === undefined) unresolved += 1;
    }

    const role: ModuleRole =
      options.profile.entrypoints.includes(file.path)
        ? 'entrypoint'
        : isTestPath(options.profile, file.path)
          ? 'test'
          : 'source';

    modules.set(file.path, {
      path: file.path,
      role,
      symbols: result.symbols,
      dependsOn: [...dependsOn].sort(),
      usedBy: [],
      imports: dedupe(result.imports),
      lines: result.lines,
      bytes: file.size,
      language: file.language,
    });
  }

  for (const module of modules.values()) {
    for (const dependency of module.dependsOn) {
      modules.get(dependency)?.usedBy.push(module.path);
    }
  }
  for (const module of modules.values()) module.usedBy.sort();

  let listed = [...modules.values()];
  const focus = options.focus?.replace(/\\/g, '/');
  if (focus !== undefined && focus !== '') {
    const hops = Math.max(1, options.depth ?? 3);
    const seeds = listed.filter(
      (module) => module.path === focus || module.path.startsWith(`${focus.replace(/\/+$/, '')}/`) || module.path.includes(focus),
    );
    if (seeds.length === 0) {
      notes.push(`focus "${focus}" matched no module; the whole map is returned`);
    } else {
      const keep = new Set(seeds.map((module) => module.path));
      let frontier = [...keep];
      for (let hop = 0; hop < hops; hop += 1) {
        const next: string[] = [];
        for (const current of frontier) {
          const module = modules.get(current);
          if (module === undefined) continue;
          for (const neighbour of [...module.dependsOn, ...module.usedBy]) {
            if (!keep.has(neighbour)) {
              keep.add(neighbour);
              next.push(neighbour);
            }
          }
        }
        frontier = next;
        if (frontier.length === 0) break;
      }
      listed = listed.filter((module) => keep.has(module.path));
      notes.push(`focused on "${focus}" with depth ${hops}: ${listed.length} module(s) in the neighbourhood`);
    }
  }

  listed.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  let entrypointPaths = options.profile.entrypoints.filter((entry) => modules.has(entry));
  if (entrypointPaths.length === 0) {
    const roots = listed
      .filter((module) => module.usedBy.length === 0 && module.role !== 'test')
      .slice(0, 5)
      .map((module) => module.path);
    if (roots.length > 0) {
      entrypointPaths = roots;
      notes.push('no known entrypoint name matched; graph roots (nothing imports them) are reported instead');
    }
  }

  const entrypoints: MapEntrypoint[] = entrypointPaths.map((entry) => {
    const module = modules.get(entry)!;
    return { path: entry, imports: module.imports.length, summary: summarizeEntrypoint(module) };
  });

  if (truncated) {
    notes.push(`module cap reached (maxModules = ${maxModules}, read budget ${maxTotalBytes} bytes)`);
  }
  if (walk.truncated) notes.push('the file walk hit workspace.max_files; the map is partial');
  if (unresolved > 0) {
    notes.push(`${unresolved} import(s) resolve outside the workspace (standard library or third-party)`);
  }
  if (generatedSkipped.length > 0) {
    notes.push(
      `${generatedSkipped.length} generated/minified asset file(s) are not mapped as modules (e.g. ${generatedSkipped
        .slice(0, 3)
        .map((file) => file.path)
        .join(', ')})`,
    );
  }
  if (options.includeTests !== true) notes.push('test files are hidden; pass includeTests: true to map them');

  const layers = detectLayers(parsed, languageByPath);
  const map: ProjectMap = {
    entrypoints,
    modules: listed,
    notes: [
      'engine: heuristic-regex — imports and symbols come from hand-written regexes, not a compiler; find_symbol over the Phase 3 index is the precise view, this map stays a navigation aid',
      'config and documentation files are not listed as modules',
      ...notes,
    ],
    engine: 'heuristic-regex',
    truncated,
  };
  if (layers.length > 0) map.layers = layers;

  options.logger?.debug('project map built', {
    root,
    modules: listed.length,
    entrypoints: entrypoints.length,
    durationMs: Date.now() - started,
  });
  return map;
}
