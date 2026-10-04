import type { FileLanguage } from '../workspace/file-walker.js';

/**
 * Text helpers shared by the language parsers. Everything here is offline and
 * side-effect free: the parsers get a *masked* copy of the source (comments and string
 * bodies blanked to spaces, newlines preserved) so that a `#` inside a string or a brace
 * inside a comment cannot skew structure detection, while every offset — and therefore
 * every reported line/column — still refers to the original file.
 */

export interface Position {
  line: number;
  column: number;
}

interface MaskRules {
  lineComment: string;
  blockComment: boolean;
  tripleQuote: boolean;
  templateLiteral: boolean;
}

function rulesFor(language: FileLanguage): MaskRules {
  switch (language) {
    case 'python':
      return {
        lineComment: '#',
        blockComment: false,
        tripleQuote: true,
        templateLiteral: false,
      };
    case 'java':
    case 'kotlin':
    case 'c':
    case 'cpp':
    case 'csharp':
    case 'go':
    case 'rust':
    case 'typescript':
    case 'javascript':
      return {
        lineComment: '//',
        blockComment: true,
        tripleQuote: false,
        templateLiteral: language === 'typescript' || language === 'javascript',
      };
    default:
      return { lineComment: '//', blockComment: true, tripleQuote: false, templateLiteral: false };
  }
}

/** Byte offsets at which each line starts (line 1 is index 0). */
export function lineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1);
  }
  return starts;
}

/** 1-based line/column of an absolute offset. */
export function positionAt(starts: readonly number[], offset: number): Position {
  let low = 0;
  let high = starts.length - 1;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if ((starts[mid] ?? 0) <= offset) low = mid;
    else high = mid - 1;
  }
  return { line: low + 1, column: offset - (starts[low] ?? 0) + 1 };
}

/**
 * True when the quote at `index` opens a Python f-string, i.e. the prefix letters directly
 * before it contain `f` and are not the tail of an identifier (`myf"x"` is not a f-string).
 */
function isFStringPrefix(text: string, index: number): boolean {
  let k = index - 1;
  let letters = 0;
  while (k >= 0 && letters < 3 && /[rRbBuUfF]/.test(text[k] as string)) {
    k -= 1;
    letters += 1;
  }
  if (letters === 0) return false;
  const prefix = text.slice(k + 1, index).toLowerCase();
  if (!prefix.includes('f')) return false;
  const before = k >= 0 ? (text[k] as string) : '';
  return before === '' || !/[\w.\])\]]/.test(before);
}

/** Index just past a string literal that starts at `start` (quote or triple quote). */
function skipStringLiteral(text: string, start: number): number {
  const quote = text[start] as string;
  const triple = text.startsWith(quote.repeat(3), start);
  const q = triple ? quote.repeat(3) : quote;
  const n = text.length;
  let j = start + q.length;
  while (j < n) {
    const c = text[j] as string;
    if (c === '\\') {
      j += 2;
      continue;
    }
    if (text.startsWith(q, j)) return j + q.length;
    if (c === '\n' && !triple) return j;
    j += 1;
  }
  return n;
}

/**
 * Walk one `{...}` / `${...}` field and record the spans that are *code*. Nested string
 * literals are skipped, because their bodies are still not code.
 */
function scanField(
  text: string,
  start: number,
  open: string,
  close: string,
  spans: Array<[number, number]>,
): number {
  const n = text.length;
  let depth = 1;
  let j = start;
  let segmentStart = start;
  while (j < n) {
    const c = text[j] as string;
    if (c === '"' || c === "'" || c === '`') {
      if (j > segmentStart) spans.push([segmentStart, j]);
      j = skipStringLiteral(text, j);
      segmentStart = j;
      continue;
    }
    if (c === open) {
      depth += 1;
      j += 1;
      continue;
    }
    if (c === close) {
      depth -= 1;
      if (depth === 0) {
        if (j > segmentStart) spans.push([segmentStart, j]);
        return j + 1;
      }
      j += 1;
      continue;
    }
    j += 1;
  }
  if (j > segmentStart) spans.push([segmentStart, j]);
  return -1;
}

function pythonInterpolationSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    const ch = text[i] as string;
    if (ch !== '"' && ch !== "'") {
      i += 1;
      continue;
    }
    if (!isFStringPrefix(text, i)) {
      i += 1;
      continue;
    }
    const triple = text.startsWith(ch.repeat(3), i);
    const quote = triple ? ch.repeat(3) : ch;
    let j = i + quote.length;
    while (j < n) {
      if (text.startsWith(quote, j)) {
        j += quote.length;
        break;
      }
      const c = text[j] as string;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '{') {
        if (text[j + 1] === '{') {
          j += 2;
          continue;
        }
        const end = scanField(text, j + 1, '{', '}', spans);
        j = end === -1 ? n : end;
        continue;
      }
      if (c === '}' && text[j + 1] === '}') {
        j += 2;
        continue;
      }
      j += 1;
    }
    i = j;
  }
  return spans;
}

function templateInterpolationSpans(text: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  const n = text.length;
  let i = 0;
  while (i < n) {
    if (text[i] !== '`') {
      i += 1;
      continue;
    }
    let j = i + 1;
    while (j < n) {
      const c = text[j] as string;
      if (c === '\\') {
        j += 2;
        continue;
      }
      if (c === '`') {
        j += 1;
        break;
      }
      if (c === '$' && text[j + 1] === '{') {
        const end = scanField(text, j + 2, '{', '}', spans);
        j = end === -1 ? n : end;
        continue;
      }
      j += 1;
    }
    i = j;
  }
  return spans;
}

/**
 * Code that lives *inside* a string literal: Python f-string `{...}` fields and JS/TS
 * template-literal `${...}` substitutions. Masking the whole literal hides real calls —
 * the Phase 10 real-project run lost `f"{service.average_price('input'):.2f}"` entirely, so
 * these spans are restored by `maskNonCode` after the blanking pass.
 */
function interpolationSpans(text: string, language: FileLanguage): Array<[number, number]> {
  if (language === 'python') return pythonInterpolationSpans(text);
  if (language === 'typescript' || language === 'javascript') return templateInterpolationSpans(text);
  return [];
}

export function maskNonCode(text: string, language: FileLanguage): string {
  const rules = rulesFor(language);
  const out = text.split('');
  const n = text.length;

  const blank = (from: number, toExclusive: number): void => {
    for (let i = from; i < toExclusive && i < n; i += 1) {
      const ch = text[i];
      if (ch !== '\n' && ch !== '\r') out[i] = ' ';
    }
  };

  let i = 0;
  while (i < n) {
    const ch = text[i] as string;

    if (rules.lineComment !== '' && text.startsWith(rules.lineComment, i)) {
      let j = i;
      while (j < n && text[j] !== '\n') j += 1;
      blank(i, j);
      i = j;
      continue;
    }

    if (rules.blockComment && text.startsWith('/*', i)) {
      let j = i + 2;
      while (j < n && !text.startsWith('*/', j)) j += 1;
      j = Math.min(j + 2, n);
      blank(i, j);
      i = j;
      continue;
    }

    if (rules.tripleQuote && (text.startsWith('"""', i) || text.startsWith("'''", i))) {
      const quote = text.slice(i, i + 3);
      let j = i + 3;
      while (j < n && !text.startsWith(quote, j)) j += 1;
      j = Math.min(j + 3, n);
      blank(i, j);
      i = j;
      continue;
    }

    if (ch === '"' || ch === "'" || (rules.templateLiteral && ch === '`')) {
      let j = i + 1;
      while (j < n) {
        const c = text[j] as string;
        if (c === '\\') {
          j += 2;
          continue;
        }
        if (c === '\n' && ch !== '`') break;
        if (c === ch) {
          j += 1;
          break;
        }
        j += 1;
      }
      blank(i, Math.min(j, n));
      i = Math.min(j, n);
      continue;
    }

    i += 1;
  }

  // Give the code inside interpolations back: it was masked with its literal, but it is code.
  for (const [from, to] of interpolationSpans(text, language)) {
    for (let k = from; k < to; k += 1) {
      const ch = text[k];
      if (ch !== '\n' && ch !== '\r') out[k] = ch as string;
    }
  }

  return out.join('');
}

export interface BraceDepths {
  /** Brace depth before the line starts. */
  before: number[];
  /** Brace depth after the whole line has been consumed. */
  after: number[];
}

/** Brace depth per line, computed on masked text so strings/comments cannot confuse it. */
export function computeBraceDepths(masked: string): BraceDepths {
  const before: number[] = [];
  const after: number[] = [];
  let depth = 0;
  let lineDepthAtStart = 0;
  before.push(0);
  for (let i = 0; i < masked.length; i += 1) {
    const ch = masked[i];
    if (ch === '{') depth += 1;
    else if (ch === '}') depth = Math.max(0, depth - 1);
    else if (ch === '\n') {
      after.push(depth);
      lineDepthAtStart = depth;
      before.push(lineDepthAtStart);
    }
  }
  after.push(depth);
  return { before, after };
}

/**
 * End line (1-based) of the block that opens on `lineIndex` (0-based), i.e. the first
 * following line whose depth drops back to the depth that preceded the declaration.
 */
export function findBlockEndLine(depths: BraceDepths, lineIndex: number): number {
  const outer = depths.before[lineIndex] ?? 0;
  for (let i = lineIndex; i < depths.after.length; i += 1) {
    if (i > lineIndex && (depths.after[i] ?? 0) <= outer) return i + 1;
  }
  return depths.after.length;
}

export function indentWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    if (ch === ' ') width += 1;
    else if (ch === '\t') width += 4;
    else break;
  }
  return width;
}

export function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** First docstring/leading-comment line belonging to a declaration, if any. */
export function pythonDocLine(rawLines: readonly string[], declLineIndex: number): string | undefined {
  for (let i = declLineIndex + 1; i < rawLines.length && i <= declLineIndex + 6; i += 1) {
    const raw = (rawLines[i] ?? '').trim();
    if (raw === '') continue;
    const match = /^(?:[rRuUbBfF]{0,2})("""|''')([\s\S]*)$/.exec(raw);
    if (match === null) return undefined;
    const quote = match[1] as string;
    const rest = match[2] ?? '';
    const close = rest.indexOf(quote);
    const body = close === -1 ? rest : rest.slice(0, close);
    const line = body.split('\n')[0]?.trim() ?? '';
    return line === '' ? undefined : line;
  }
  return undefined;
}

/** Join continuation lines until parentheses balance (for multi-line signatures). */
export function joinBalanced(
  rawLines: readonly string[],
  startLineIndex: number,
  maxLines = 12,
): { text: string; consumed: number } {
  let text = rawLines[startLineIndex] ?? '';
  let consumed = 0;
  const balance = (value: string): number => {
    let depth = 0;
    for (const ch of value) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
    }
    return depth;
  };
  while (balance(text) > 0 && startLineIndex + consumed + 1 < rawLines.length && consumed < maxLines) {
    consumed += 1;
    text += ` ${rawLines[startLineIndex + consumed] ?? ''}`;
  }
  return { text: collapseWhitespace(text), consumed };
}
