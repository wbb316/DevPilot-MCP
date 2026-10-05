/**
 * Decoding of git's quoted path output.
 *
 * `git status` / `git diff` wrap a path in double quotes and escape it C-style when it contains
 * unusual bytes — `docs/\346\226\207\346\241\243.md` for `docs/文档.md`. Those escapes are **bytes**,
 * not code points, so decoding each one into a character (`String.fromCharCode`) produces mojibake
 * for every non-ASCII path.
 *
 * That is not cosmetic. Everything keyed by a real path breaks at once when the decoded name is not
 * the name on disk:
 *
 *  - `create_checkpoint` stats the file, fails, and records it as patch-only — and a rollback then
 *    silently skips it (found on a real project: 23 such files, all CJK);
 *  - `review_diff` cannot stat the file either, so changed symbols stay empty;
 *  - sensitive-file classification and risk rules match on the wrong name.
 *
 * The bytes are therefore collected and decoded as UTF-8 once, which is what git produced.
 */
export function unquoteGitPath(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.startsWith('"') || !trimmed.endsWith('"')) return trimmed;
  const body = trimmed.slice(1, -1);
  const bytes: number[] = [];
  const pushLiteral = (text: string): void => {
    for (const byte of Buffer.from(text, 'utf8')) bytes.push(byte);
  };

  for (let i = 0; i < body.length; i += 1) {
    const ch = body[i] as string;
    if (ch !== '\\') {
      pushLiteral(ch);
      continue;
    }
    const next = body[i + 1];
    if (next === undefined) break;
    if (/[0-7]/.test(next)) {
      const octal = body.slice(i + 1, i + 4);
      bytes.push(Number.parseInt(octal, 8) & 0xff);
      i += 3;
      continue;
    }
    const escapes: Record<string, string> = {
      n: '\n',
      t: '\t',
      r: '\r',
      a: '\u0007',
      b: '\b',
      f: '\f',
      v: '\u000b',
      '"': '"',
      '\\': '\\',
    };
    pushLiteral(escapes[next] ?? next);
    i += 1;
  }

  return Buffer.from(bytes).toString('utf8');
}

/**
 * Recover a path that a **pre-fix** DevPilot stored in the escaped form.
 *
 * The old `pathStatuses()` left git's C-style octal escapes in place and then mapped `path.sep` to
 * `/`, so on Windows `docs/二阶段/x.html` was persisted to the baseline as
 * `docs//344/272/214/.../x.html` (on POSIX only the `\344` spelling survived). The escapes are
 * reversible, but a legitimately numeric segment such as `/123/` is ambiguous, so this only *offers*
 * a candidate: the caller must confirm it against a path that really exists before using it.
 *
 * Returns undefined when the input contains no escape sequence (i.e. it is already a plain path).
 */
export function legacyPathCandidate(raw: string): string | undefined {
  const bytes: number[] = [];
  let i = 0;
  let decoded = false;
  while (i < raw.length) {
    const escape = /^([\\/])([0-7]{3})/.exec(raw.slice(i, i + 4));
    if (escape !== null) {
      const value = Number.parseInt(escape[2] as string, 8) & 0xff;
      const backslash = escape[1] === '\\';
      // A backslash group is unambiguous evidence of git's escaping (a baseline path is always
      // POSIX-style, so a real backslash never appears). The slash form collides with a numeric
      // segment — `/150` is also `h` — so it is accepted only for a byte that cannot be ASCII,
      // which is exactly what every non-ASCII UTF-8 byte is.
      if (backslash || value >= 0x80) {
        bytes.push(value);
        i += 4;
        decoded = true;
        continue;
      }
    }
    for (const byte of Buffer.from(raw[i] as string, 'utf8')) bytes.push(byte);
    i += 1;
  }
  if (!decoded) return undefined;
  return Buffer.from(bytes).toString('utf8');
}
