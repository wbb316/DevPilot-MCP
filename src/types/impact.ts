import type { SymbolKind } from './code.js';

/**
 * Impact analysis types (docs/TOOLS.md Phase 8, docs/DATA-MODEL.md §6).
 *
 * `method` is `'heuristic'` for this build: the extractors behind the symbol index are
 * lexical/regex based, never a compiler. The field exists so an agent can tell a lexical
 * answer from a future AST-backed one without guessing.
 */

export type ImpactTargetKind = 'symbol' | 'file' | 'directory';
export type ImpactMethod = 'ast' | 'heuristic';
export type ImpactRiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';
export type AffectedConfidence = 'high' | 'medium' | 'low';

/**
 * Why a file is in the affected set.
 *  - `declaration`  the file that declares the target symbol
 *  - `target`       the file/directory asked about itself
 *  - `reference`    contains a reference to the target
 *  - `importer`     imports an affected file (distance > 0 hops)
 *  - `dependency`   imported by an affected file (downstream of a file target)
 *  - `test`         a test file in the affected set
 *  - `directory_member` lives inside the target directory
 */
export type AffectedReason =
  | 'declaration'
  | 'target'
  | 'reference'
  | 'importer'
  | 'dependency'
  | 'test'
  | 'directory_member';

export interface AffectedFile {
  path: string;
  reason: AffectedReason;
  confidence: AffectedConfidence;
  /** Import hops from the target: 0 = direct, 1 = direct importer, … */
  distance: number;
  detail?: string;
  /** Reference line numbers in this file (first 20). */
  lines?: number[];
}

export interface AffectedSymbol {
  name: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  endLine: number;
  /** `definition` = the target itself (or a declaration), `reference` = an enclosing scope of a use. */
  reason: 'definition' | 'reference';
  signature?: string;
}

export interface ImpactRisk {
  level: ImpactRiskLevel;
  reason: string;
}

export interface ImpactDefinition {
  name: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  endLine: number;
  signature?: string;
}

export interface ImpactResult {
  target: string;
  targetKind: ImpactTargetKind;
  method: ImpactMethod;
  /** How the extractors work, stated explicitly so nobody reads this as compiler output. */
  extractor: string;
  confidence: AffectedConfidence;
  definition?: ImpactDefinition;
  affectedFiles: AffectedFile[];
  affectedSymbols: AffectedSymbol[];
  relatedTests: string[];
  risks: ImpactRisk[];
  riskLevel: ImpactRiskLevel;
  notes: string[];
  truncated: boolean;
  totalAffected: number;
}
