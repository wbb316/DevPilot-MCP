import type { FileLanguage } from '../workspace/file-walker.js';
import type { ReferenceKind, SymbolKind, Visibility } from '../types/code.js';

/**
 * Internal (non-contract) shapes produced by the language parsers. The *public* contract is
 * docs/DATA-MODEL.md §4; these types only move data from a parser into the index.
 */

export interface ParsedSymbol {
  name: string;
  kind: SymbolKind;
  startLine: number;
  endLine: number;
  signature?: string;
  doc?: string;
  visibility?: Visibility;
  parentName?: string;
}

export interface ParsedRef {
  name: string;
  line: number;
  column: number;
  kind: ReferenceKind;
  containerName?: string;
}

export interface ParsedImport {
  raw: string;
  toPath?: string;
  line: number;
}

export interface ParsedFile {
  symbols: ParsedSymbol[];
  refs: ParsedRef[];
  imports: ParsedImport[];
  /** true when the per-file reference cap was hit (never silent). */
  refsTruncated: boolean;
  parseError?: string;
}

export interface ParseContext {
  /** Workspace-relative POSIX path of the file being parsed (import resolution). */
  path?: string;
}

export interface LanguageParser {
  readonly language: FileLanguage;
  parse(text: string, context?: ParseContext): ParsedFile;
}

/** Refs per file. A single generated file must not be able to flood the index. */
export const MAX_REFS_PER_FILE = 800;
/** Symbols per file, same reasoning. */
export const MAX_SYMBOLS_PER_FILE = 2_000;

export function emptyParsed(): ParsedFile {
  return { symbols: [], refs: [], imports: [], refsTruncated: false };
}

/** Dedup + cap collector shared by every language parser. */
export class RefCollector {
  private readonly refs: ParsedRef[] = [];
  private readonly seen = new Set<string>();
  private truncated = false;

  add(ref: ParsedRef): void {
    const key = `${ref.name}\u0000${ref.line}\u0000${ref.column}\u0000${ref.kind}`;
    if (this.seen.has(key)) return;
    if (this.refs.length >= MAX_REFS_PER_FILE) {
      this.truncated = true;
      return;
    }
    this.seen.add(key);
    this.refs.push(ref);
  }

  get all(): readonly ParsedRef[] {
    return this.refs;
  }

  get wasTruncated(): boolean {
    return this.truncated;
  }
}
