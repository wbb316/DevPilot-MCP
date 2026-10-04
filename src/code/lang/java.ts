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
import type { Visibility } from '../../types/code.js';

/**
 * Java parser (docs/ROADMAP.md Phase 3 — Maven/Gradle + Spring Boot layouts).
 * Brace-depth driven: a member is reported only when it sits directly in a type body, so
 * method-local variables never masquerade as fields and control statements never
 * masquerade as methods.
 */

const JAVA_KEYWORDS = new Set([
  'if', 'for', 'while', 'switch', 'catch', 'try', 'return', 'new', 'do', 'else',
  'synchronized', 'assert', 'throw', 'case', 'default', 'super', 'this', 'class',
  'interface', 'enum', 'record', 'package', 'import', 'extends', 'implements', 'public',
  'private', 'protected', 'static', 'final', 'abstract', 'void', 'throws', 'instanceof',
  'break', 'continue', 'yield', 'var', 'sealed', 'permits', 'record',
]);

const PACKAGE_RE = /^\s*package\s+([\w.]+)\s*;/;
const IMPORT_RE = /^\s*import\s+(?:static\s+)?([\w.*]+)\s*;/;
const TYPE_RE =
  /^\s*(?:(public|protected|private)\s+)?(?:(?:static|final|abstract|sealed|non-sealed|strictfp)\s+)*(class|interface|enum|record)\s+([A-Za-z_$][\w$]*)([^{;]*)\{?/;
const CONSTRUCTOR_RE =
  /^\s*(?:(public|protected|private)\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+[^{]*?)?\{/;
const METHOD_RE =
  /^\s*(?:(public|protected|private)\s+)?(?:(?:static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]*>\s*)?([A-Za-z_$][\w$<>\[\].,?\s]*?)\s+([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws\s+([\w.,\s]+?))?\s*\{/;
const FIELD_RE =
  /^\s*(?:(public|protected|private)\s+)?(?:(?:static|final|transient|volatile)\s+)*([A-Za-z_$][\w$<>\[\].,?]*)\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;/;
const ANNOTATION_RE = /@([A-Za-z_$][\w$.]*)/g;
const NEW_RE = /\bnew\s+([A-Za-z_$][\w$.]*)\s*[(<]/g;
const CALL_RE = /(^|[^\w.$])([A-Za-z_$][\w$]*)\s*\(/g;
const ATTR_CALL_RE = /\.([A-Za-z_$][\w$]*)\s*\(/g;
const TYPE_TOKEN_RE = /\b([A-Z][A-Za-z0-9_$]*)\b/g;

interface TypeBlock {
  name: string;
  kind: ParsedSymbol['kind'];
  startIndex: number;
  endIndex: number;
  bodyDepth: number;
}

function lastSegment(value: string): string {
  const dot = value.lastIndexOf('.');
  return dot === -1 ? value : value.slice(dot + 1);
}

function visibilityOf(modifier: string | undefined): Visibility {
  if (modifier === 'public' || modifier === 'protected' || modifier === 'private') return modifier;
  return 'package';
}

function parse(text: string, _context?: ParseContext): ParsedFile {
  const parsed = emptyParsed();
  const collector = new RefCollector();
  const starts = lineStarts(text);
  const masked = maskNonCode(text, 'java');
  const codeLines = masked.split('\n');
  const rawLines = text.split('\n');
  const depths = computeBraceDepths(masked);
  const types: TypeBlock[] = [];

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
    if (code.trim() === '') continue;
    const enclosing = currentType(i);
    const container = enclosing?.name;

    if (PACKAGE_RE.test(code)) continue;

    const importMatch = IMPORT_RE.exec(code);
    if (importMatch !== null) {
      const fqcn = importMatch[1] as string;
      const entry: ParsedImport = { raw: collapseWhitespace(raw), line: i + 1 };
      if (!fqcn.endsWith('.*')) entry.toPath = `${fqcn.replace(/\./g, '/')}.java`;
      parsed.imports.push(entry);
      const name = lastSegment(fqcn);
      const offset = code.indexOf(fqcn) + Math.max(0, fqcn.length - name.length);
      pushRefAtOffset(name, starts[i]! + offset, 'import');
      continue;
    }

    const typeMatch = TYPE_RE.exec(code);
    if (typeMatch !== null) {
      const modifier = typeMatch[1];
      const kindToken = typeMatch[2] as string;
      const name = typeMatch[3] as string;
      const tail = typeMatch[4] ?? '';
      const kind: ParsedSymbol['kind'] =
        kindToken === 'interface' ? 'interface' : kindToken === 'enum' ? 'enum' : 'class';
      const endIndex = findBlockEndLine(depths, i) - 1;
      const bodyDepth = (depths.after[i] ?? 0) > (depths.before[i] ?? 0)
        ? (depths.before[i] ?? 0) + 1
        : depths.before[i] ?? 0;
      const symbol: ParsedSymbol = {
        name,
        kind,
        startLine: i + 1,
        endLine: endIndex + 1,
        signature: collapseWhitespace(raw.trim()),
        visibility: visibilityOf(modifier),
      };
      if (container !== undefined) symbol.parentName = container;
      parsed.symbols.push(symbol);
      types.push({ name, kind, startIndex: i, endIndex, bodyDepth });

      const extendsMatch = /extends\s+([A-Za-z_$][\w$.,\s<>\[]*?)\s*(?:implements\b|$)/.exec(tail);
      if (extendsMatch !== null) {
        for (const part of (extendsMatch[1] as string).split(',')) {
          const target = lastSegment(part.trim().replace(/<.*$/, ''));
          if (target === '' || !/^[A-Za-z_$][\w$]*$/.test(target)) continue;
          const offset = code.indexOf(target);
          if (offset >= 0) pushRefAtOffset(target, starts[i]! + offset, 'extends', name);
        }
      }
      const implementsMatch = /implements\s+([A-Za-z_$][\w$.,\s<>\[]*?)\s*$/.exec(tail);
      if (implementsMatch !== null) {
        for (const part of (implementsMatch[1] as string).split(',')) {
          const target = lastSegment(part.trim().replace(/<.*$/, ''));
          if (target === '' || !/^[A-Za-z_$][\w$]*$/.test(target)) continue;
          const offset = code.indexOf(target);
          if (offset >= 0) pushRefAtOffset(target, starts[i]! + offset, 'implements', name);
        }
      }
    } else if (enclosing !== undefined && (depths.before[i] ?? 0) === enclosing.bodyDepth) {
      const constructorMatch = CONSTRUCTOR_RE.exec(code);
      const isConstructor =
        constructorMatch !== null &&
        (constructorMatch[2] as string) === enclosing.name &&
        enclosing.kind === 'class';
      const methodMatch = isConstructor ? null : METHOD_RE.exec(code);
      const fieldMatch = isConstructor || methodMatch !== null ? null : FIELD_RE.exec(code);

      if (isConstructor && constructorMatch !== null) {
        const endIndex = findBlockEndLine(depths, i) - 1;
        const symbol: ParsedSymbol = {
          name: enclosing.name,
          kind: 'constructor',
          startLine: i + 1,
          endLine: endIndex + 1,
          signature: collapseWhitespace(raw.trim()),
          visibility: visibilityOf(constructorMatch[1]),
          parentName: enclosing.name,
        };
        parsed.symbols.push(symbol);
      } else if (methodMatch !== null) {
        const name = methodMatch[3] as string;
        if (!JAVA_KEYWORDS.has(name)) {
          const endIndex = findBlockEndLine(depths, i) - 1;
          const symbol: ParsedSymbol = {
            name,
            kind: 'method',
            startLine: i + 1,
            endLine: endIndex + 1,
            signature: collapseWhitespace(raw.trim()),
            visibility: visibilityOf(methodMatch[1]),
            parentName: enclosing.name,
          };
          parsed.symbols.push(symbol);
          const typeFragments = [methodMatch[2] ?? '', methodMatch[4] ?? '', methodMatch[5] ?? ''];
          for (const fragment of typeFragments) {
            for (const token of fragment.matchAll(TYPE_TOKEN_RE)) {
              const typeName = token[1] as string;
              if (typeName === name) continue;
              const offset = code.indexOf(typeName);
              if (offset >= 0) pushRefAtOffset(typeName, starts[i]! + offset, 'type', enclosing.name);
            }
          }
        }
      } else if (fieldMatch !== null) {
        const name = fieldMatch[3] as string;
        const symbol: ParsedSymbol = {
          name,
          kind: 'field',
          startLine: i + 1,
          endLine: i + 1,
          signature: collapseWhitespace(raw.trim()),
          visibility: visibilityOf(fieldMatch[1]),
          parentName: enclosing.name,
        };
        parsed.symbols.push(symbol);
        for (const token of (fieldMatch[2] ?? '').matchAll(TYPE_TOKEN_RE)) {
          const typeName = token[1] as string;
          if (typeName === name) continue;
          const offset = code.indexOf(typeName);
          if (offset >= 0) pushRefAtOffset(typeName, starts[i]! + offset, 'type', enclosing.name);
        }
      }
    }

    for (const annotation of code.matchAll(ANNOTATION_RE)) {
      const name = lastSegment(annotation[1] as string);
      pushRef(name, i, (annotation.index ?? 0) + 1, 'type', container);
    }
    for (const created of code.matchAll(NEW_RE)) {
      const name = lastSegment(created[1] as string);
      pushRef(name, i, (created.index ?? 0) + created[0].indexOf(name), 'call', container);
    }
    for (const call of code.matchAll(ATTR_CALL_RE)) {
      pushRef(call[1] as string, i, (call.index ?? 0) + 1, 'call', container);
    }
    for (const call of code.matchAll(CALL_RE)) {
      const name = call[2] as string;
      if (JAVA_KEYWORDS.has(name)) continue;
      pushRef(name, i, (call.index ?? 0) + (call[1] ?? '').length, 'call', container);
    }
  }

  parsed.refs = [...collector.all];
  parsed.refsTruncated = collector.wasTruncated;
  return parsed;
}

export const javaParser: LanguageParser = { language: 'java', parse };
