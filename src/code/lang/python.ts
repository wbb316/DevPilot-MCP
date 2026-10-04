import type {
  LanguageParser,
  ParseContext,
  ParsedFile,
  ParsedImport,
  ParsedRef,
  ParsedSymbol,
} from '../parsed.js';
import { RefCollector, emptyParsed } from '../parsed.js';
import {
  collapseWhitespace,
  indentWidth,
  joinBalanced,
  lineStarts,
  maskNonCode,
  positionAt,
  pythonDocLine,
} from '../text-utils.js';
import type { Visibility } from '../../types/code.js';

/**
 * Python parser (docs/ROADMAP.md Phase 3). Indentation-driven block tracking, so end lines
 * are real scope endings rather than guesses; references are limited to meaningful shapes
 * (calls, keyword-argument-free attribute calls, `self.x` fields, imports, base classes,
 * decorators) instead of every identifier occurrence.
 */

const PY_KEYWORDS = new Set([
  'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del', 'elif',
  'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda',
  'nonlocal', 'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield', 'match',
  'case', 'None', 'True', 'False', 'self', 'cls', 'print', 'len', 'range',
]);

const CLASS_RE = /^(\s*)class\s+([A-Za-z_]\w*)\s*(\(([^)]*)\))?\s*:/;
const DEF_RE = /^(\s*)(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(([^)]*)\)?\s*(?:->\s*([^:]+))?\s*:/;
const IMPORT_RE = /^(\s*)import\s+(.+?)\s*$/;
const FROM_IMPORT_RE = /^(\s*)from\s+([.\w]*)\s+import\s+(.+?)\s*$/;
const ASSIGN_RE = /^(\s*)([A-Za-z_]\w*)\s*(?::\s*[^=]+)?=(?!=)(.*)$/;
const SELF_FIELD_RE = /\b(?:self|cls)\.([A-Za-z_]\w*)/g;
const CALL_RE = /(^|[^\w.$])([A-Za-z_]\w*)\s*\(/g;
const ATTR_CALL_RE = /\.([A-Za-z_]\w*)\s*\(/g;
const DECORATOR_RE = /^\s*@([A-Za-z_][\w.]*)/;

interface Block {
  indent: number;
  kind: 'class' | 'function' | 'method';
  name: string;
  symbol: ParsedSymbol;
  lastCodeLine: number;
}

function visibilityOf(name: string): Visibility {
  if (name.startsWith('__') && name.endsWith('__')) return 'public';
  return name.startsWith('_') ? 'private' : 'public';
}

function moduleToPath(module: string): string | undefined {
  if (module === '') return undefined;
  if (module.startsWith('.')) {
    const level = /^\.+/.exec(module)?.[0].length ?? 0;
    const rest = module.slice(level).replace(/\./g, '/');
    const up = '../'.repeat(Math.max(0, level - 1));
    return rest === '' ? undefined : `${up}${rest}.py`;
  }
  return `${module.replace(/\./g, '/')}.py`;
}

function parse(text: string, _context?: ParseContext): ParsedFile {
  const parsed = emptyParsed();
  const collector = new RefCollector();
  const starts = lineStarts(text);
  const masked = maskNonCode(text, 'python');
  const codeLines = masked.split('\n');
  const rawLines = text.split('\n');
  const stack: Block[] = [];

  const pushRef = (name: string, offset: number, kind: ParsedRef['kind'], containerName?: string): void => {
    const position = positionAt(starts, offset);
    const ref: ParsedRef = { name, line: position.line, column: position.column, kind };
    if (containerName !== undefined) ref.containerName = containerName;
    collector.add(ref);
  };

  for (let i = 0; i < codeLines.length; i += 1) {
    const code = codeLines[i] ?? '';
    const raw = rawLines[i] ?? '';
    const trimmed = code.trim();
    if (trimmed === '') continue;

    const indent = indentWidth(code);

    // Close every block this line is not inside of.
    while (stack.length > 0 && indent <= (stack[stack.length - 1] as Block).indent) {
      const block = stack.pop() as Block;
      block.symbol.endLine = Math.max(block.symbol.startLine, block.lastCodeLine);
    }

    const parent = stack.length > 0 ? (stack[stack.length - 1] as Block) : undefined;
    const container = parent?.name;
    let declarationNameOffset = -1;

    const decorator = DECORATOR_RE.exec(code);
    if (decorator?.[1] !== undefined) {
      const dot = decorator[1].lastIndexOf('.');
      const name = dot === -1 ? decorator[1] : decorator[1].slice(dot + 1);
      pushRef(name, starts[i]! + code.indexOf(decorator[1]), 'text', container);
    }

    const classMatch = CLASS_RE.exec(code);
    const defMatch = classMatch === null ? DEF_RE.exec(code) : null;

    if (classMatch !== null) {
      const name = classMatch[2] as string;
      const bases = (classMatch[4] ?? '').trim();
      const signature = collapseWhitespace(raw.trim());
      const symbol: ParsedSymbol = {
        name,
        kind: 'class',
        startLine: i + 1,
        endLine: i + 1,
        signature,
        visibility: visibilityOf(name),
      };
      const doc = pythonDocLine(rawLines, i);
      if (doc !== undefined) symbol.doc = doc;
      if (container !== undefined) symbol.parentName = container;
      parsed.symbols.push(symbol);
      stack.push({ indent, kind: 'class', name, symbol, lastCodeLine: i + 1 });

      if (bases !== '') {
        const baseOffset = code.indexOf(bases);
        for (const rawBase of bases.split(',')) {
          const base = rawBase.trim();
          if (base === '' || base.includes('=')) continue;
          const dot = base.lastIndexOf('.');
          const baseName = (dot === -1 ? base : base.slice(dot + 1)).replace(/\[.*$/, '');
          if (!/^[A-Za-z_]\w*$/.test(baseName)) continue;
          pushRef(baseName, starts[i]! + baseOffset, 'extends', name);
        }
      }
    } else if (defMatch !== null) {
      const name = defMatch[2] as string;
      declarationNameOffset = starts[i]! + code.indexOf(`def ${name}`) + 4;
      const joined = joinBalanced(rawLines, i);
      const returnType = (defMatch[4] ?? '').trim();
      const signature =
        returnType === ''
          ? collapseWhitespace(joined.text.replace(/\s*:\s*$/, ''))
          : collapseWhitespace(joined.text.replace(/\s*:\s*$/, ''));
      const kind: ParsedSymbol['kind'] = parent?.kind === 'class' ? 'method' : 'function';
      const symbol: ParsedSymbol = {
        name,
        kind,
        startLine: i + 1,
        endLine: i + 1,
        signature,
        visibility: visibilityOf(name),
      };
      const doc = pythonDocLine(rawLines, i);
      if (doc !== undefined) symbol.doc = doc;
      if (container !== undefined) symbol.parentName = container;
      parsed.symbols.push(symbol);
      stack.push({ indent, kind: kind === 'method' ? 'method' : 'function', name, symbol, lastCodeLine: i + 1 });
    } else {
      const importMatch = IMPORT_RE.exec(code);
      const fromMatch = importMatch === null ? FROM_IMPORT_RE.exec(code) : null;

      if (importMatch !== null) {
        const body = importMatch[2] as string;
        const entry: ParsedImport = { raw: collapseWhitespace(raw), line: i + 1 };
        const first = body.split(',')[0]?.trim() ?? '';
        const moduleName = first.split(/\s+as\s+/)[0]?.trim() ?? '';
        const toPath = moduleToPath(moduleName);
        if (toPath !== undefined) entry.toPath = toPath;
        parsed.imports.push(entry);
        for (const part of body.split(',')) {
          const item = part.trim().split(/\s+as\s+/);
          const module = item[0]?.trim() ?? '';
          if (module === '') continue;
          const alias = item[1]?.trim();
          const segments = module.split('.');
          const lastName = (alias ?? segments[segments.length - 1] ?? '').replace(/[^\w]/g, '');
          if (lastName === '') continue;
          pushRef(lastName, starts[i]! + code.indexOf(module), 'import', container);
        }
      } else if (fromMatch !== null) {
        const base = fromMatch[2] ?? '';
        const names = fromMatch[3] as string;
        const entry: ParsedImport = { raw: collapseWhitespace(raw), line: i + 1 };
        const toPath = moduleToPath(base);
        if (toPath !== undefined) entry.toPath = toPath;
        parsed.imports.push(entry);
        const cleaned = names.replace(/[()]/g, '');
        for (const part of cleaned.split(',')) {
          const item = part.trim().split(/\s+as\s+/);
          const imported = (item[0] ?? '').trim();
          if (imported === '' || imported === '*') continue;
          const alias = item[1]?.trim();
          const name = (alias ?? imported).replace(/[^\w]/g, '');
          if (name === '') continue;
          for (const moduleName of [base, imported]) {
            const offset = code.indexOf(moduleName);
            if (offset >= 0) {
              pushRef(name, starts[i]! + offset, 'import', container);
              break;
            }
          }
        }
      } else {
        const assignMatch = ASSIGN_RE.exec(code);
        if (assignMatch !== null) {
          const name = assignMatch[2] as string;
          if (!PY_KEYWORDS.has(name)) {
            const parentIsClass = parent?.kind === 'class';
            const symbol: ParsedSymbol = {
              name,
              kind: parentIsClass ? 'field' : 'variable',
              startLine: i + 1,
              endLine: i + 1,
              signature: collapseWhitespace(raw.trim()),
              visibility: visibilityOf(name),
            };
            if (parentIsClass && container !== undefined) symbol.parentName = container;
            parsed.symbols.push(symbol);
          }
        }
      }
    }

    // Identifier references: always scanned, except for a declaration's own name.
    for (const match of code.matchAll(SELF_FIELD_RE)) {
      const name = match[1] as string;
      pushRef(name, starts[i]! + (match.index ?? 0) + match[0].length - name.length, 'field', container);
    }
    for (const match of code.matchAll(ATTR_CALL_RE)) {
      const name = match[1] as string;
      pushRef(name, starts[i]! + (match.index ?? 0) + 1, 'call', container);
    }
    for (const match of code.matchAll(CALL_RE)) {
      const name = match[2] as string;
      if (PY_KEYWORDS.has(name)) continue;
      const offset = starts[i]! + (match.index ?? 0) + (match[1] ?? '').length;
      if (offset === declarationNameOffset) continue;
      pushRef(name, offset, 'call', container);
    }

    for (const block of stack) block.lastCodeLine = i + 1;
  }

  while (stack.length > 0) {
    const block = stack.pop() as Block;
    block.symbol.endLine = Math.max(block.symbol.startLine, block.lastCodeLine);
  }

  parsed.refs = [...collector.all];
  parsed.refsTruncated = collector.wasTruncated;
  return parsed;
}

export const pythonParser: LanguageParser = { language: 'python', parse };
