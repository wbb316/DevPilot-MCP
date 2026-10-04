/**
 * gitignore matching (docs/ARCHITECTURE.md §6 "reuse mature tooling, own the glue").
 *
 * Git itself is the authority on ignore semantics; DevPilot must agree with it closely
 * enough that the agent sees the same project git sees. This is a deliberate subset:
 *
 *  - blank lines and `#` comments are skipped, `\#` and `\!` escape a literal first char
 *  - `!pattern` negates, and the **last** matching rule wins
 *  - a trailing `/` restricts the rule to directories
 *  - a `/` at the start or in the middle anchors the pattern to the directory that owns
 *    the `.gitignore`; otherwise it matches at any depth below it
 *  - `*` stops at `/`, `**` crosses `/`, `?` is one non-separator character, `[a-z]` and
 *    `[!a-z]` character classes are supported
 *  - a directory that is ignored is never re-entered (this matches git: "it is not
 *    possible to re-include a file if a parent directory of that file is excluded")
 *
 * Known gaps, documented rather than hidden: `\`-escaped glob metacharacters inside a
 * pattern are treated literally only for the first character, and global/system
 * `core.excludesFile` sources are not consulted.
 */

export interface IgnoreRule {
  /** Pattern as written, minus `!` and a trailing `/` (used in diagnostics). */
  source: string;
  negated: boolean;
  dirOnly: boolean;
  anchored: boolean;
  regex: RegExp;
}

function escapeLiteral(char: string): string {
  return /[.*+?^${}()|[\]\\]/.test(char) ? `\\${char}` : char;
}

/** Translate one gitignore glob (already stripped of `!` and a trailing `/`). */
export function globToRegExpSource(pattern: string): string {
  let source = '';
  let index = 0;

  while (index < pattern.length) {
    const char = pattern[index] as string;

    if (char === '*') {
      let end = index;
      while (pattern[end] === '*') end += 1;
      const stars = end - index;
      if (stars >= 2) {
        if (pattern[end] === '/') {
          // `**/` — zero or more directories; the slash is consumed with the stars.
          source += '(?:.*/)?';
          index = end + 1;
          continue;
        }
        source += '.*';
        index = end;
        continue;
      }
      source += '[^/]*';
      index += 1;
      continue;
    }

    if (char === '?') {
      source += '[^/]';
      index += 1;
      continue;
    }

    if (char === '[') {
      const close = pattern.indexOf(']', index + 1);
      if (close > index + 1) {
        let body = pattern.slice(index + 1, close);
        let negated = false;
        if (body.startsWith('!') || body.startsWith('^')) {
          negated = true;
          body = body.slice(1);
        }
        source += `[${negated ? '^' : ''}${body.replace(/\\/g, '\\\\')}]`;
        index = close + 1;
        continue;
      }
      source += '\\[';
      index += 1;
      continue;
    }

    source += escapeLiteral(char);
    index += 1;
  }

  return source;
}

/** Parse the contents of one `.gitignore` file into rules (order preserved). */
export function parseGitignore(text: string): IgnoreRule[] {
  const rules: IgnoreRule[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    // Trailing whitespace is not significant unless escaped; leading whitespace is not
    // trimmed by git, so `  foo` means a name with leading spaces. We keep it simple and
    // only drop truly blank lines.
    const line = rawLine.replace(/(?<!\\)\s+$/, '');
    if (line.trim() === '') continue;
    if (line.startsWith('#')) continue;

    let body = line;
    let negated = false;

    if (body.startsWith('\\#') || body.startsWith('\\!')) body = body.slice(1);
    else if (body.startsWith('!')) {
      negated = true;
      body = body.slice(1);
    }
    if (body === '') continue;

    let dirOnly = false;
    if (body.endsWith('/') && body !== '/') {
      dirOnly = true;
      body = body.slice(0, -1);
    }
    // A leading slash anchors the pattern to this `.gitignore`'s directory — exactly like a
    // slash in the middle (gitignore(5), PATTERN FORMAT). `/build` must not match `src/build`.
    let anchored = body.startsWith('/');
    if (anchored) body = body.slice(1);
    if (body === '') continue;
    if (body.includes('/')) anchored = true;
    const source = globToRegExpSource(body);
    rules.push({
      source: body,
      negated,
      dirOnly,
      anchored,
      regex: new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`),
    });
  }

  return rules;
}

interface Layer {
  /** POSIX path of the directory owning this `.gitignore`, '' for the root. */
  base: string;
  rules: IgnoreRule[];
}

/**
 * Stack of `.gitignore` layers. Layers must be added parent-before-child (the walker's
 * breadth-first order guarantees that), because a deeper file overrides a shallower one.
 */
export class IgnoreMatcher {
  private readonly layers: Layer[] = [];

  addLayer(baseDir: string, text: string): number {
    const base = normalizeBase(baseDir);
    const rules = parseGitignore(text);
    if (rules.length > 0) this.layers.push({ base, rules });
    return rules.length;
  }

  get layerCount(): number {
    return this.layers.length;
  }

  get ruleCount(): number {
    return this.layers.reduce((total, layer) => total + layer.rules.length, 0);
  }

  /** Last matching rule wins, across rules and across layers. */
  isIgnored(relativePath: string, isDir: boolean): boolean {
    const target = normalizeBase(relativePath);
    if (target === '') return false;

    let decision: boolean | undefined;
    for (const layer of this.layers) {
      let local = target;
      if (layer.base !== '') {
        if (target === layer.base) continue;
        if (!target.startsWith(`${layer.base}/`)) continue;
        local = target.slice(layer.base.length + 1);
      }
      for (const rule of layer.rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(local)) decision = !rule.negated;
      }
    }
    return decision ?? false;
  }
}

function normalizeBase(value: string): string {
  const posix = value.replace(/\\/g, '/');
  if (posix === '.' || posix === './') return '';
  return posix.replace(/^\/+/, '').replace(/\/+$/, '');
}
