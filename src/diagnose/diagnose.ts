import type { JobRecord } from '../types/execution.js';
import type {
  DiagnosisCategory,
  DiagnosisConfidence,
  DiagnosisLocation,
  DiagnosisResult,
  SuspectFile,
  SuspectReason,
} from '../types/diagnosis.js';
import { EVIDENCE_NOISE, EVIDENCE_PATTERN, classifyFailure, hintFor } from './patterns.js';
import { extractLocations } from './location.js';
import type { LocationScanOptions } from './location.js';

/**
 * Diagnosis pipeline (docs/ARCHITECTURE.md §4.7): classify → locate → collect evidence →
 * name suspects. DevPilot never claims to have found the bug; it hands the agent the
 * structure, and `confidence` is stated rather than implied.
 */

export const MAX_EVIDENCE_LINE = 400;
export const DEFAULT_MAX_EVIDENCE = 8;
export const DEFAULT_MAX_SUSPECTS = 12;

export interface AnalyzeOptions {
  maxEvidence?: number;
  maxLocations?: number;
  /** How to verify frames against the workspace (Phase 10: bare JVM file names, unicode paths). */
  locationOptions?: LocationScanOptions;
}

export interface FailureAnalysis {
  category: DiagnosisCategory;
  weight: 'strong' | 'weak';
  locations: DiagnosisLocation[];
  externalFrames: number;
  /** Frames naming files that resolved nowhere in the workspace (dependency or JDK code). */
  unresolvedFrames: number;
  evidence: string[];
  evidenceDropped: number;
}

/** Evidence lines: the error/exception/assert/stack lines, deduplicated and bounded. */
export function collectEvidence(text: string, max: number): { evidence: string[]; dropped: number } {
  const evidence: string[] = [];
  let dropped = 0;
  let previous = '';
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '') continue;
    if (!EVIDENCE_PATTERN.test(line)) continue;
    if (EVIDENCE_NOISE.test(line)) continue;
    if (line === previous) continue;
    previous = line;
    if (evidence.length >= max) {
      dropped += 1;
      continue;
    }
    evidence.push(line.length > MAX_EVIDENCE_LINE ? `${line.slice(0, MAX_EVIDENCE_LINE)}…` : line);
  }
  return { evidence, dropped };
}

export function analyzeFailure(text: string, root: string, options: AnalyzeOptions = {}): FailureAnalysis {
  const match = classifyFailure(text);
  const scan = extractLocations(
    text,
    root,
    options.maxLocations ?? 8,
    options.locationOptions ?? {},
  );
  const collected = collectEvidence(text, options.maxEvidence ?? DEFAULT_MAX_EVIDENCE);
  return {
    category: match.category,
    weight: match.weight,
    locations: scan.locations,
    externalFrames: scan.externalFrames,
    unresolvedFrames: scan.unresolvedFrames,
    evidence: collected.evidence,
    evidenceDropped: collected.dropped,
  };
}

export function confidenceOf(
  category: DiagnosisCategory,
  weight: 'strong' | 'weak',
  hasLocation: boolean,
): DiagnosisConfidence {
  if (category === 'UNKNOWN') return 'low';
  if (weight === 'strong') return hasLocation ? 'high' : 'medium';
  return hasLocation ? 'medium' : 'low';
}

export interface SuspectInput {
  locations: readonly DiagnosisLocation[];
  changedFiles?: readonly string[];
  importersOf?: (relativePath: string) => readonly string[];
  maxSuspects?: number;
}

/**
 * Suspect files, most specific first: files in the stack, then working-tree changes, then
 * files that import a stack file. A file only carries the strongest reason that named it.
 */
export function collectSuspects(input: SuspectInput): SuspectFile[] {
  const out: SuspectFile[] = [];
  const seen = new Set<string>();
  const add = (filePath: string, reason: SuspectReason): void => {
    const key = filePath.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ path: filePath, reason });
  };

  for (const location of input.locations) add(location.path, 'in_stack');
  for (const file of input.changedFiles ?? []) {
    // DevPilot's own workspace data (`.devpilot/`) is rewritten by nearly every tool call, so
    // it always looks "recently changed": it must never be reported as a suspect (Phase 10
    // real-project run listed it, and every entry crowded out a relevant one).
    const normalized = file.replace(/\\/g, '/');
    if (normalized === '.devpilot' || normalized.startsWith('.devpilot/')) continue;
    add(file, 'recently_changed');
  }
  if (input.importersOf !== undefined) {
    for (const location of input.locations) {
      for (const importer of input.importersOf(location.path)) add(importer, 'import_related');
    }
  }

  return out.slice(0, input.maxSuspects ?? DEFAULT_MAX_SUSPECTS);
}

export interface BuildDiagnosisInput {
  analysis: FailureAnalysis;
  /** Command output, used for the honesty notes about an empty log. */
  text: string;
  job?: JobRecord;
  logFile?: string;
  changedFiles?: readonly string[];
  importersOf?: (relativePath: string) => readonly string[];
  maxSuspects?: number;
  /** Caller-supplied evidence (e.g. the source line at the primary location). */
  extraEvidence?: readonly string[];
  extraNotes?: readonly string[];
}

export function buildDiagnosis(input: BuildDiagnosisInput): DiagnosisResult {
  const { analysis } = input;
  const primary = analysis.locations[0];
  const evidence = [...(input.extraEvidence ?? []), ...analysis.evidence];

  const notes: string[] = [];
  if (input.text.trim() === '') notes.push('the captured output was empty — nothing to classify');
  if (primary === undefined && analysis.category !== 'UNKNOWN') {
    notes.push('no workspace-relative source location was found in the output');
  }
  if (analysis.externalFrames > 0) {
    notes.push(
      `${analysis.externalFrames} stack frame(s) pointed outside the workspace (dependency or runtime code) and were ignored`,
    );
  }
  if (analysis.unresolvedFrames > 0) {
    notes.push(
      `${analysis.unresolvedFrames} stack frame(s) named a file that is not in this workspace (dependency or JDK code); they are listed after the workspace locations`,
    );
  }
  if (analysis.evidenceDropped > 0) {
    notes.push(`${analysis.evidenceDropped} further matching line(s) omitted — raise maxEvidence to see them`);
  }
  if (input.extraNotes !== undefined) notes.push(...input.extraNotes);

  const result: DiagnosisResult = {
    category: analysis.category,
    confidence: confidenceOf(analysis.category, analysis.weight, primary !== undefined),
    evidence,
    suspectFiles: collectSuspects({
      locations: analysis.locations,
      ...(input.changedFiles === undefined ? {} : { changedFiles: input.changedFiles }),
      ...(input.importersOf === undefined ? {} : { importersOf: input.importersOf }),
      ...(input.maxSuspects === undefined ? {} : { maxSuspects: input.maxSuspects }),
    }),
    hint: hintFor(analysis.category),
  };
  if (primary !== undefined) result.location = primary;
  if (input.job !== undefined) {
    result.relatedJob = {
      jobId: input.job.jobId,
      // The ledger stores the executable and its argv separately; a report needs one command line.
      command: [input.job.command, ...(input.job.args ?? [])].join(' ').trim(),
      exitCode: input.job.exitCode ?? null,
    };
  }
  if (input.logFile !== undefined) result.logFile = input.logFile;
  if (notes.length > 0) result.notes = notes;
  return result;
}
