/**
 * Secret redaction (docs/ROADMAP.md Phase 9, docs/ARCHITECTURE.md §6).
 *
 * DevPilot must never widen an agent's reach to secrets. Tool output is the last place a credential
 * could escape (a log tail, a stack-trace line, a diff hunk, a snippet), so every string leaving the
 * server is scanned here.
 *
 * The rules are deliberately high precision. Over-redaction is not free: it corrupts the code
 * snippets the agent needs to read, so a value is only replaced when it *looks like* a credential
 * (a known token prefix, a PEM block, a key/value assignment whose value is opaque) rather than
 * whenever a variable happens to be called `token`.
 */

export const REDACTED = '[redacted]';

interface SecretRule {
  kind: string;
  pattern: RegExp;
  replacement: string;
}

const RULES: readonly SecretRule[] = [
  {
    kind: 'private_key',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    replacement: `-----BEGIN PRIVATE KEY-----${REDACTED}-----END PRIVATE KEY-----`,
  },
  {
    kind: 'aws_access_key',
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'github_token',
    pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'github_pat',
    pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'provider_api_key',
    pattern: /\bsk-[A-Za-z0-9_-]{20,}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'slack_token',
    pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'google_api_key',
    pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: REDACTED,
  },
  {
    kind: 'jwt',
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replacement: REDACTED,
  },
  {
    // scheme://user:password@host — keep the shape, drop the credential.
    kind: 'url_credentials',
    pattern: /(\b[a-z][a-z0-9+.-]*:\/\/[^\s:@/]+:)([^\s@/]{4,})(@)/gi,
    replacement: `$1${REDACTED}$3`,
  },
  {
    // dotenv / CI style assignment. Deliberately ALL-CAPS-only and not anchored to the line start:
    // `DB_PASSWORD=…` matched anywhere is a credential, while `access_token_expiry_seconds = 3600`
    // in ordinary code is not.
    kind: 'env_assignment',
    pattern:
      /(\b[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|CREDENTIAL)[A-Z0-9_]*)(\s*=\s*)(\S+)/g,
    replacement: `$1$2${REDACTED}`,
  },
  {
    // quoted literal assigned to a credential-looking name: password = "hunter2..."
    kind: 'quoted_assignment',
    pattern:
      /(\b[A-Za-z0-9_.]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?token)\b\s*[:=]\s*)(["'`])([^"'`\n]{6,})\2/gi,
    replacement: `$1$2${REDACTED}$2`,
  },
  {
    // opaque unquoted literal (long, mixed, contains a digit) — a bare identifier is left alone.
    kind: 'bare_assignment',
    pattern:
      /(\b[A-Za-z0-9_.]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key)\b\s*[:=]\s*)(?=[A-Za-z0-9+/_-]*\d)[A-Za-z0-9+/_-]{24,}/gi,
    replacement: `$1${REDACTED}`,
  },
  {
    kind: 'bearer_header',
    pattern: /(\bBearer\s+)([A-Za-z0-9._-]{12,})/gi,
    replacement: `$1${REDACTED}`,
  },
];

export interface RedactionResult {
  text: string;
  matches: number;
  kinds: string[];
}

/** Replace credential-looking values in one string. */
export function redactSecrets(text: string): RedactionResult {
  let current = text;
  let matches = 0;
  const kinds = new Set<string>();
  for (const rule of RULES) {
    // A fresh lastIndex per call: the rules have /g and are shared module state.
    rule.pattern.lastIndex = 0;
    const replaced = current.replace(rule.pattern, rule.replacement);
    if (replaced !== current) {
      const hits = countMatches(rule.pattern, current);
      matches += hits;
      kinds.add(rule.kind);
      current = replaced;
    }
  }
  return { text: current, matches, kinds: [...kinds] };
}

/** True when the string carries something the rules would redact. */
export function containsSecret(text: string): boolean {
  return redactSecrets(text).matches > 0;
}

function countMatches(pattern: RegExp, text: string): number {
  const flags = pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`;
  const probe = new RegExp(pattern.source, flags);
  let count = 0;
  while (probe.exec(text) !== null) {
    count += 1;
    if (count > 1_000) break;
  }
  return count;
}

export interface DeepRedaction<T> {
  value: T;
  matches: number;
  kinds: string[];
}

/**
 * Walk a JSON-ish value and redact every string in it. Used at the envelope boundary so a new tool
 * cannot forget to sanitise its payload. Class instances and non-plain objects pass through
 * untouched (rebuilding them would lose behaviour); everything DevPilot returns is plain JSON.
 */
export function redactDeep<T>(value: T): DeepRedaction<T> {
  const kinds = new Set<string>();
  let matches = 0;

  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const result = redactSecrets(node);
      matches += result.matches;
      for (const kind of result.kinds) kinds.add(kind);
      return result.text;
    }
    if (Array.isArray(node)) return node.map((item) => walk(item));
    if (node !== null && typeof node === 'object') {
      const prototype = Object.getPrototypeOf(node) as object | null;
      if (prototype !== Object.prototype && prototype !== null) return node;
      const output: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(node as Record<string, unknown>)) {
        output[key] = walk(item);
      }
      return output;
    }
    return node;
  };

  const walked = walk(value) as T;
  return { value: walked, matches, kinds: [...kinds] };
}
