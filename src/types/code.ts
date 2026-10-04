/**
 * Code-intelligence types — docs/DATA-MODEL.md §4 (frozen: field names are part of the
 * tool contract, see docs/TOOLS.md Phase 3).
 */

export type SymbolKind =
  | 'class'
  | 'interface'
  | 'enum'
  | 'function'
  | 'method'
  | 'constructor'
  | 'field'
  | 'variable'
  | 'module'
  | 'decorator';

export const SYMBOL_KINDS: readonly SymbolKind[] = [
  'class',
  'interface',
  'enum',
  'function',
  'method',
  'constructor',
  'field',
  'variable',
  'module',
  'decorator',
];

export type ReferenceKind =
  | 'call'
  | 'type'
  | 'import'
  | 'extends'
  | 'implements'
  | 'field'
  | 'text';

export const REFERENCE_KINDS: readonly ReferenceKind[] = [
  'call',
  'type',
  'import',
  'extends',
  'implements',
  'field',
  'text',
];

export type Visibility = 'public' | 'protected' | 'private' | 'package';

export type SearchEngine = 'ast' | 'text';
export type SearchConfidence = 'high' | 'medium' | 'low';

export interface FileRecord {
  id: number;
  path: string;
  language: string;
  sizeBytes: number;
  mtimeMs: number;
  hash: string;
  parsedAt: string;
  parseError?: string;
}

export interface SymbolRecord {
  id: number;
  fileId: number;
  path: string;
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  doc?: string;
  visibility?: Visibility;
  parentName?: string;
}

export interface ReferenceRecord {
  id: number;
  symbolName: string;
  path: string;
  line: number;
  column: number;
  kind: ReferenceKind;
  containerName?: string;
}

export interface ImportEdge {
  fromPath: string;
  toPath?: string;
  raw: string;
  line: number;
}

export interface IndexMeta {
  schemaVersion: number;
  rootHash: string;
  indexedAt: string;
  fileCount: number;
}

export interface SymbolHit {
  name: string;
  kind: SymbolKind;
  path: string;
  startLine: number;
  endLine: number;
  signature?: string;
  doc?: string;
}

export interface ReferenceHit {
  path: string;
  line: number;
  column: number;
  kind: ReferenceKind;
  snippet: string;
  containerName?: string;
}

export interface SearchResult<T> {
  engine: SearchEngine;
  confidence: SearchConfidence;
  truncated: boolean;
  total: number;
  results: T[];
}
