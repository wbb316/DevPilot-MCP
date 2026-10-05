import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { SymbolIndex } from '../code/symbol-index.js';
import { isTestPath } from '../git/risk.js';
import type { SymbolHit, SymbolKind, SymbolRecord } from '../types/code.js';
import type {
  AffectedConfidence,
  AffectedFile,
  AffectedReason,
  AffectedSymbol,
  ImpactDefinition,
  ImpactResult,
  ImpactRisk,
  ImpactRiskLevel,
  ImpactTargetKind,
} from '../types/impact.js';

/**
 * Impact analysis (docs/TOOLS.md Phase 8, docs/ROADMAP.md Phase 8).
 *
 * Answers "what breaks if I change this?" from what the lexical index actually knows:
 * declarations, references, resolved import edges and the project's own test layout. It is
 * deliberately honest about the ceiling of that method — `method: 'heuristic'`, a stated
 * `confidence`, and `notes` that name every way the answer is incomplete.
 *
 * Everything here is deterministic: same index + same target = same answer. DevPilot does not
 * guess intent; the outer agent decides what to do with the evidence.
 */

export const DEFAULT_IMPACT_DEPTH = 2;
export const MAX_IMPACT_DEPTH = 5;
export const DEFAULT_IMPACT_LIMIT = 50;
export const MAX_IMPACT_LIMIT = 200;
export const DEFAULT_REFERENCE_LIMIT = 500;
export const MAX_FILE_TARGET_SYMBOLS = 25;
export const MAX_DIRECTORY_MEMBERS = 200;
export const MAX_LINES_PER_FILE = 20;

const RISK_ORDER: Record<ImpactRiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

/** Files whose change reaches the whole project rather than one module. */
const MANIFEST_FILES: ReadonlySet<string> = new Set([
  'package.json',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'settings.gradle',
  'settings.gradle.kts',
  'pyproject.toml',
  'requirements.txt',
  'setup.py',
  'Pipfile',
  'tsconfig.json',
  'dockerfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'cmakelists.txt',
  'go.mod',
  'cargo.toml',
]);

const HIGH_REFERENCE_COUNT = 30;
const NOTABLE_REFERENCE_COUNT = 10;
const HIGH_FAN_IN = 10;
const TESTLESS_REFERENCE_COUNT = 1;

/** Stronger reasons win when two paths reach the same file. */
const REASON_RANK: Record<AffectedReason, number> = {
  declaration: 6,
  target: 5,
  reference: 4,
  test: 3,
  dependency: 2,
  directory_member: 1,
  importer: 0,
};

export interface AnalyzeImpactInput {
  target: string;
  kind?: 'symbol' | 'file' | 'auto';
  depth?: number;
  includeTests?: boolean;
  limit?: number;
  /** Absolute workspace root; only used to stat the target. */
  root: string;
}

interface Facts {
  referenceCount: number;
  referenceFiles: number;
  declarationPaths: string[];
  declarationKinds: SymbolKind[];
  truncated: boolean;
  totalAffected: number;
}

function clampInt(value: number | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  const floored = Math.floor(value);
  if (floored < min) return min;
  if (floored > max) return max;
  return floored;
}

/** Workspace-relative POSIX path, or undefined when the input is absolute or escapes the root. */
export function normalizeRelative(input: string): string | undefined {
  const trimmed = input.trim().replace(/\\/g, '/');
  if (trimmed === '') return undefined;
  if (/^[a-zA-Z]:\//.test(trimmed) || trimmed.startsWith('/')) return undefined;
  const withoutPrefix = trimmed.replace(/^\.\//, '');
  const segments = withoutPrefix.split('/').filter((segment) => segment !== '' && segment !== '.');
  if (segments.some((segment) => segment === '..')) return undefined;
  return segments.join('/');
}

async function detectTargetKind(
  index: SymbolIndex,
  root: string,
  target: string,
  requested: 'symbol' | 'file' | 'auto' | undefined,
): Promise<ImpactTargetKind> {
  if (requested === 'symbol') return 'symbol';
  const relative = normalizeRelative(target);
  if (relative !== undefined) {
    if (index.hasFile(relative)) return requested === 'file' ? 'file' : 'file';
    try {
      const stat = await fs.stat(path.join(root, relative));
      if (stat.isDirectory()) return 'directory';
      if (stat.isFile()) return 'file';
    } catch {
      /* not on disk: it may still be a directory prefix inside the index */
    }
    const prefix = `${relative.replace(/\/+$/, '')}/`;
    if (index.filePaths().some((filePath) => filePath.startsWith(prefix))) return 'directory';
    if (requested === 'file') return 'file';
  }
  return 'symbol';
}

function reverseImportMap(index: SymbolIndex): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of index.importEdges()) {
    if (edge.toPath === undefined) continue;
    const list = map.get(edge.toPath) ?? [];
    if (!list.includes(edge.fromPath)) list.push(edge.fromPath);
    map.set(edge.toPath, list);
  }
  return map;
}

function forwardImportMap(index: SymbolIndex): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const edge of index.importEdges()) {
    if (edge.toPath === undefined) continue;
    const list = map.get(edge.fromPath) ?? [];
    if (!list.includes(edge.toPath)) list.push(edge.toPath);
    map.set(edge.fromPath, list);
  }
  return map;
}

class AffectedSet {
  private readonly files = new Map<string, AffectedFile>();

  add(file: AffectedFile): void {
    const existing = this.files.get(file.path);
    if (existing === undefined) {
      this.files.set(file.path, file);
      return;
    }
    const stronger = REASON_RANK[file.reason] > REASON_RANK[existing.reason];
    const closer = file.distance < existing.distance;
    if (!stronger && !closer) {
      if (existing.lines === undefined && file.lines !== undefined) existing.lines = file.lines;
      return;
    }
    const merged: AffectedFile = {
      path: file.path,
      reason: stronger ? file.reason : existing.reason,
      confidence: stronger ? file.confidence : existing.confidence,
      distance: Math.min(existing.distance, file.distance),
    };
    const detail = file.detail ?? existing.detail;
    if (detail !== undefined) merged.detail = detail;
    const lines = file.lines ?? existing.lines;
    if (lines !== undefined) merged.lines = lines;
    this.files.set(file.path, merged);
  }

  has(relative: string): boolean {
    return this.files.has(relative);
  }

  values(): AffectedFile[] {
    return [...this.files.values()];
  }
}

function toDefinition(hit: SymbolHit): ImpactDefinition {
  const definition: ImpactDefinition = {
    name: hit.name,
    kind: hit.kind,
    path: hit.path,
    startLine: hit.startLine,
    endLine: hit.endLine,
  };
  if (hit.signature !== undefined) definition.signature = hit.signature;
  return definition;
}

function toAffectedSymbol(record: SymbolRecord, reason: 'definition' | 'reference'): AffectedSymbol {
  const symbol: AffectedSymbol = {
    name: record.name,
    kind: record.kind,
    path: record.path,
    startLine: record.startLine,
    endLine: record.endLine,
    reason,
  };
  if (record.signature !== undefined) symbol.signature = record.signature;
  return symbol;
}

/** Innermost declared symbol containing a line — the calling scope of a reference. */
function enclosingSymbol(index: SymbolIndex, filePath: string, line: number): SymbolRecord | undefined {
  let best: SymbolRecord | undefined;
  for (const record of index.symbolsInFile(filePath)) {
    if (line < record.startLine || line > record.endLine) continue;
    if (best === undefined || record.endLine - record.startLine < best.endLine - best.startLine) best = record;
  }
  return best;
}

export async function analyzeImpact(index: SymbolIndex, input: AnalyzeImpactInput): Promise<ImpactResult> {
  const depth = clampInt(input.depth, DEFAULT_IMPACT_DEPTH, 0, MAX_IMPACT_DEPTH);
  const limit = clampInt(input.limit, DEFAULT_IMPACT_LIMIT, 1, MAX_IMPACT_LIMIT);
  const includeTests = input.includeTests ?? true;
  const targetKind = await detectTargetKind(index, input.root, input.target, input.kind);
  const notes: string[] = [];
  const affected = new AffectedSet();
  const symbols: AffectedSymbol[] = [];
  const facts: Facts = {
    referenceCount: 0,
    referenceFiles: 0,
    declarationPaths: [],
    declarationKinds: [],
    truncated: false,
    totalAffected: 0,
  };
  let definitions: SymbolHit[] = [];

  if (targetKind === 'symbol') {
    const found = index.findSymbols(input.target, { limit: DEFAULT_REFERENCE_LIMIT });
    const member = input.target.includes('.')
      ? input.target.slice(input.target.lastIndexOf('.') + 1)
      : input.target;
    const exact = found.results.filter(
      (hit) => hit.name === member || hit.name.toLowerCase() === member.toLowerCase(),
    );
    definitions = exact.length > 0 ? exact : found.results.slice(0, limit);
    if (exact.length === 0 && found.results.length > 0) {
      notes.push(
        `no declaration is named exactly "${input.target}": the definition list holds the closest name matches instead`,
      );
    }
    if (found.truncated) facts.truncated = true;

    const answer = await index.findReferences(input.target, { limit: DEFAULT_REFERENCE_LIMIT });
    facts.referenceCount = answer.result.total;
    facts.referenceFiles = answer.grouped.length;
    if (answer.result.truncated) facts.truncated = true;
    if (answer.result.total === 0 && definitions.length === 0) {
      notes.push(
        'nothing in the index matches this name: dynamic usage (getattr, reflection, string-built names) is invisible to a lexical index',
      );
    }

    for (const hit of definitions) {
      affected.add({ path: hit.path, reason: 'declaration', confidence: 'high', distance: 0 });
      facts.declarationPaths.push(hit.path);
      facts.declarationKinds.push(hit.kind);
    }
    for (const hit of definitions.slice(0, MAX_FILE_TARGET_SYMBOLS)) {
      const record = index
        .symbolsInFile(hit.path)
        .find((entry) => entry.name === hit.name && entry.startLine === hit.startLine);
      if (record !== undefined) symbols.push(toAffectedSymbol(record, 'definition'));
    }
    for (const group of answer.grouped) {
      affected.add({
        path: group.path,
        reason: 'reference',
        confidence: 'medium',
        distance: 0,
        lines: group.lines.slice(0, MAX_LINES_PER_FILE),
      });
    }
    for (const hit of answer.result.results.slice(0, limit)) {
      const record = enclosingSymbol(index, hit.path, hit.line);
      if (record === undefined) continue;
      if (symbols.some((entry) => entry.path === record.path && entry.startLine === record.startLine)) continue;
      symbols.push(toAffectedSymbol(record, 'reference'));
    }
  } else if (targetKind === 'file') {
    const relative = normalizeRelative(input.target) ?? input.target;
    const declared = index.symbolsInFile(relative);
    const importersOfTarget = new Set(reverseImportMap(index).get(relative) ?? []);
    let nameOnlyDropped = 0;
    affected.add({ path: relative, reason: 'target', confidence: 'high', distance: 0 });
    facts.declarationPaths.push(relative);
    if (declared.length === 0) {
      notes.push(
        `no declarations are indexed in ${relative}: it may be unsupported, excluded, or contain only statements`,
      );
    }
    for (const record of declared.slice(0, MAX_FILE_TARGET_SYMBOLS)) {
      symbols.push(toAffectedSymbol(record, 'definition'));
    }
    for (const record of declared.slice(0, MAX_FILE_TARGET_SYMBOLS)) {
      const answer = await index.findReferences(record.name, { limit: DEFAULT_REFERENCE_LIMIT });
      if (answer.result.truncated) facts.truncated = true;
      // A file target matches a declaration *name*, not a receiver type. Generic member names
      // (`__init__`, `forward`) are declared all over a project, so `super().__init__()` in an
      // unrelated module was counted as a reference to this file and inflated the blast radius
      // (Phase 10 real-project run). A hit counts when the referencing file imports the target,
      // or when the name is declared exactly once in the workspace; everything else is counted
      // and reported, never silently dropped.
      const ambiguous =
        index.findSymbols(record.name, { limit: 1, caseSensitive: true }).total > 1;
      let kept = 0;
      for (const group of answer.grouped) {
        if (group.path === relative) continue;
        const importAdjacent = importersOfTarget.has(group.path);
        if (!importAdjacent && ambiguous) {
          nameOnlyDropped += 1;
          continue;
        }
        kept += group.count;
        facts.referenceFiles += 1;
        affected.add({
          path: group.path,
          reason: 'reference',
          confidence: importAdjacent ? 'high' : 'medium',
          distance: 0,
          lines: group.lines.slice(0, MAX_LINES_PER_FILE),
        });
      }
      facts.referenceCount += kept;
    }
    if (nameOnlyDropped > 0) {
      notes.push(
        `${nameOnlyDropped} name-only match(es) dropped: they share a declaration name with ${relative} but do not import it, and that name is declared in more than one file (generic members such as __init__ or forward match everywhere)`,
      );
    }
  } else {
    const prefix = `${(normalizeRelative(input.target) ?? input.target).replace(/\/+$/, '')}/`;
    const members = index.filePaths().filter((filePath) => filePath.startsWith(prefix));
    const shown = members.slice(0, MAX_DIRECTORY_MEMBERS);
    if (members.length > shown.length) {
      facts.truncated = true;
      notes.push(
        `${members.length} files live under ${prefix}: only the first ${shown.length} were expanded (raise limit or target the files that matter)`,
      );
    }
    for (const member of shown) {
      affected.add({ path: member, reason: 'directory_member', confidence: 'high', distance: 0 });
      for (const record of index.symbolsInFile(member)) {
        if (symbols.length >= MAX_DIRECTORY_MEMBERS) break;
        symbols.push(toAffectedSymbol(record, 'definition'));
      }
    }
    facts.declarationPaths.push(...shown);
  }

  /* Import hops: importers of the direct files, up to `depth`. */
  const reverse = reverseImportMap(index);
  const forward = forwardImportMap(index);
  let frontier = [...new Set([...facts.declarationPaths, ...affected.values().map((file) => file.path)])];
  for (let hop = 1; hop <= depth; hop += 1) {
    const next: string[] = [];
    for (const filePath of frontier) {
      for (const importer of reverse.get(filePath) ?? []) {
        if (affected.has(importer)) continue;
        affected.add({
          path: importer,
          reason: targetKind === 'directory' ? 'dependency' : 'importer',
          confidence: hop === 1 ? 'high' : 'medium',
          distance: hop,
          detail: `imports ${filePath}`,
        });
        next.push(importer);
      }
    }
    if (next.length === 0) break;
    frontier = next;
  }

  /* Tests: the affected files that are tests, plus the imports of the declaration file. */
  const relatedTests = new Set<string>();
  for (const file of affected.values()) {
    if (isTestPath(file.path)) relatedTests.add(file.path);
  }
  for (const declarationPath of facts.declarationPaths.slice(0, 5)) {
    for (const importer of reverse.get(declarationPath) ?? []) {
      if (isTestPath(importer)) relatedTests.add(importer);
    }
    for (const dependency of forward.get(declarationPath) ?? []) {
      if (isTestPath(dependency)) relatedTests.add(dependency);
    }
  }

  let files = affected.values();
  const testsExcluded: string[] = [];
  if (!includeTests) {
    for (const file of files) {
      if (relatedTests.has(file.path)) testsExcluded.push(file.path);
    }
    files = files.filter((file) => !relatedTests.has(file.path));
  } else {
    // Test files are added only when nothing else already explains them: `reason` answers
    // "why is this file in the affected set", so a test file that references the target keeps
    // `reference` rather than being relabelled. Test-ness is carried by `relatedTests`.
    for (const testFile of relatedTests) {
      if (affected.has(testFile)) continue;
      affected.add({ path: testFile, reason: 'test', confidence: 'high', distance: 0 });
    }
    files = affected.values();
  }
  if (testsExcluded.length > 0) {
    notes.push(
      `includeTests is false: ${testsExcluded.length} test file(s) are excluded from affectedFiles but listed in relatedTests`,
    );
  }

  files.sort((a, b) => (a.distance === b.distance ? (a.path < b.path ? -1 : 1) : a.distance - b.distance));
  facts.totalAffected = files.length;
  const page = files.slice(0, limit);
  if (files.length > page.length) {
    facts.truncated = true;
    notes.push(`affected file list truncated at ${page.length} of ${files.length}`);
  }

  const risks = assessRisks({
    facts,
    targetKind,
    declarationPaths: facts.declarationPaths,
    declarationKinds: facts.declarationKinds,
    rawTarget: input.target,
    relatedTests: [...relatedTests],
    reverse,
    forward,
    exactDefinitions: definitions.length,
  });
  const riskLevel = highestRisk(risks);

  const confidence: AffectedConfidence =
    targetKind === 'symbol'
      ? definitions.length === 1
        ? 'high'
        : definitions.length > 1
          ? 'medium'
          : 'low'
      : targetKind === 'file'
        ? index.hasFile(normalizeRelative(input.target) ?? input.target)
          ? 'high'
          : 'low'
        : 'medium';

  notes.push(
    `method heuristic: declarations, references and imports come from lexical extractors, so a receiver-typed call analysis is out of scope`,
  );
  if (targetKind === 'symbol' && input.target.includes('.')) {
    notes.push(
      'the target is qualified: references are matched by member name, so same-named members of unrelated types appear as hits',
    );
  }
  notes.push(
    `depth ${depth}: direct files plus ${depth} import hop(s); raise depth to widen the blast radius, lower it to focus`,
  );
  if (index.indexState !== 'ready') {
    notes.push(`index state is "${index.indexState}": call scan_project or find_symbol first for a complete answer`);
  }

  const result: ImpactResult = {
    target: input.target,
    targetKind,
    method: 'heuristic',
    extractor: 'heuristic-regex',
    confidence,
    affectedFiles: page,
    affectedSymbols: symbols.slice(0, limit * 2),
    relatedTests: [...relatedTests].sort(),
    risks,
    riskLevel,
    notes,
    truncated: facts.truncated,
    totalAffected: facts.totalAffected,
  };
  const first = definitions[0];
  if (first !== undefined) result.definition = toDefinition(first);
  return result;
}

interface RiskInput {
  facts: Facts;
  targetKind: ImpactTargetKind;
  declarationPaths: string[];
  declarationKinds: SymbolKind[];
  rawTarget: string;
  relatedTests: string[];
  reverse: Map<string, string[]>;
  forward: Map<string, string[]>;
  exactDefinitions: number;
}

const TYPE_KINDS: readonly SymbolKind[] = ['class', 'interface', 'enum'];

export function assessRisks(input: RiskInput): ImpactRisk[] {
  const risks: ImpactRisk[] = [];
  const { facts } = input;

  if (facts.referenceCount >= HIGH_REFERENCE_COUNT) {
    risks.push({
      level: 'HIGH',
      reason: `${facts.referenceCount} reference(s) across ${facts.referenceFiles} file(s): every call site must be checked`,
    });
  } else if (facts.referenceCount >= NOTABLE_REFERENCE_COUNT) {
    risks.push({
      level: 'MEDIUM',
      reason: `${facts.referenceCount} reference(s) across ${facts.referenceFiles} file(s)`,
    });
  } else if (facts.referenceCount > 0) {
    risks.push({
      level: 'LOW',
      reason: `${facts.referenceCount} reference(s): a narrow blast radius`,
    });
  }

  if (input.targetKind === 'symbol' && input.exactDefinitions > 1) {
    risks.push({
      level: 'MEDIUM',
      reason: `${input.exactDefinitions} declarations share this name: hits may belong to unrelated scopes`,
    });
  }
  if (input.targetKind === 'symbol' && facts.referenceCount === 0 && input.exactDefinitions === 0) {
    risks.push({
      level: 'LOW',
      reason: 'nothing was found for this name: confirm the spelling before concluding the code is unused',
    });
  }
  if (input.declarationKinds.some((kind) => TYPE_KINDS.includes(kind))) {
    risks.push({
      level: 'MEDIUM',
      reason: 'the target is a type declaration: its shape is part of the API for every caller and subclass',
    });
  }
  if (input.rawTarget.includes('.')) {
    risks.push({
      level: 'LOW',
      reason: 'references are name-matched, not receiver-typed: verify each hit actually calls this member',
    });
  }

  for (const declarationPath of input.declarationPaths.slice(0, 10)) {
    const fanIn = input.reverse.get(declarationPath)?.length ?? 0;
    if (fanIn >= HIGH_FAN_IN) {
      risks.push({
        level: 'HIGH',
        reason: `${declarationPath} is imported by ${fanIn} file(s): a change here reaches much of the project`,
      });
      break;
    }
  }

  for (const declarationPath of input.declarationPaths.slice(0, 10)) {
    const importers = input.reverse.get(declarationPath) ?? [];
    const cyclic = importers.find((importer) => (input.forward.get(declarationPath) ?? []).includes(importer));
    if (cyclic !== undefined) {
      risks.push({
        level: 'MEDIUM',
        reason: `circular import between ${declarationPath} and ${cyclic}: module-load order can change behaviour`,
      });
      break;
    }
  }

  const manifest = input.declarationPaths.find((filePath) =>
    MANIFEST_FILES.has((filePath.split('/').pop() ?? '').toLowerCase()),
  );
  if (manifest !== undefined) {
    risks.push({
      level: 'HIGH',
      reason: `${manifest} is a build/configuration manifest: a change affects the whole project, not one module`,
    });
  }

  if (input.targetKind !== 'directory' && input.relatedTests.length === 0 && facts.referenceCount >= TESTLESS_REFERENCE_COUNT) {
    risks.push({
      level: 'MEDIUM',
      reason: 'no test file references this target: a change here is unverified by the suite',
    });
  }

  risks.sort((a, b) => RISK_ORDER[b.level] - RISK_ORDER[a.level]);
  return risks;
}

function highestRisk(risks: readonly ImpactRisk[]): ImpactRiskLevel {
  let level: ImpactRiskLevel = 'LOW';
  for (const risk of risks) {
    if (RISK_ORDER[risk.level] > RISK_ORDER[level]) level = risk.level;
  }
  return level;
}
