import path from 'node:path';

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
  computeBraceDepths,
  findBlockEndLine,
  lineStarts,
  maskNonCode,
  positionAt,
} from '../text-utils.js';
import type { FileLanguage } from '../../workspace/file-walker.js';

/**
 * TypeScript / JavaScript parser (docs/ROADMAP.md Phase 3).
 *
 * Import specifiers are read from the *raw* line (the specifier is a string literal, and
 * string bodies are masked), while structure detection runs on masked text. Relative
 * specifiers are resolved to a candidate path here; extension/index resolution against the
 * real file list happens in the index layer.
 */

const JS_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'do', 'else', 'try', 'throw',
  'typeof', 'instanceof', 'in', 'of', 'case', 'default', 'super', 'this', 'class',
  'function', 'interface', 'type', 'enum', 'const', 'let', 'var', 'await', 'async', 'yield',
  'import', 'export', 'delete', 'void', 'extends', 'implements',
]);

const IMPORT_FROM_RE = /^\s*import\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/;
const IMPORT_BARE_RE = /^\s*import\s*['"]([^'"]+)['"]/;
const EXPORT_FROM_RE = /^\s*export\s+(?:type\s+)?(?:\*|\{[\s\S]*?\})\s*from\s*['"]([^'"]+)['"]/;
const REQUIRE_RE = /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/;
const DYNAMIC_IMPORT_RE = /import\s*\(\s*['"]([^'"]+)['"]\s*\)/;
const CLASS_RE =
  /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)([^{]*)\{/;
const FUNCTION_RE = /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/;
const ARROW_RE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/;
const FUNCTION_EXPR_RE =
  /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/;
const INTERFACE_RE = /^\s*(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/;
const TYPE_ALIAS_RE = /^\s*(?:export\s+)?type\s+([A-Za-z_$][\w$]*)\s*[=<]/;
const ENUM_RE = /^\s*(?:export\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/;
const VARIABLE_RE = /^\s*(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/;
const MEMBER_METHOD_RE =
  /^\s*(?:(?:public|private|protected|static|async|readonly|abstract|override|declare)\s+)*(?:get\s+|set\s+)?([A-Za-z_$][\w$]*)\s*[(<]/;
const MEMBER_FIELD_RE =
  /^\s*(?:(?:public|private|protected|static|readonly|declare|abstract|override)\s+)+([A-Za-z_$][\w$]*)\s*[:=]/;
const CONSTRUCTOR_MEMBER_RE = /^\s*(?:(?:public|private|protected)\s+)?constructor\s*\(/;
const THIS_FIELD_RE = /\bthis\.([A-Za-z_$][\w$]*)/g;
const NEW_RE = /\bnew\s+([A-Za-z_$][\w$.]*)\s*[(<]/g;
const CALL_RE = /(^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
const ATTR_CALL_RE = /\.([A-Za-z_$][\w$]*)\s*\(/g;
const TYPE_ANNOTATION_RE = /:\s*([A-Z][A-Za-z0-9_$]*)/g;

interface TypeBlock {
  name: string;
  startIndex: number;
  endIndex: number;
  /** Brace depth of the class body: only direct members are symbols. */
  bodyDepth: number;
}

function lastSegment(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot === -1 ? value : value.slice(dot + 1);
}

/**
 * Candidate path for a relative specifier; extension resolution happens in the index layer
 * (which knows the real file list).
 */
export function resolveRelativeSpecifier(fromPath: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  const dir = path.posix.dirname(fromPath);
  const joined = path.posix.normalize(path.posix.join(dir === '.' ? '' : dir, specifier));
  return joined.startsWith('..') ? undefined : joined;
}

function createParser(language: FileLanguage): LanguageParser {
  const parse = (text: string, context?: ParseContext): ParsedFile => {
    const parsed = emptyParsed();
    const collector = new RefCollector();
    const starts = lineStarts(text);
    const masked = maskNonCode(text, language);
    const codeLines = masked.split('\n');
    const rawLines = text.split('\n');
    const depths = computeBraceDepths(masked);
    const types: TypeBlock[] = [];

    const pushRefAtOffset = (
      name: string,
      offset: number,
      kind: ParsedRef['kind'],
      containerName?: string,
    ): void => {
      const position = positionAt(starts, offset);
      const ref: ParsedRef = { name, line: position.line, column: position.column, kind };
      if (containerName !== undefined) ref.containerName = containerName;
      collector.add(ref);
    };

    const pushRef = (
      name: string,
      lineIndex: number,
      columnIndex: number,
      kind: ParsedRef['kind'],
      containerName?: string,
    ): void => {
      const ref: ParsedRef = { name, line: lineIndex + 1, column: columnIndex + 1, kind };
      if (containerName !== undefined) ref.containerName = containerName;
      collector.add(ref);
    };

    const currentType = (lineIndex: number): TypeBlock | undefined => {
      for (let i = types.length - 1; i >= 0; i -= 1) {
        const block = types[i] as TypeBlock;
        if (lineIndex >= block.startIndex && lineIndex <= block.endIndex) return block;
      }
      return undefined;
    };

    for (let i = 0; i < codeLines.length; i += 1) {
      const code = codeLines[i] ?? '';
      const raw = rawLines[i] ?? '';
      const enclosing = currentType(i);
      const container = enclosing?.name;

      const importMatch = IMPORT_FROM_RE.exec(raw);
      const bareImport = importMatch === null ? IMPORT_BARE_RE.exec(raw) : null;
      const exportFrom = importMatch === null && bareImport === null ? EXPORT_FROM_RE.exec(raw) : null;
      const requireMatch = REQUIRE_RE.exec(raw);
      const dynamicImport = DYNAMIC_IMPORT_RE.exec(raw);

      if (importMatch !== null) {
        const clause = (importMatch[1] ?? '').trim();
        const specifier = importMatch[2] as string;
        const toPath = resolveRelativeSpecifier(context?.path ?? '', specifier);
        const entry: ParsedImport = { raw: collapseWhitespace(raw), line: i + 1 };
        if (toPath !== undefined) entry.toPath = toPath;
        parsed.imports.push(entry);
        for (const name of importNames(clause)) {
          const offset = code.indexOf(name);
          pushRefAtOffset(name, starts[i]! + Math.max(0, offset), 'import', container);
        }
        if (importNames(clause).length === 0) {
          const name = lastSegment(specifier).replace(/[^\w$]/g, '');
          if (name !== '') pushRefAtOffset(name, starts[i]! + Math.max(0, code.indexOf(name)), 'import', container);
        }
        continue;
      }
      if (bareImport !== null || exportFrom !== null) {
        const specifier = (bareImport?.[1] ?? exportFrom?.[1] ?? '') as string;
        const toPath = resolveRelativeSpecifier(context?.path ?? '', specifier);
        const entry: ParsedImport = { raw: collapseWhitespace(raw), line: i + 1 };
        if (toPath !== undefined) entry.toPath = toPath;
        parsed.imports.push(entry);
        const name = lastSegment(specifier).replace(/[^\w$]/g, '');
        if (name !== '') pushRefAtOffset(name, starts[i]! + Math.max(0, code.indexOf(name)), 'import', container);
        continue;
      }
      if (requireMatch !== null || dynamicImport !== null) {
        const specifier = (requireMatch?.[2] ?? dynamicImport?.[1] ?? '') as string;
        const toPath = resolveRelativeSpecifier(context?.path ?? '', specifier);
        const entry: ParsedImport = { raw: collapseWhitespace(raw), line: i + 1 };
        if (toPath !== undefined) entry.toPath = toPath;
        parsed.imports.push(entry);
        const bound = requireMatch?.[1];
        const name = bound ?? lastSegment(specifier).replace(/[^\w$]/g, '');
        if (name !== '') pushRefAtOffset(name, starts[i]! + Math.max(0, code.indexOf(name)), 'import', container);
      }

      if (code.trim() === '') continue;

      const classMatch = CLASS_RE.exec(code);
      if (classMatch !== null) {
        const name = classMatch[1] as string;
        const tail = classMatch[2] ?? '';
        const endIndex = findBlockEndLine(depths, i) - 1;
        const symbol: ParsedSymbol = {
          name,
          kind: 'class',
          startLine: i + 1,
          endLine: endIndex + 1,
          signature: collapseWhitespace(raw.trim()),
          visibility: 'public',
        };
        if (container !== undefined) symbol.parentName = container;
        parsed.symbols.push(symbol);
        types.push({
          name,
          startIndex: i,
          endIndex,
          bodyDepth:
            (depths.after[i] ?? 0) > (depths.before[i] ?? 0)
              ? (depths.before[i] ?? 0) + 1
              : depths.before[i] ?? 0,
        });
        const extendsMatch = /extends\s+([\w$.]+)/.exec(tail);
        if (extendsMatch !== null) {
          const target = lastSegment(extendsMatch[1] as string);
          const offset = code.indexOf(target);
          if (offset >= 0) pushRefAtOffset(target, starts[i]! + offset, 'extends', name);
        }
        const implementsMatch = /implements\s+([\w$.,\s]+)/.exec(tail);
        if (implementsMatch !== null) {
          for (const part of (implementsMatch[1] as string).split(',')) {
            const target = lastSegment(part.trim());
            if (!/^[A-Za-z_$][\w$]*$/.test(target)) continue;
            const offset = code.indexOf(target);
            if (offset >= 0) pushRefAtOffset(target, starts[i]! + offset, 'implements', name);
          }
        }
        continue;
      }

      const functionMatch = FUNCTION_RE.exec(code);
      const arrowMatch = functionMatch === null ? ARROW_RE.exec(code) : null;
      const functionExpr = functionMatch === null && arrowMatch === null ? FUNCTION_EXPR_RE.exec(code) : null;
      const interfaceMatch =
        functionMatch === null && arrowMatch === null && functionExpr === null
          ? INTERFACE_RE.exec(code)
          : null;
      const typeAlias =
        interfaceMatch === null && functionMatch === null && arrowMatch === null && functionExpr === null
          ? TYPE_ALIAS_RE.exec(code)
          : null;
      const enumMatch =
        typeAlias === null && interfaceMatch === null && functionMatch === null && arrowMatch === null && functionExpr === null
          ? ENUM_RE.exec(code)
          : null;
      const variableMatch =
        enumMatch === null && typeAlias === null && interfaceMatch === null && functionMatch === null &&
        arrowMatch === null && functionExpr === null
          ? VARIABLE_RE.exec(code)
          : null;

      if (enclosing !== undefined && (depths.before[i] ?? 0) === enclosing.bodyDepth) {
        const constructorMember = CONSTRUCTOR_MEMBER_RE.test(code);
        const memberMethod = constructorMember ? null : MEMBER_METHOD_RE.exec(code);
        const memberField = constructorMember || memberMethod !== null ? null : MEMBER_FIELD_RE.exec(code);
        if (constructorMember) {
          const endIndex = findBlockEndLine(depths, i) - 1;
          parsed.symbols.push({
            name: 'constructor',
            kind: 'constructor',
            startLine: i + 1,
            endLine: endIndex + 1,
            signature: collapseWhitespace(raw.trim()),
            visibility: 'public',
            parentName: enclosing.name,
          });
        } else if (memberMethod !== null) {
          const name = memberMethod[1] as string;
          if (!JS_KEYWORDS.has(name)) {
            const endIndex = findBlockEndLine(depths, i) - 1;
            parsed.symbols.push({
              name,
              kind: 'method',
              startLine: i + 1,
              endLine: endIndex + 1,
              signature: collapseWhitespace(raw.trim()),
              visibility: 'public',
              parentName: enclosing.name,
            });
          }
        } else if (memberField !== null) {
          const name = memberField[1] as string;
          parsed.symbols.push({
            name,
            kind: 'field',
            startLine: i + 1,
            endLine: i + 1,
            signature: collapseWhitespace(raw.trim()),
            visibility: 'public',
            parentName: enclosing.name,
          });
        }
      } else if (enclosing === undefined && functionMatch !== null) {
        const endIndex = findBlockEndLine(depths, i) - 1;
        parsed.symbols.push({
          name: functionMatch[1] as string,
          kind: 'function',
          startLine: i + 1,
          endLine: endIndex + 1,
          signature: collapseWhitespace(raw.trim()),
          visibility: 'public',
        });
      } else if (enclosing === undefined && (arrowMatch !== null || functionExpr !== null)) {
        const name = (arrowMatch?.[1] ?? functionExpr?.[1] ?? '') as string;
        const endIndex = findBlockEndLine(depths, i) - 1;
        if (name !== '') {
          parsed.symbols.push({
            name,
            kind: 'function',
            startLine: i + 1,
            endLine: endIndex + 1,
            signature: collapseWhitespace(raw.trim()),
            visibility: 'public',
          });
        }
      } else if (enclosing === undefined && (interfaceMatch !== null || typeAlias !== null)) {
        const name = (interfaceMatch?.[1] ?? typeAlias?.[1] ?? '') as string;
        if (name !== '') {
          // `type X = ...` has no dedicated kind in the frozen schema; `interface` is the
          // closest structural equivalent (documented in docs/TOOLS.md Phase 3 notes).
          parsed.symbols.push({
            name,
            kind: 'interface',
            startLine: i + 1,
            endLine: interfaceMatch !== null ? findBlockEndLine(depths, i) : i + 1,
            signature: collapseWhitespace(raw.trim()),
            visibility: 'public',
          });
        }
      } else if (enclosing === undefined && enumMatch !== null) {
        parsed.symbols.push({
          name: enumMatch[1] as string,
          kind: 'enum',
          startLine: i + 1,
          endLine: findBlockEndLine(depths, i),
          signature: collapseWhitespace(raw.trim()),
          visibility: 'public',
        });
      } else if (enclosing === undefined && variableMatch !== null) {
        parsed.symbols.push({
          name: variableMatch[1] as string,
          kind: 'variable',
          startLine: i + 1,
          endLine: i + 1,
          signature: collapseWhitespace(raw.trim()),
          visibility: 'public',
        });
      }

      for (const field of code.matchAll(THIS_FIELD_RE)) {
        const name = field[1] as string;
        pushRef(name, i, (field.index ?? 0) + field[0].length - name.length, 'field', container);
      }
      for (const created of code.matchAll(NEW_RE)) {
        const name = lastSegment(created[1] as string);
        pushRef(name, i, (created.index ?? 0) + created[0].indexOf(name), 'call', container);
      }
      for (const annotation of code.matchAll(TYPE_ANNOTATION_RE)) {
        const name = annotation[1] as string;
        pushRef(name, i, (annotation.index ?? 0) + annotation[0].length - name.length, 'type', container);
      }
      for (const call of code.matchAll(ATTR_CALL_RE)) {
        pushRef(call[1] as string, i, (call.index ?? 0) + 1, 'call', container);
      }
      for (const call of code.matchAll(CALL_RE)) {
        const name = call[2] as string;
        if (JS_KEYWORDS.has(name)) continue;
        pushRef(name, i, (call.index ?? 0) + (call[1] ?? '').length, 'call', container);
      }
    }

    parsed.refs = [...collector.all];
    parsed.refsTruncated = collector.wasTruncated;
    return parsed;
  };

  return { language, parse };
}

/**
 * The importing file's own path is needed to resolve `./x`; it arrives through the parse
 * context (no module-level state).
 */
function importNames(clause: string): string[] {
  const names: string[] = [];
  const trimmed = clause.trim();
  if (trimmed === '') return names;
  const defaultMatch = /^([A-Za-z_$][\w$]*)/.exec(trimmed);
  if (defaultMatch !== null && !trimmed.startsWith('{') && !trimmed.startsWith('*')) {
    names.push(defaultMatch[1] as string);
  }
  const namespaceMatch = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(trimmed);
  if (namespaceMatch !== null) names.push(namespaceMatch[1] as string);
  const named = /\{([\s\S]*?)\}/.exec(trimmed);
  if (named !== null) {
    for (const part of (named[1] as string).split(',')) {
      const item = part.trim().split(/\s+as\s+/);
      const imported = (item[1] ?? item[0] ?? '').trim();
      if (/^[A-Za-z_$][\w$]*$/.test(imported)) names.push(imported);
    }
  }
  return names;
}

export const typescriptParser = createParser('typescript');
export const javascriptParser = createParser('javascript');
