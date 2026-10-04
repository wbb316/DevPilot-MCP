/**
 * Diagnosis types (docs/DATA-MODEL.md §6).
 *
 * `DiagnosisResult` is the agent-facing shape of `diagnose_failure`: a category it can branch
 * on, a location it can open, a handful of evidence lines it can reason about, and the files
 * worth looking at first. Never the full log — that stays in `logFile`.
 */

export const DIAGNOSIS_CATEGORIES = [
  'CUDA_OUT_OF_MEMORY',
  'SYSTEM_OUT_OF_MEMORY',
  'NULL_POINTER',
  'IMPORT_ERROR',
  'SYNTAX_ERROR',
  'TYPE_ERROR',
  'NAME_ERROR',
  'KEY_ERROR',
  'ASSERTION_FAILED',
  'TEST_FAILED',
  'COMPILE_ERROR',
  'DEPENDENCY_ERROR',
  'PORT_IN_USE',
  'PERMISSION_DENIED',
  'FILE_NOT_FOUND',
  'ENCODING_ERROR',
  'NETWORK_ERROR',
  'TIMEOUT',
  'CONFIG_ERROR',
  'GIT_ERROR',
  'UNKNOWN',
] as const;

export type DiagnosisCategory = (typeof DIAGNOSIS_CATEGORIES)[number];

export type DiagnosisConfidence = 'high' | 'medium' | 'low';

export interface DiagnosisLocation {
  /** Workspace-relative POSIX path when the location resolves inside the workspace. */
  path: string;
  line?: number;
  column?: number;
}

export type SuspectReason = 'recently_changed' | 'in_stack' | 'import_related';

export interface SuspectFile {
  path: string;
  reason: SuspectReason;
}

export interface DiagnosisJobRef {
  jobId: string;
  command: string;
  exitCode: number | null;
}

export interface DiagnosisResult {
  category: DiagnosisCategory;
  confidence: DiagnosisConfidence;
  location?: DiagnosisLocation;
  /** Key lines only (bounded by `maxEvidence`), in the order they appeared. */
  evidence: string[];
  suspectFiles: SuspectFile[];
  relatedJob?: DiagnosisJobRef;
  hint?: string;
  logFile?: string;
  /** Honest notes: missing log, truncated evidence, unresolved locations. */
  notes?: string[];
  /** How many additional matching lines were dropped by the evidence cap. */
  evidenceDropped?: number;
}
