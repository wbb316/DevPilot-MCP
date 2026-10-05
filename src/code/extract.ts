import type { FileLanguage } from '../workspace/file-walker.js';
import type { LanguageParser, ParseContext, ParsedFile } from './parsed.js';
import { emptyParsed } from './parsed.js';
import { javaParser } from './lang/java.js';
import { javascriptParser, typescriptParser } from './lang/javascript.js';
import { pythonParser } from './lang/python.js';

/**
 * Language parser dispatch (docs/ROADMAP.md Phase 3). A language without a parser is
 * skipped by the index and reported as such — never silently "indexed" as zero symbols.
 */

/**
 * Extraction-rule version. Bump whenever a parser or the shared masking changes *what* is
 * extracted: the index cache is otherwise keyed by mtime+size only and would keep serving
 * results produced by an older rule set (Phase 10: the f-string fix needed this to take effect
 * on an already-indexed workspace).
 */
export const EXTRACTOR_VERSION = 3;

const PARSERS: Record<string, LanguageParser> = {
  python: pythonParser,
  java: javaParser,
  typescript: typescriptParser,
  javascript: javascriptParser,
};

/** Languages this build can extract symbols from. */
export const INDEXABLE_LANGUAGES: readonly FileLanguage[] = Object.keys(PARSERS) as FileLanguage[];

export function parserFor(language: string): LanguageParser | undefined {
  return PARSERS[language];
}

export function supportsLanguage(language: string): boolean {
  return PARSERS[language] !== undefined;
}

/**
 * Parse one file. A parser crash is contained to that file: the returned ParsedFile carries
 * `parseError` and every other file still indexes.
 */
export function extractFile(
  language: string,
  text: string,
  context?: ParseContext,
): ParsedFile | undefined {
  const parser = parserFor(language);
  if (parser === undefined) return undefined;
  try {
    const parsed = parser.parse(text, context);
    return parsed;
  } catch (error) {
    const parsed = emptyParsed();
    parsed.parseError = error instanceof Error ? error.message : String(error);
    return parsed;
  }
}
