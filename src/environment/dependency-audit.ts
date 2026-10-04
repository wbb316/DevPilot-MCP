import { promises as fs } from 'node:fs';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import type { Logger } from '../log/logger.js';
import type {
  DependencyAuditOptions,
  DependencyAuditResult,
  DependencyEcosystem,
  DependencyRecord,
  DependencyScope,
  DependencySpecKind,
  EcosystemDependencyProfile,
  LockIssue,
} from '../types/dependency.js';
import { walkWorkspace } from '../workspace/file-walker.js';

/**
 * `dependency_audit` analysis — docs/TOOLS.md Phase 9. Pure: a workspace root, the config
 * excludes and an optional logger go in; the frozen `data` object comes out. No MCP types,
 * no network, and project code is never executed.
 *
 * Every number and every issue comes from bytes that were actually parsed. When an
 * ecosystem, a lockfile or the whole audit has nothing to say, a `notes` entry says why —
 * an empty result must never be mistaken for a clean bill of health.
 */

/** Read cap: this is a read-only audit, not a package manager. */
export const MAX_AUDIT_FILES = 50;
/** Per-file cap (5 MiB), matching the contract: a bigger lockfile is skipped, not truncated. */
export const MAX_AUDIT_FILE_BYTES = 5 * 1024 * 1024;

/**
 * Walker depth. The manifest depth is 1, but the walker counts *directory* levels: a
 * manifest in a depth-2 directory (the monorepo convention) only shows up when the walk
 * descends to depth 4, because the walker enqueues a directory's children in the same
 * pass that it returns the directory itself.
 */
const WALK_DEPTH = 4;

/** Files this tool knows how to read, by basename. */
const MANIFEST_NAMES = new Set([
  'package.json',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'requirements.txt',
  'requirements-dev.txt',
  'pyproject.toml',
  'Pipfile',
  'Pipfile.lock',
  'poetry.lock',
  'uv.lock',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'libs.versions.toml',
]);

/** Monorepo roots whose direct children are read (at most one level down). */
const MONOREPO_DIRS = ['packages', 'apps'];

/** A manifest belongs to a monorepo member only at exactly `<root>/<package>/<file>`. */
const MONOREPO_PREFIXES = MONOREPO_DIRS.map((dir) => `${dir}/`);

const NPM_SCOPE_BY_FIELD: Record<string, DependencyScope> = {
  dependencies: 'runtime',
  devDependencies: 'dev',
  peerDependencies: 'peer',
  optionalDependencies: 'optional',
  bundledDependencies: 'optional',
  bundleDependencies: 'optional',
};

const PY_LOCK_NAMES = ['poetry.lock', 'Pipfile.lock', 'uv.lock'];

/* ------------------------------------------------------------------ shared helpers */

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read a non-empty string field, or undefined. */
function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Strip `//` and block comments while leaving string literals intact. A commented-out
 * dependency is not a dependency, and all four of the non-JSON formats allow comments.
 */
function stripComments(text: string): string {
  let out = '';
  let quote: string | undefined;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i] ?? '';
    if (quote !== undefined) {
      out += ch;
      if (ch === '\\') {
        out += text[i + 1] ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = undefined;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Classify a semver-ish specifier. `unpinned` is exactly what docs/TOOLS.md asks to flag:
 * `*`, `latest`, an empty spec, or a `>` / `>=` bound with no upper limit.
 */
function classifySpec(spec: string): { kind: DependencySpecKind; requestedVersion?: string } {
  const trimmed = spec.trim();
  if (trimmed === '') return { kind: 'unpinned' };
  const lower = trimmed.toLowerCase();
  if (['*', 'x', 'any', 'latest', 'next', 'stable'].includes(lower)) return { kind: 'unpinned' };
  if (/^(file|link|portal|workspace|git|git\+|github|https?):/i.test(trimmed)) {
    if (lower.startsWith('npm:')) {
      // npm alias: `npm:other-pkg@^1.0.0` — the version is whatever follows the last '@'.
      const at = trimmed.lastIndexOf('@');
      return at > 4 ? classifySpec(trimmed.slice(at + 1)) : { kind: 'unpinned' };
    }
    return { kind: 'vcs' };
  }
  // A bare `>` or `>=` has no upper bound: nothing pins it.
  if (/^>/.test(trimmed)) return { kind: 'unpinned' };
  const ranged = /^([~^]=?)\s*(.+)$/.exec(trimmed);
  if (ranged !== null) return { kind: 'range', requestedVersion: (ranged[2] ?? '').trim() };
  const upper = /^<=?\s*(.+)$/.exec(trimmed);
  if (upper !== null) return { kind: 'range', requestedVersion: (upper[1] ?? '').trim() };
  if (/^[vV]?\d/.test(trimmed)) return { kind: 'exact', requestedVersion: trimmed };
  return { kind: 'range', requestedVersion: trimmed };
}

/** The single version a specifier pins, or '' when it allows more than one. */
function singleVersion(spec: string): string {
  const cls = classifySpec(spec);
  return cls.kind === 'exact' ? (cls.requestedVersion ?? '') : '';
}

function normaliseName(raw: string): string {
  return raw.trim().replace(/\s+/g, '');
}

/** `${a.b}` -> value, following nested references (bounded). '' means "does not resolve". */
function resolveProperty(value: string, properties: ReadonlyMap<string, string>): string {
  let current = value.trim();
  for (let i = 0; i < 5; i += 1) {
    const match = /\$\{([^}]+)\}/.exec(current);
    if (match === null) return current;
    const replacement = properties.get((match[1] ?? '').trim());
    if (replacement === undefined || replacement === '') return '';
    current = current.replace(match[0], replacement);
  }
  return '';
}

/* ------------------------------------------------------------------ read budget */

class ReadBudget {
  private readonly cache = new Map<string, string | undefined>();
  private reads = 0;
  private readonly skipped: string[] = [];

  constructor(
    private readonly root: string,
    private readonly maxFiles: number,
    private readonly maxBytes: number,
  ) {}

  get readCount(): number {
    return this.reads;
  }

  /** Relevant files that were not read (cap, size, unreadable), so `notes` can be honest. */
  get skippedFiles(): readonly string[] {
    return this.skipped;
  }

  /** Read once, cache the outcome. undefined means capped, oversized or unreadable. */
  async read(relativePath: string, missingNote?: string): Promise<string | undefined> {
    const key = relativePath.replace(/\\/g, '/');
    if (this.cache.has(key)) return this.cache.get(key);
    if (this.reads >= this.maxFiles) {
      this.cache.set(key, undefined);
      this.skipped.push(`${key} (file cap ${this.maxFiles})`);
      return undefined;
    }
    try {
      const stats = await fs.stat(path.join(this.root, key));
      if (stats.size > this.maxBytes) {
        this.cache.set(key, undefined);
        this.skipped.push(`${key} (${stats.size} bytes > ${this.maxBytes})`);
        return undefined;
      }
      const text = await fs.readFile(path.join(this.root, key), 'utf8');
      this.reads += 1;
      this.cache.set(key, text);
      return text;
    } catch {
      this.cache.set(key, undefined);
      if (missingNote !== undefined) this.skipped.push(`${key} (${missingNote})`);
      return undefined;
    }
  }
}

/* ------------------------------------------------------------------ npm */

interface LockIndex {
  /** every package name the lockfile mentions */
  names: Set<string>;
  /** name -> resolved versions, for duplicate detection */
  versions: Map<string, Set<string>>;
}

function emptyIndex(): LockIndex {
  return { names: new Set(), versions: new Map() };
}

function addResolved(index: LockIndex, name: string, version: string): void {
  if (name === '') return;
  index.names.add(name);
  if (version === '') return;
  const set = index.versions.get(name) ?? new Set<string>();
  set.add(version);
  index.versions.set(name, set);
}

/** package-lock v2/v3 `packages` map, plus the v1 nested `dependencies` tree. */
function readPackageLock(text: string): LockIndex {
  const index = emptyIndex();
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return index;
  }
  if (!isRecord(raw)) return index;

  const packages = raw['packages'];
  if (isRecord(packages)) {
    for (const [key, entry] of Object.entries(packages)) {
      if (!isRecord(entry)) continue;
      const version = asString(entry['version']) ?? '';
      const segments = key.split('node_modules/');
      const last = (segments[segments.length - 1] ?? '').replace(/\/+$/, '');
      if (key === '' || last === '') {
        // The root project or a workspace package: its declared deps are in the lock by
        // definition, so they count as present rather than as "declared but missing".
        for (const field of Object.keys(NPM_SCOPE_BY_FIELD)) {
          const deps = entry[field];
          if (!isRecord(deps)) continue;
          for (const name of Object.keys(deps)) index.names.add(name);
        }
        continue;
      }
      addResolved(index, last, version);
    }
  }

  const walkDeps = (deps: Record<string, unknown>): void => {
    for (const [name, entry] of Object.entries(deps)) {
      if (!isRecord(entry)) continue;
      addResolved(index, name, asString(entry['version']) ?? '');
      const nested = entry['dependencies'];
      if (isRecord(nested)) walkDeps(nested);
    }
  };
  const rootDeps = raw['dependencies'];
  if (isRecord(rootDeps)) walkDeps(rootDeps);
  return index;
}

/** pnpm: `importers.*.dependencies` are direct, `packages` keys are the resolved graph. */
function readPnpmLock(text: string): LockIndex {
  const index = emptyIndex();
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return index;
  }
  if (!isRecord(raw)) return index;

  const importers = raw['importers'];
  if (isRecord(importers)) {
    for (const entry of Object.values(importers)) {
      if (!isRecord(entry)) continue;
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies']) {
        const deps = entry[field];
        if (!isRecord(deps)) continue;
        for (const [name, value] of Object.entries(deps)) {
          index.names.add(name);
          const rawVersion = isRecord(value)
            ? (asString(value['version']) ?? '')
            : typeof value === 'string'
              ? value
              : '';
          if (rawVersion !== '') {
            const set = index.versions.get(name) ?? new Set<string>();
            set.add(rawVersion.startsWith('link:') ? rawVersion : (rawVersion.split('(')[0] ?? rawVersion));
            index.versions.set(name, set);
          }
        }
      }
    }
  }

  const packages = raw['packages'];
  if (isRecord(packages)) {
    for (const [key, entry] of Object.entries(packages)) {
      // Older keys are `/name/1.2.3`, newer ones `name@1.2.3`; peer hashes follow `(`.
      const cleaned = (key.replace(/^\//, '').split('(')[0] ?? '').trim();
      const at = cleaned.lastIndexOf('@');
      let name = cleaned;
      let version = '';
      if (at > 0) {
        name = cleaned.slice(0, at);
        version = cleaned.slice(at + 1);
      } else {
        const slash = cleaned.lastIndexOf('/');
        if (slash > 0) {
          name = cleaned.slice(0, slash);
          version = cleaned.slice(slash + 1);
        }
      }
      if (/^\d/.test(version)) addResolved(index, name, version);
      else index.names.add(name.replace(/\/+$/, ''));

      if (!isRecord(entry)) continue;
      const deps = entry['dependencies'];
      if (!isRecord(deps)) continue;
      for (const [depName, depValue] of Object.entries(deps)) {
        const depVersion =
          typeof depValue === 'string' ? (depValue.split('(')[0] ?? '').replace(/^\//, '') : '';
        addResolved(index, depName, /^\d/.test(depVersion) ? depVersion : '');
      }
    }
  }
  return index;
}

/**
 * yarn classic/berry. Only the specifier headers are read, for name presence: a berry
 * version is a nested YAML field and a classic one is an indented `version "x"` line, and
 * neither is reliable enough here to report counts from. The ecosystem note says so.
 */
function readYarnLock(text: string): LockIndex {
  const index = emptyIndex();
  for (const rawLine of text.split(/\r?\n/)) {
    if (rawLine.trim() === '' || /^\s/.test(rawLine)) continue;
    const line = rawLine.trim();
    const header = line.endsWith(':') ? line.slice(0, -1) : line;
    if (!header.includes('@')) continue;
    for (const part of header.split(',')) {
      const spec = part.trim().replace(/^"|"$/g, '');
      const at = spec.lastIndexOf('@');
      if (at <= 0) continue;
      const name = spec.slice(0, at);
      if (name === '' || name.includes(' ') || name.includes(':')) continue;
      index.names.add(name);
    }
  }
  return index;
}

function readPackageJson(text: string, source: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return records;
  }
  if (!isRecord(raw)) return records;
  for (const [field, scope] of Object.entries(NPM_SCOPE_BY_FIELD)) {
    const deps = raw[field];
    if (!isRecord(deps)) continue;
    for (const [name, value] of Object.entries(deps)) {
      const spec = typeof value === 'string' ? value : '';
      const cls = classifySpec(spec);
      records.push({
        name: normaliseName(name),
        spec,
        kind: cls.kind,
        scope,
        source,
        ...(cls.requestedVersion === undefined ? {} : { requestedVersion: cls.requestedVersion }),
      });
    }
  }
  return records;
}

/* ------------------------------------------------------------------ python */

/** Split `name[extra]>=1.0 ; marker` into a bare name and a specifier. */
function splitPySpecifier(raw: string): { name: string; spec: string } {
  let text = raw.trim();
  const marker = text.indexOf(';');
  if (marker >= 0) text = text.slice(0, marker).trim();
  const match = /^([A-Za-z0-9._-]+)\s*(?:\[[^\]]*\])?\s*(.*)$/.exec(text);
  if (match === null) return { name: '', spec: '' };
  const name = (match[1] ?? '').trim();
  let spec = (match[2] ?? '').trim();
  if (spec.startsWith('@')) spec = spec.slice(1).trim();
  return { name, spec };
}

/** `==1.2.3` is exact, `>=` never pins, `~=` is a lower-bound range, `*` is unpinned. */
function classifyPySpec(spec: string): { kind: DependencySpecKind; requestedVersion?: string } {
  const trimmed = spec.trim();
  if (trimmed === '' || trimmed === '*') return { kind: 'unpinned' };
  const exact = /^={1,3}\s*([^,]+)$/.exec(trimmed);
  if (exact !== null) return { kind: 'exact', requestedVersion: (exact[1] ?? '').trim() };
  const compatible = /^~\s*=?\s*(.+)$/.exec(trimmed);
  if (compatible !== null) return { kind: 'range', requestedVersion: (compatible[1] ?? '').trim() };
  if (/^[><!]=?/.test(trimmed)) return { kind: 'unpinned' };
  return { kind: 'range', requestedVersion: trimmed };
}

function parseRequirements(text: string, source: string, scope: DependencyScope = 'runtime'): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim();
    if (line === '' || line.startsWith('#') || line.startsWith('-')) continue;
    const { name, spec } = splitPySpecifier(line);
    if (name === '') continue;
    const cls = classifyPySpec(spec);
    records.push({
      name,
      spec,
      kind: cls.kind,
      scope,
      source,
      ...(cls.requestedVersion === undefined ? {} : { requestedVersion: cls.requestedVersion }),
    });
  }
  return records;
}

/** `-r other.txt` / `--requirement=other.txt` targets, followed exactly one level. */
function requirementIncludes(text: string): string[] {
  const out: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const match = /^(?:-r|--requirement)[=\s]+(.+)$/.exec(rawLine.trim());
    if (match === null) continue;
    const target = (match[1] ?? '').trim().replace(/\s+#.*$/, '').replace(/^["']|["']$/g, '');
    if (target !== '') out.push(target);
  }
  return out;
}

/**
 * Line-oriented TOML reader. No TOML parser ships with this project (the only runtime
 * dependencies are `yaml` and `zod`) and the files that matter here are flat tables, so a
 * full parser would be more code than it is worth. Stated limits: arrays are read one
 * element per line, inline tables keep their literal text (the poetry path re-reads
 * `version` from them), and `[[array-of-tables]]` entries are ignored.
 */
function parseToml(text: string): Map<string, string> {
  const values = new Map<string, string>();
  const lines = stripComments(text).split(/\r?\n/);
  let section = '';
  for (let i = 0; i < lines.length; i += 1) {
    const line = (lines[i] ?? '').trim();
    if (line === '') continue;
    const table = /^\[\[?\s*([^\]]+?)\s*\]?\]$/.exec(line);
    if (table !== null) {
      section = (table[1] ?? '').trim();
      continue;
    }
    const pair = /^([A-Za-z0-9_."'-]+)\s*=\s*(.*)$/.exec(line);
    if (pair === null) continue;
    const key = (pair[1] ?? '').replace(/^["']|["']$/g, '');
    let value = (pair[2] ?? '').trim();

    if (value.startsWith('[') && !value.endsWith(']')) {
      const parts: string[] = [];
      const first = value.slice(1).trim();
      if (first !== '') parts.push(first);
      while (i + 1 < lines.length) {
        i += 1;
        const next = (lines[i] ?? '').trim();
        if (next === '') continue;
        if (next === ']') break;
        parts.push(next);
        if (next.endsWith(']')) break;
      }
      value = `[${parts.join(', ').replace(/\]$/, '')}]`;
    }
    values.set(section === '' ? key : `${section}.${key}`, value);
  }
  return values;
}

function tomlScalar(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (/^".*"$/.test(trimmed) || /^'.*'$/.test(trimmed)) return trimmed.slice(1, -1);
  return trimmed;
}

function tomlArrayItems(value: string | undefined): string[] {
  if (value === undefined) return [];
  const trimmed = value.trim();
  if (!trimmed.startsWith('[')) return [];
  const inner = (trimmed.endsWith(']') ? trimmed.slice(1, -1) : trimmed.slice(1)).trim();
  if (inner === '') return [];
  return inner
    .split(',')
    .map((item) => item.trim().replace(/^["']|["']$/g, ''))
    .filter((item) => item !== '');
}

function pythonRecord(name: string, spec: string, scope: DependencyScope, source: string): DependencyRecord {
  const cls = classifyPySpec(spec);
  return {
    name,
    spec,
    kind: cls.kind,
    scope,
    source,
    ...(cls.requestedVersion === undefined ? {} : { requestedVersion: cls.requestedVersion }),
  };
}

function readPyproject(text: string, source: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  const toml = parseToml(text);

  const addPepSpecs = (entries: string[], scope: DependencyScope): void => {
    for (const entry of entries) {
      const { name, spec } = splitPySpecifier(entry);
      if (name === '') continue;
      records.push(pythonRecord(name, spec, scope, source));
    }
  };

  addPepSpecs(tomlArrayItems(toml.get('project.dependencies')), 'runtime');
  for (const [key, value] of toml) {
    if (key.startsWith('project.optional-dependencies.')) {
      addPepSpecs(tomlArrayItems(value), 'dev');
      continue;
    }
    const poetry = /^tool\.poetry\.(dev-)?dependencies\.([A-Za-z0-9._-]+)$/.exec(key);
    if (poetry === null) continue;
    const name = poetry[2] ?? '';
    if (name === '' || name === 'python') continue;
    const scope: DependencyScope = poetry[1] === 'dev-' ? 'dev' : 'runtime';
    const raw = value.trim();
    if (raw.startsWith('{')) {
      // Inline table: take the `version` field when there is one, otherwise it is a path/git dep.
      const version = /\bversion\s*=\s*["']([^"']+)["']/.exec(raw);
      if (version === null) continue;
      records.push(pythonRecord(name, version[1] ?? '', scope, source));
      continue;
    }
    records.push(pythonRecord(name, tomlScalar(raw) ?? '', scope, source));
  }
  return records;
}

/**
 * Pipfile is INI-shaped TOML, not YAML. It cannot be handed to `parseYaml`: Pipenv pins
 * with `flask = "==3.0.0"`, and `==` is not a YAML scalar, so the YAML reader throws
 * `Unexpected scalar at node end` and would swallow the whole file. A line reader never
 * loses a package to one awkward value.
 */
function readPipfile(text: string, source: string): DependencyRecord[] {
  const records: DependencyRecord[] = [];
  let section = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(line);
    if (table !== null) {
      section = (table[1] ?? '').trim();
      continue;
    }
    if (section !== 'packages' && section !== 'dev-packages') continue;
    const pair = /^["']?([A-Za-z0-9._-]+)["']?\s*=\s*(.+)$/.exec(line);
    if (pair === null) continue;
    const name = (pair[1] ?? '').trim();
    const value = (pair[2] ?? '').trim();
    if (name === '') continue;
    const scope: DependencyScope = section === 'dev-packages' ? 'dev' : 'runtime';
    let spec = value;
    if (value.startsWith('{')) {
      // Inline table: `requests = {version = "==2.31.0", extras = ["socks"]}`.
      const version = /\bversion\s*=\s*["']([^"']*)["']/.exec(value);
      if (version === null) continue; // a git/path dependency: no version to audit
      spec = version[1] ?? '';
    } else {
      spec = value.replace(/^["']|["']$/g, '').trim();
    }
    records.push(pythonRecord(name, spec, scope, source));
  }
  return records;
}

/** poetry.lock / uv.lock (TOML) and Pipfile.lock (JSON, which YAML also reads). */
function readPythonLock(text: string, flavour: 'poetry' | 'pipenv' | 'uv'): LockIndex {
  const index = emptyIndex();
  if (flavour === 'poetry' || flavour === 'uv') {
    // These two are TOML (`[[package]]` array-of-tables), not YAML. Feeding them to the YAML parser
    // threw, which left the lock index empty and silently reported zero transitives for projects
    // that do have a resolved graph — the worst possible failure for an audit tool.
    for (const entry of readTomlPackages(text)) {
      addResolved(index, entry.name.toLowerCase(), entry.version);
    }
    return index;
  }

  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch {
    return index;
  }
  if (!isRecord(raw)) return index;

  const add = (name: unknown, version: unknown): void => {
    const n = asString(name);
    if (n === undefined) return;
    addResolved(index, n.toLowerCase(), asString(version) ?? '');
  };

  for (const field of ['default', 'develop']) {
    const deps = raw[field];
    if (!isRecord(deps)) continue;
    for (const [name, entry] of Object.entries(deps)) {
      if (!isRecord(entry)) continue;
      add(name, entry['version']);
    }
  }
  return index;
}

/**
 * The `name` / `version` of every `[[package]]` table in a TOML lockfile. A narrow reader is enough
 * (and avoids a TOML dependency); it returns nothing when the file has no such tables, which the
 * caller reports rather than treating as "no dependencies".
 */
function readTomlPackages(text: string): { name: string; version: string }[] {
  const out: { name: string; version: string }[] = [];
  for (const chunk of text.split(/^[ \t]*\[\[package\]\][ \t]*$/m).slice(1)) {
    const block = chunk.split(/^[ \t]*\[\[/m)[0] ?? '';
    const name = /^[ \t]*name[ \t]*=[ \t]*"([^"]+)"/m.exec(block)?.[1];
    const version = /^[ \t]*version[ \t]*=[ \t]*"([^"]+)"/m.exec(block)?.[1];
    if (name !== undefined) out.push({ name, version: version ?? '' });
  }
  return out;
}

/* ------------------------------------------------------------------ maven */

interface PomInfo {
  path: string;
  version: string;
  /** `groupId:artifactId` -> version from this pom's own <dependencyManagement> */
  managedVersions: Map<string, string>;
  properties: Map<string, string>;
  modules: string[];
  /** comment-stripped source, kept so the second pass can parse dependencies lazily */
  source: string;
}

function xmlBlocks(xml: string, tag: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g');
  let match = re.exec(xml);
  while (match !== null) {
    out.push(match[1] ?? '');
    match = re.exec(xml);
  }
  return out;
}

/** The text of the first `<tag>` whose content holds no nested `<tag>`. */
function xmlValue(xml: string, tag: string): string | undefined {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([^<]*)</${tag}>`);
  const match = re.exec(xml);
  return match === null ? undefined : (match[1] ?? '').trim();
}

/** XML comments (`<!-- ... -->`). A commented-out dependency is not a dependency. */
function stripXmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '');
}

function readPom(text: string, source: string): PomInfo {
  const clean = stripXmlComments(text);
  const project = /<project(?:\s[^>]*)?>([\s\S]*)<\/project>/.exec(clean)?.[1] ?? clean;
  const withoutParent = project.replace(/<parent>[\s\S]*?<\/parent>/, '');
  const withoutBuild = withoutParent.replace(/<build>[\s\S]*?<\/build>/, '');

  const properties = new Map<string, string>();
  for (const block of xmlBlocks(project, 'properties')) {
    for (const entry of block.matchAll(/<([A-Za-z0-9_.-]+)\s*>([\s\S]*?)<\/\1>/g)) {
      const name = entry[1] ?? '';
      if (name !== '') properties.set(name, (entry[2] ?? '').trim());
    }
  }
  // Maven built-ins so `${project.version}` never reads as an unresolved property.
  const projectVersion = xmlValue(withoutBuild, 'version') ?? '';
  if (projectVersion !== '') properties.set('project.version', projectVersion);
  const parentVersion = xmlValue(xmlBlocks(project, 'parent')[0] ?? '', 'version') ?? '';
  if (parentVersion !== '') properties.set('project.parent.version', parentVersion);

  const managedVersions = new Map<string, string>();
  for (const managed of xmlBlocks(project, 'dependencyManagement')) {
    for (const block of xmlBlocks(managed, 'dependencies')) {
      for (const dep of xmlBlocks(block, 'dependency')) {
        const groupId = xmlValue(dep, 'groupId') ?? '';
        const artifactId = xmlValue(dep, 'artifactId') ?? '';
        const version = xmlValue(dep, 'version') ?? '';
        if (artifactId === '' || version === '') continue;
        managedVersions.set(`${groupId}:${artifactId}`, resolveProperty(version, properties) || version);
      }
    }
  }

  const modules: string[] = [];
  for (const block of xmlBlocks(project, 'modules')) {
    for (const module of xmlBlocks(block, 'module')) {
      const name = module.trim();
      if (name !== '') modules.push(name);
    }
  }

  return { path: source, version: projectVersion, managedVersions, properties, modules, source: clean };
}

/**
 * `<dependencies>` blocks of a pom, excluding the dependencyManagement one (those are
 * "managed", not declared) and excluding `<exclusions>` children, which name packages the
 * project deliberately does *not* want.
 */
function pomDependencyRecords(pom: PomInfo, properties: Map<string, string>): DependencyRecord[] {
  const project = /<project(?:\s[^>]*)?>([\s\S]*)<\/project>/.exec(pom.source)?.[1] ?? pom.source;
  const stripped = project.replace(/<dependencyManagement>[\s\S]*?<\/dependencyManagement>/g, '');
  const records: DependencyRecord[] = [];

  for (const block of xmlBlocks(stripped, 'dependencies')) {
    for (const dep of xmlBlocks(block, 'dependency')) {
      const withoutExclusions = dep.replace(/<exclusions>[\s\S]*?<\/exclusions>/g, '');
      const groupId = xmlValue(withoutExclusions, 'groupId') ?? '';
      const artifactId = xmlValue(withoutExclusions, 'artifactId') ?? '';
      if (groupId === '' || artifactId === '') continue;
      const name = `${groupId}:${artifactId}`;
      const rawVersion = xmlValue(withoutExclusions, 'version');
      const scope = xmlValue(withoutExclusions, 'scope') ?? 'compile';
      // `<scope>import</scope>` + `<type>pom</type>` is a BOM: it imports version management,
      // it does not put an artifact on the classpath, so counting it would be wrong.
      if (scope === 'import' || xmlValue(withoutExclusions, 'type') === 'pom') continue;
      const dependencyScope: DependencyScope =
        scope === 'test'
          ? 'dev'
          : scope === 'provided' || scope === 'system'
            ? 'optional'
            : 'runtime';

      let spec = rawVersion ?? '';
      let kind: DependencySpecKind;
      let requestedVersion: string | undefined;
      if (spec === '') {
        const managed = pom.managedVersions.get(name) ?? properties.get(`__managed__${name}`);
        if (managed !== undefined && managed !== '') {
          kind = 'range';
          requestedVersion = managed;
        } else {
          // Legal Maven: the version comes from a BOM or a parent outside this workspace.
          kind = 'catalog';
        }
      } else if (spec.includes('${')) {
        const resolved = resolveProperty(spec, properties);
        if (resolved === '') {
          // Maven would itself fail to build with an unresolved `${...}`.
          kind = 'unresolved';
        } else {
          kind = 'exact';
          requestedVersion = resolved;
          spec = resolved;
        }
      } else {
        const cls = classifySpec(spec);
        kind = cls.kind;
        requestedVersion = cls.requestedVersion;
      }

      records.push({
        name,
        spec,
        kind,
        scope: dependencyScope,
        source: pom.path,
        group: groupId,
        ...(requestedVersion === undefined ? {} : { requestedVersion }),
      });
    }
  }
  return records;
}

/* ------------------------------------------------------------------ gradle */

/** `ext { name = '1.0' }`, `ext.name = '1.0'`, `def name = '1.0'`, `name = '1.0'`. */
function gradleVariables(text: string): Map<string, string> {
  const map = new Map<string, string>();
  const assignment = /(?:^|\n)\s*(?:ext\.|def\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g;
  let match = assignment.exec(text);
  while (match !== null) {
    const name = match[1] ?? '';
    const value = match[2] ?? '';
    if (name !== '' && value !== '' && !map.has(name)) map.set(name, value);
    match = assignment.exec(text);
  }
  const blocks = /\bext(?:ra)?\s*\{\s*([\s\S]*?)\n\s*\}/g;
  let block = blocks.exec(text);
  while (block !== null) {
    for (const entry of (block[1] ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)\s*=\s*['"]([^'"]+)['"]/g)) {
      const name = entry[1] ?? '';
      if (name !== '') map.set(name, entry[2] ?? '');
    }
    block = blocks.exec(text);
  }
  return map;
}

/** `$name`, `${name}` and `"${name}"` all reduce to the same lookup. '' means unresolved. */
function resolveGradleValue(value: string, vars: ReadonlyMap<string, string>): string {
  let current = value.replace(/^["']|["']$/g, '').trim();
  for (let i = 0; i < 5; i += 1) {
    const match = /\$\{?([A-Za-z_][A-Za-z0-9_.]*)\}?/.exec(current);
    if (match === null) return current;
    const replacement = vars.get(match[1] ?? '');
    if (replacement === undefined) return '';
    current = current.replace(match[0], replacement);
  }
  return '';
}

const GRADLE_CONFIGURATIONS = [
  'implementation',
  'api',
  'compileOnlyApi',
  'compileOnly',
  'runtimeOnly',
  'developmentOnly',
  'annotationProcessor',
  'kapt',
  'classpath',
  'providedCompile',
  'providedRuntime',
  'testImplementation',
  'testCompileOnly',
  'testRuntimeOnly',
  'testAnnotationProcessor',
];

function gradleScope(configuration: string): DependencyScope {
  return configuration.startsWith('test') ? 'dev' : 'runtime';
}

function readGradleDependencies(text: string, source: string): DependencyRecord[] {
  const clean = stripComments(text);
  const vars = gradleVariables(clean);
  const records: DependencyRecord[] = [];
  const configurations = GRADLE_CONFIGURATIONS.join('|');

  const pushCoordinate = (
    rawGroup: string,
    rawName: string,
    rawVersion: string,
    configuration: string,
  ): void => {
    const group = resolveGradleValue(rawGroup, vars);
    const name = resolveGradleValue(rawName, vars);
    if (group === '' || name === '') return;
    const full = `${group}:${name}`;
    const trimmedVersion = rawVersion.trim();
    let spec = trimmedVersion;
    let kind: DependencySpecKind;
    let requestedVersion: string | undefined;
    if (trimmedVersion === '') {
      kind = 'catalog';
    } else if (trimmedVersion.includes('$')) {
      const resolved = resolveGradleValue(trimmedVersion, vars);
      if (resolved === '') {
        kind = 'unresolved';
      } else {
        kind = 'exact';
        requestedVersion = resolved;
        spec = resolved;
      }
    } else {
      const cls = classifySpec(trimmedVersion);
      kind = cls.kind;
      requestedVersion = cls.requestedVersion;
    }
    records.push({
      name: full,
      spec,
      kind,
      scope: gradleScope(configuration),
      source,
      group,
      ...(requestedVersion === undefined ? {} : { requestedVersion }),
    });
  };

  // `implementation("g:n:v")` / `api 'g:n:v'` / `implementation(libs.guava)`
  const callRe = new RegExp(
    `\\b(${configurations})\\s*\\(?\\s*(?:['"]([^'"]+)['"]|([A-Za-z_][A-Za-z0-9_]*(?:\\.[A-Za-z0-9_]+)+))`,
    'g',
  );
  const literals: { configuration: string; literal: string }[] = [];
  const accessors: { configuration: string; accessor: string }[] = [];
  for (const match of clean.matchAll(callRe)) {
    const configuration = match[1] ?? '';
    const literal = match[2];
    const accessor = match[3];
    if (literal !== undefined) literals.push({ configuration, literal });
    else if (accessor !== undefined) accessors.push({ configuration, accessor });
  }
  for (const { configuration, literal } of literals) {
    const parts = literal.split(':');
    if (parts.length >= 3) pushCoordinate(parts[0] ?? '', parts[1] ?? '', parts.slice(2).join(':'), configuration);
    else if (parts.length === 2) pushCoordinate(parts[0] ?? '', parts[1] ?? '', '', configuration);
    else if (literal !== '') {
      // A platform/BOM or an alias reference: no coordinate yet, and not an error until the
      // catalog has been read. `platform(...)`/`enforcedPlatform(...)` wrapped accessors are
      // covered because the inner `libs.x` accessor matches on its own.
      records.push({
        name: literal,
        spec: '',
        kind: 'catalog',
        scope: gradleScope(configuration),
        source,
      });
    }
  }
  // A catalog accessor such as `libs.guava` / `libs.mybatis.spring` is a Kotlin DSL
  // property, not a string, so it needs its own branch — it is the common modern form.
  for (const { configuration, accessor } of accessors) {
    records.push({
      name: accessor,
      spec: '',
      kind: 'catalog',
      scope: gradleScope(configuration),
      source,
    });
  }

  // Named-argument form: `implementation group: 'g', name: 'n', version: 'v'`
  const namedRe = new RegExp(
    `\\b(${configurations})\\s*\\(?\\s*group\\s*[:=]\\s*['"]([^'"]+)['"]\\s*,\\s*name\\s*[:=]\\s*['"]([^'"]+)['"](?:\\s*,\\s*version\\s*[:=]\\s*['"]([^'"]*)['"])?`,
    'g',
  );
  let named = namedRe.exec(clean);
  while (named !== null) {
    pushCoordinate(named[2] ?? '', named[3] ?? '', named[4] ?? '', named[1] ?? '');
    named = namedRe.exec(clean);
  }

  return records;
}

/** `gradle/libs.versions.toml`: alias -> `group:name:version`, for `libs.foo.bar` references. */
function readVersionCatalog(text: string): Map<string, string> {
  const toml = parseToml(text);
  const versions = new Map<string, string>();
  for (const [key, value] of toml) {
    if (!key.startsWith('versions.')) continue;
    const resolved = tomlScalar(value);
    if (resolved !== undefined) versions.set(key.slice('versions.'.length), resolved);
  }
  const libraries = new Map<string, string>();
  for (const [key, value] of toml) {
    if (!key.startsWith('libraries.')) continue;
    const alias = key.slice('libraries.'.length);
    const raw = value.trim();
    if (raw.startsWith('{')) {
      const module = /\bmodule\s*=\s*["']([^"']+)["']/.exec(raw)?.[1];
      if (module === undefined) continue;
      const version = /\bversion\s*=\s*["']([^"']+)["']/.exec(raw)?.[1];
      const ref = /\bversion\.ref\s*=\s*["']([^"']+)["']/.exec(raw)?.[1];
      const resolved = version ?? (ref === undefined ? '' : (versions.get(ref) ?? ''));
      libraries.set(alias, resolved === '' ? module : `${module}:${resolved}`);
      continue;
    }
    if (raw.split(':').length >= 2) libraries.set(alias, raw);
  }
  return libraries;
}

/* ------------------------------------------------------------------ per-file dispatch */

interface ParsedFile {
  /** workspace-relative POSIX path of the file this record set came from */
  path: string;
  ecosystem: DependencyEcosystem;
  kind: 'manifest' | 'lock';
  records: DependencyRecord[];
  lock?: LockIndex;
}

interface ParseState {
  pomPaths: string[];
  catalogPaths: string[];
}

/** Route one file to its ecosystem parser. */
async function parseSource(
  filePath: string,
  text: string,
  budget: ReadBudget,
  state: ParseState,
): Promise<ParsedFile | undefined> {
  const base = await parseSourceBody(filePath, text, budget, state);
  return base === undefined ? undefined : { ...base, path: filePath };
}

async function parseSourceBody(
  filePath: string,
  text: string,
  budget: ReadBudget,
  state: ParseState,
): Promise<Omit<ParsedFile, 'path'> | undefined> {
  switch (path.posix.basename(filePath)) {
    case 'package.json':
      return { ecosystem: 'npm', kind: 'manifest', records: readPackageJson(text, filePath) };
    case 'package-lock.json':
    case 'npm-shrinkwrap.json':
      return { ecosystem: 'npm', kind: 'lock', records: [], lock: readPackageLock(text) };
    case 'pnpm-lock.yaml':
      return { ecosystem: 'npm', kind: 'lock', records: [], lock: readPnpmLock(text) };
    case 'yarn.lock':
      return { ecosystem: 'npm', kind: 'lock', records: [], lock: readYarnLock(text) };
    case 'requirements.txt':
    case 'requirements-dev.txt': {
      const records = parseRequirements(text, filePath);
      // Included files contribute dependencies but are not manifests of their own: they are
      // only read because this file names them, so registering them would make the audit
      // report a manifest that the walker never found.
      const included: DependencyRecord[] = [];
      for (const target of requirementIncludes(text)) {
        const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(filePath), target));
        const text2 = await budget.read(resolved, 'included requirements file missing');
        if (text2 === undefined) continue;
        included.push(...parseRequirements(text2, filePath));
      }
      const seen = new Set(records.map((record) => record.name.toLowerCase()));
      for (const record of included) {
        const key = record.name.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        records.push(record);
      }
      return { ecosystem: 'python', kind: 'manifest', records };
    }
    case 'pyproject.toml':
      return { ecosystem: 'python', kind: 'manifest', records: readPyproject(text, filePath) };
    case 'Pipfile':
      return { ecosystem: 'python', kind: 'manifest', records: readPipfile(text, filePath) };
    case 'Pipfile.lock':
      return { ecosystem: 'python', kind: 'lock', records: [], lock: readPythonLock(text, 'pipenv') };
    case 'poetry.lock':
      return { ecosystem: 'python', kind: 'lock', records: [], lock: readPythonLock(text, 'poetry') };
    case 'uv.lock':
      return { ecosystem: 'python', kind: 'lock', records: [], lock: readPythonLock(text, 'uv') };
    case 'pom.xml':
      // Recorded only: a pom's `<properties>` must all be known before any version resolves.
      state.pomPaths.push(filePath);
      pomSources.set(filePath, stripXmlComments(text));
      return undefined;
    case 'build.gradle':
    case 'build.gradle.kts':
      return { ecosystem: 'gradle', kind: 'manifest', records: readGradleDependencies(text, filePath) };
    case 'libs.versions.toml':
      state.catalogPaths.push(filePath);
      catalogs.set(filePath, readVersionCatalog(text));
      return undefined;
    default:
      return undefined;
  }
}

/** pom sources and gradle catalogs are collected during the read pass, used in the second. */
const pomSources = new Map<string, string>();
const catalogs = new Map<string, Map<string, string>>();

/* ------------------------------------------------------------------ orchestration */

function lockNamesFor(ecosystem: DependencyEcosystem): string {
  switch (ecosystem) {
    case 'npm':
      return 'package-lock.json, pnpm-lock.yaml, yarn.lock';
    case 'python':
      return 'poetry.lock, Pipfile.lock, uv.lock';
    case 'maven':
      return 'Maven resolves versions from pom.xml, so it has no lockfile to check';
    case 'gradle':
      return 'Gradle keeps no lockfile unless dependency locking is enabled (gradle.lockfile)';
  }
}

function mergeLocks(files: ParsedFile[]): LockIndex {
  const index = emptyIndex();
  for (const file of files) {
    if (file.lock === undefined) continue;
    for (const name of file.lock.names) index.names.add(name);
    for (const [name, versions] of file.lock.versions) {
      const set = index.versions.get(name) ?? new Set<string>();
      for (const version of versions) set.add(version);
      index.versions.set(name, set);
    }
  }
  return index;
}

/** The audit entry point. Pure: no MCP types, no network, no writes. */
export async function auditDependencies(
  options: DependencyAuditOptions,
  logger?: Logger,
): Promise<DependencyAuditResult> {
  pomSources.clear();
  catalogs.clear();

  const root = path.resolve(options.root);
  const maxBytes = options.maxFileSizeBytes ?? MAX_AUDIT_FILE_BYTES;
  const notes: string[] = [];

  const walk = await walkWorkspace({
    root,
    exclude: options.exclude,
    maxDepth: WALK_DEPTH,
    maxFiles: 5_000,
    maxFileSizeBytes: maxBytes,
    onSkip: (info) => {
      if (info.reason === 'oversized') {
        logger?.debug('dependency_audit skipped an oversized file', { path: info.path });
      }
    },
  });

  // Root, one level down, and `<packages|apps>/<member>/` — never deeper than that.
  const candidates = walk.files
    .filter((file) => MANIFEST_NAMES.has(file.name))
    .filter((file) => {
      const segments = file.path.split('/');
      if (segments.length - 1 <= 1) return true;
      // `gradle/libs.versions.toml` is a support file, not a project members' manifest.
      if (file.name === 'libs.versions.toml') return true;
      const prefix = MONOREPO_PREFIXES.find((candidate) => file.path.startsWith(candidate));
      if (prefix === undefined) return false;
      return file.path.slice(prefix.length).split('/').length === 2;
    })
    .sort((a, b) => compareStrings(a.path, b.path));

  const budget = new ReadBudget(root, MAX_AUDIT_FILES, maxBytes);
  const state: ParseState = { pomPaths: [], catalogPaths: [] };
  const parsed: ParsedFile[] = [];
  const manifestPaths = new Map<DependencyEcosystem, Set<string>>();
  const lockPaths = new Map<DependencyEcosystem, Set<string>>();

  for (const candidate of candidates) {
    const text = await budget.read(candidate.path, 'unreadable');
    if (text === undefined) continue;
    const result = await parseSource(candidate.path, text, budget, state);
    if (result === undefined) continue;
    parsed.push(result);
    const bucket = result.kind === 'manifest' ? manifestPaths : lockPaths;
    const set = bucket.get(result.ecosystem) ?? new Set<string>();
    set.add(candidate.path);
    bucket.set(result.ecosystem, set);
  }

  // Maven: resolve every pom's `${...}` against every pom's <properties> before counting.
  const mavenPoms = state.pomPaths
    .map((pomPath) => ({ pomPath, source: pomSources.get(pomPath) ?? '' }))
    .filter((entry) => entry.source !== '')
    .map((entry) => readPom(entry.source, entry.pomPath));
  const mavenProperties = new Map<string, string>();
  for (const pom of mavenPoms) {
    for (const [name, value] of pom.properties) if (!mavenProperties.has(name)) mavenProperties.set(name, value);
  }
  // Built-ins win over a sibling module's own `project.version`.
  for (const pom of mavenPoms) {
    for (const [name, value] of pom.properties) {
      if (name.startsWith('project.')) mavenProperties.set(name, value);
    }
  }
  for (const pom of mavenPoms) {
    parsed.push({
      path: pom.path,
      ecosystem: 'maven',
      kind: 'manifest',
      records: pomDependencyRecords(pom, mavenProperties),
    });
    const set = manifestPaths.get('maven') ?? new Set<string>();
    set.add(pom.path);
    manifestPaths.set('maven', set);
  }
  const moduleCount = mavenPoms.reduce((sum, pom) => sum + pom.modules.length, 0);

  // Gradle: a `libs.*` alias reference becomes a real coordinate when the catalog defines it.
  if (catalogs.size > 0) {
    for (const file of parsed) {
      if (file.ecosystem !== 'gradle') continue;
      for (const record of file.records) {
        if (record.kind !== 'catalog') continue;
        const alias = record.name.replace(/^libs\./, '');
        let resolved: string | undefined;
        for (const catalog of catalogs.values()) {
          resolved = catalog.get(alias) ?? catalog.get(record.name);
          if (resolved !== undefined) break;
        }
        if (resolved === undefined) continue;
        const parts = resolved.split(':');
        record.kind = 'exact';
        record.spec = resolved;
        record.requestedVersion = parts[parts.length - 1] ?? '';
        if (parts.length >= 2) {
          record.name = `${parts[0]}:${parts[1]}`;
          record.group = parts[0];
        }
      }
      const set = manifestPaths.get('gradle') ?? new Set<string>();
      for (const catalogPath of state.catalogPaths) set.add(catalogPath);
      manifestPaths.set('gradle', set);
    }
  }

  const declarations = new Map<DependencyEcosystem, DependencyRecord[]>();
  const lockFiles = new Map<DependencyEcosystem, ParsedFile[]>();
  for (const file of parsed) {
    if (file.kind === 'manifest' && file.records.length > 0) {
      const list = declarations.get(file.ecosystem) ?? [];
      list.push(...file.records);
      declarations.set(file.ecosystem, list);
    } else if (file.kind === 'lock') {
      const list = lockFiles.get(file.ecosystem) ?? [];
      list.push(file);
      lockFiles.set(file.ecosystem, list);
    }
  }

  const issues: LockIssue[] = [];
  const seenIssues = new Set<string>();
  const report = (issue: LockIssue): void => {
    const key = `${issue.path}|${issue.kind}|${issue.message}`;
    if (seenIssues.has(key)) return;
    seenIssues.add(key);
    issues.push(issue);
  };

  const ecosystems: EcosystemDependencyProfile[] = [];
  const order: DependencyEcosystem[] = ['npm', 'python', 'maven', 'gradle'];
  // npm and python legitimately resolve one package at several versions; for the JVM
  // ecosystems maven/gradle guarantee one, so a duplicate there is a real error.
  const duplicatesAreErrors: DependencyEcosystem[] = ['maven', 'gradle'];
  // Only npm and python ship a lockfile that is expected to list every manifest declaration.
  const lockfileEcosystems: DependencyEcosystem[] = ['npm', 'python'];

  for (const ecosystem of order) {
    const declared = declarations.get(ecosystem) ?? [];
    const ecosystemLockFiles = lockFiles.get(ecosystem) ?? [];
    const manifests = [...(manifestPaths.get(ecosystem) ?? new Set<string>())].sort(compareStrings);
    const lockPathsForEcosystem = [...(lockPaths.get(ecosystem) ?? new Set<string>())].sort(compareStrings);
    if (manifests.length === 0 && lockPathsForEcosystem.length === 0) continue;

    const distinct = new Map<string, DependencyRecord>();
    for (const record of declared) {
      const key = ecosystem === 'python' ? record.name.toLowerCase() : record.name;
      if (!distinct.has(key)) distinct.set(key, record);
    }

    const lockIndex = mergeLocks(ecosystemLockFiles);
    const transitive = lockIndex.names.size === 0 ? 0 : Math.max(0, lockIndex.names.size - distinct.size);
    const ecosystemNotes: string[] = [];

    // A missing lockfile is an ecosystem-level fact. It is attributed to the manifest that actually
    // declares the dependencies, not to whichever path happens to sort first — a pyproject.toml that
    // declares nothing must not be blamed for requirements.txt having no lock.
    const declarationCounts = new Map<string, number>();
    for (const record of declared) {
      declarationCounts.set(record.source, (declarationCounts.get(record.source) ?? 0) + 1);
    }
    const primaryManifest =
      [...declarationCounts.entries()].sort((left, right) => right[1] - left[1] || compareStrings(left[0], right[0]))[0]?.[0] ??
      manifests[0] ??
      'unknown';

    // Maven and Gradle have no lockfile by convention (Gradle only with dependency locking
    // enabled). Reporting a missing lock there would be a rule the ecosystem cannot satisfy.
    const lockCheckApplies = lockfileEcosystems.includes(ecosystem);
    if (lockCheckApplies && lockPathsForEcosystem.length === 0 && distinct.size > 0) {
      report({
        path: primaryManifest,
        kind: 'missing_lock',
        message: `${distinct.size} ${ecosystem} dependency/ies are declared but no lockfile is present (${lockNamesFor(ecosystem)}) — installed versions are not reproducible`,
        severity: 'ERROR',
      });
    }

    if (lockPathsForEcosystem.length > 0) {
      for (const [key, record] of distinct) {
        if (lockIndex.names.has(key)) continue;
        const bare = key.includes('/') ? key.slice(key.indexOf('/') + 1) : key;
        if (lockIndex.names.has(bare)) continue;
        report({
          path: record.source,
          kind: 'lock_out_of_sync',
          message: `${record.name} is declared in ${record.source} but does not appear in ${lockPathsForEcosystem.join(', ')}`,
          severity: 'WARNING',
        });
      }
    }

    for (const [name, versions] of lockIndex.versions) {
      const meaningful = [...versions].filter((version) => version !== '' && !version.startsWith('link:'));
      if (meaningful.length < 2) continue;
      report({
        path: lockPathsForEcosystem[0] ?? name,
        kind: 'duplicate_version',
        message: `${name} resolves to ${meaningful.length} different versions (${meaningful.sort(compareStrings).join(', ')})`,
        severity: duplicatesAreErrors.includes(ecosystem) ? 'ERROR' : 'WARNING',
      });
    }

    for (const record of distinct.values()) {
      if (record.kind === 'unpinned') {
        report({
          path: record.source,
          kind: 'unpinned',
          message: `${record.name} uses an unpinned specifier (${record.spec === '' ? 'no version' : record.spec}) — a rebuild can install a different version`,
          severity: 'WARNING',
        });
      } else if (record.kind === 'unresolved') {
        report({
          path: record.source,
          kind: 'unresolved_version',
          message: `${record.name} declares version ${record.spec}, which no property or version catalog in this workspace defines`,
          severity: 'ERROR',
        });
      } else if (record.kind === 'catalog') {
        report({
          path: record.source,
          kind: 'unresolved_version',
          message: `${record.name} has no version in ${record.source} and none is managed in this workspace`,
          severity: 'WARNING',
        });
      }
    }

    // Two manifests in the same workspace pinning one package to different exact versions.
    // Iterates the declared records, not `distinct`: that map keeps only the first record per
    // name, which would hide two poms disagreeing about one artifact.
    const pinned = new Map<string, Map<string, string>>();
    for (const record of declared) {
      const key = ecosystem === 'python' ? record.name.toLowerCase() : record.name;
      const version = singleVersion(record.spec);
      if (version === '') continue;
      const byVersion = pinned.get(key) ?? new Map<string, string>();
      if (!byVersion.has(version)) byVersion.set(version, record.source);
      pinned.set(key, byVersion);
    }
    for (const [name, byVersion] of pinned) {
      if (byVersion.size < 2) continue;
      const sources = [...new Set(byVersion.values())].sort(compareStrings);
      report({
        path: sources[0] ?? name,
        kind: 'duplicate_version',
        message: `${name} is pinned to ${byVersion.size} different versions across ${sources.join(', ')} (${[...byVersion.keys()].sort(compareStrings).join(', ')})`,
        // Maven and Gradle resolve one version per build, so two modules disagreeing is a
        // convergence defect that ends as a runtime NoSuchMethodError; npm and pip may legitimately
        // hold several versions side by side.
        severity: duplicatesAreErrors.includes(ecosystem) ? 'ERROR' : 'WARNING',
      });
    }

    if (ecosystem === 'npm') {
      const yarn = lockPathsForEcosystem.some((p) => path.posix.basename(p) === 'yarn.lock');
      if (yarn) {
        ecosystemNotes.push(
          'yarn.lock was read for package-name presence only: a resolved version sits in a nested field that is not reliable to parse here, so it contributes no transitive count and no resolved version',
        );
      }
      if (lockPathsForEcosystem.some((p) => path.posix.basename(p) === 'pnpm-lock.yaml')) {
        ecosystemNotes.push('pnpm-lock.yaml: importer dependencies are direct, `packages` keys are the resolved graph');
      }
    }
    if (ecosystem === 'maven') {
      ecosystemNotes.push(
        'pom.xml is parsed lexically: <profiles> are not activated, <exclusions> are skipped, and a version managed only by a parent outside this workspace stays unmanaged (reported as unresolved_version at WARNING severity)',
      );
      if (moduleCount > 0) {
        ecosystemNotes.push(`${moduleCount} <module> reference(s) found; submodules are read from their own pom.xml`);
      }
    }
    if (ecosystem === 'gradle') {
      ecosystemNotes.push(
        'build.gradle / build.gradle.kts dependency lines are parsed lexically (implementation, api, testImplementation, compileOnly, runtimeOnly and friends); versions supplied by plugins, buildSrc or a catalog alias this reader cannot follow are not resolved',
      );
    }
    if (distinct.size === 0 && ecosystemLockFiles.length > 0) {
      ecosystemNotes.push('a lockfile is present but no manifest declares dependencies for this ecosystem');
    }
    if (distinct.size > 0 && transitive === 0 && lockPathsForEcosystem.length > 0) {
      ecosystemNotes.push(
        'transitive is 0 because the lockfile(s) present list no resolvable package versions beyond the declared set',
      );
    }

    ecosystems.push({
      name: ecosystem,
      manifestFiles: manifests,
      direct: distinct.size,
      transitive,
      ...(lockPathsForEcosystem.length === 0 ? {} : { lockFile: lockPathsForEcosystem[0] }),
      ...(ecosystemNotes.length === 0 ? {} : { notes: ecosystemNotes }),
    });
  }

  // A lockfile with no manifest anywhere in the workspace cannot be checked at all.
  for (const [ecosystem, files] of lockFiles) {
    const manifests = manifestPaths.get(ecosystem) ?? new Set<string>();
    if (manifests.size > 0 || files.length === 0) continue;
    const lockPath = files[0]?.path ?? 'unknown';
    report({
      path: lockPath,
      kind: 'missing_manifest',
      message: `${lockPath} exists but no ${ecosystem} manifest was found in this workspace — the lockfile cannot be checked against a declaration`,
      severity: 'WARNING',
    });
  }

  issues.sort(
    (a, b) =>
      compareStrings(a.path, b.path) ||
      compareStrings(a.kind, b.kind) ||
      compareStrings(a.message, b.message),
  );

  if (budget.skippedFiles.length > 0) {
    notes.push(
      `capped at ${MAX_AUDIT_FILES} files and ${Math.round(maxBytes / (1024 * 1024))} MiB per file; not read: ${budget.skippedFiles.join(', ')}`,
    );
  }
  if (budget.readCount === 0) {
    notes.push(
      'no dependency manifest or lockfile was found in the workspace root, one level below it, or under packages/ and apps/',
    );
  }
  notes.push(
    'offline by default: outdated[] is empty and vulnerable is omitted, because neither can be derived from the workspace alone (both need a registry lookup); pass network:true to request one',
  );
  if (options.network === true) {
    notes.push(
      'network:true was requested, but this build has no registry client, so no lookup was performed and outdated[] stays empty',
    );
  }

  const direct = ecosystems.reduce((sum, profile) => sum + profile.direct, 0);
  const transitive = ecosystems.reduce((sum, profile) => sum + profile.transitive, 0);
  if (direct === 0) notes.push('no dependency declarations were parsed from any ecosystem in this workspace');

  const result: DependencyAuditResult = {
    ecosystems,
    direct,
    transitive,
    outdated: [],
    lockIssues: issues,
    notes,
    truncated: budget.skippedFiles.length > 0,
    network: options.network === true,
    scannedFiles: budget.readCount,
  };
  if (options.network === true) result.vulnerable = [];

  logger?.info('dependency_audit complete', {
    ecosystems: ecosystems.map((profile) => profile.name).join(',') || 'none',
    direct,
    transitive,
    lockIssues: issues.length,
    scannedFiles: budget.readCount,
  });

  return result;
}

export { PY_LOCK_NAMES };
