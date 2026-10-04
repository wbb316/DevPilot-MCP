import type { DiagnosisCategory } from '../types/diagnosis.js';

/**
 * Rule table for failure classification (docs/ARCHITECTURE.md §4.7).
 *
 * DevPilot is not the AI here: it does not solve the problem, it classifies it and hands the
 * agent the exact lines that matter. Rules are deterministic and ordered; `strong` rules win
 * over `weak` ones, and the first match inside a weight class wins.
 *
 * `hint` is a one-line next step per category — advice, not a diagnosis of the specific bug.
 */

export interface DiagnosisRule {
  category: DiagnosisCategory;
  pattern: RegExp;
  weight: 'strong' | 'weak';
}

export const DIAGNOSIS_RULES: readonly DiagnosisRule[] = [
  // GPU / memory first: they are the failures most often misread as something else.
  {
    category: 'CUDA_OUT_OF_MEMORY',
    pattern: /CUDA out of memory|torch\.cuda\.OutOfMemoryError|CUDA error: out of memory/i,
    weight: 'strong',
  },
  {
    category: 'SYSTEM_OUT_OF_MEMORY',
    pattern:
      /MemoryError|std::bad_alloc|Java heap space|OutOfMemoryError|Cannot allocate memory|Killed$|OOM-killer/i,
    weight: 'strong',
  },
  {
    category: 'NULL_POINTER',
    pattern:
      /NullPointerException|'NoneType' object has no attribute|NoneType.*not subscriptable|Cannot read propert(?:y|ies) of (?:undefined|null)|is not a function|TypeError: Cannot read/i,
    weight: 'strong',
  },
  {
    category: 'IMPORT_ERROR',
    pattern:
      /ModuleNotFoundError|No module named|ImportError|cannot import name|Cannot find module|ERR_MODULE_NOT_FOUND|ClassNotFoundException|NoClassDefFoundError/i,
    weight: 'strong',
  },
  {
    category: 'SYNTAX_ERROR',
    pattern: /SyntaxError|IndentationError|TabError|unexpected token|Unexpected end of/i,
    weight: 'strong',
  },
  {
    category: 'COMPILE_ERROR',
    pattern:
      /BUILD FAILURE|COMPILATION ERROR|compilation failed|cannot find symbol|error: invalid|was not declared in this scope|\[ERROR\] .*\.java:\[\d+/i,
    weight: 'strong',
  },
  {
    category: 'DEPENDENCY_ERROR',
    pattern:
      /Could not resolve dependencies|Unable to find|npm ERR! 404|Cannot resolve dependency|peer dep|no matching version found|not satisfy|could not find a version that satisfies/i,
    weight: 'strong',
  },
  {
    category: 'PORT_IN_USE',
    pattern: /EADDRINUSE|Address already in use|port is already allocated|bind: address/i,
    weight: 'strong',
  },
  {
    category: 'PERMISSION_DENIED',
    pattern: /EACCES|EPERM|Permission denied|Access is denied|Operation not permitted/i,
    weight: 'strong',
  },
  {
    category: 'ENCODING_ERROR',
    pattern: /UnicodeDecodeError|UnicodeEncodeError|codec can't decode|invalid byte sequence/i,
    weight: 'strong',
  },
  {
    category: 'NETWORK_ERROR',
    pattern:
      /ECONNREFUSED|Etimedout|ETIMEDOUT|getaddrinfo|Temporary failure in name resolution|Connection refused|Could not resolve host|SSL certificate problem/i,
    weight: 'strong',
  },
  {
    category: 'TIMEOUT',
    pattern: /timed out|TimeoutError|Timeout waiting|exceeded the time limit/i,
    weight: 'strong',
  },
  {
    category: 'GIT_ERROR',
    pattern: /not a git repository|fatal: |merge conflict|CONFLICT \(content\)/i,
    weight: 'strong',
  },
  {
    category: 'TYPE_ERROR',
    pattern:
      /TypeError:|TS\d{3,5}:|error TS\d+|is not assignable to type|Argument of type|no overload matches|mypy|Incompatible types/i,
    weight: 'weak',
  },
  {
    category: 'ASSERTION_FAILED',
    pattern:
      /AssertionError|Expected .* (?:to be|to equal|toHaveBeenCalled)|assert .* ==|Assertion failed/i,
    weight: 'weak',
  },
  {
    category: 'FILE_NOT_FOUND',
    pattern: /ENOENT|No such file or directory|cannot find the (?:file|path) specified|FileNotFoundError/i,
    weight: 'weak',
  },
  {
    category: 'KEY_ERROR',
    pattern: /\bKeyError\b|\bIndexError\b|list index out of range/i,
    weight: 'weak',
  },
  {
    category: 'NAME_ERROR',
    pattern: /\bNameError\b|is not defined\b/i,
    weight: 'weak',
  },
  {
    category: 'CONFIG_ERROR',
    pattern: /invalid config|unknown option|unrecognized (?:option|argument)|config.*not found/i,
    weight: 'weak',
  },
  {
    category: 'TEST_FAILED',
    pattern: /\d+ (?:failed|failing|tests failed)|\bFAILED\b|FAILURES|Tests run:.*Failures: [1-9]/,
    weight: 'weak',
  },
];

const HINTS: Record<DiagnosisCategory, string> = {
  CUDA_OUT_OF_MEMORY:
    'Reduce batch size or sequence length, enable gradient checkpointing / AMP, or free other GPU users before touching model logic.',
  SYSTEM_OUT_OF_MEMORY:
    'Lower the working-set (batch, chunk, cache size) or raise the limit; a leak can also grow over iterations — check the trend in the log.',
  NULL_POINTER:
    'The value used at the failing line is empty. Check the producing call, its error branch, and whether the test/DI setup returns a stub.',
  IMPORT_ERROR:
    'A module or symbol is missing or misspelled: verify the dependency is declared and installed, and that the import path matches the file layout.',
  SYNTAX_ERROR:
    'A parse error: fix the syntax at the reported location (indentation for Python) before investigating anything downstream.',
  TYPE_ERROR:
    'A type mismatch: align the declared and actual types at the reported location, or widen the signature deliberately.',
  NAME_ERROR:
    'An identifier is used before it exists: check spelling, scope, and imports at the failing line.',
  KEY_ERROR:
    'A key or index is absent: guard the access or fix the producing data shape.',
  ASSERTION_FAILED:
    'A test expectation failed: read the expected vs actual pair, then decide whether the code or the expectation is wrong.',
  TEST_FAILED:
    'Tests failed without a single dominant exception: open the failures list from run_tests and fix them one by one.',
  COMPILE_ERROR:
    'The build did not compile: fix the reported symbols/signatures first — later errors are usually cascades.',
  DEPENDENCY_ERROR:
    'Dependency resolution failed: check the coordinate/version, the lockfile, and whether a network mirror is reachable.',
  PORT_IN_USE:
    'The port is taken: stop the other process or change the configured port; do not retry blindly.',
  PERMISSION_DENIED:
    'The OS refused the operation: check file ownership/permissions or whether another process holds the handle.',
  FILE_NOT_FOUND:
    'A path does not exist: verify the working directory and the path spelling; relative paths resolve against the command cwd.',
  ENCODING_ERROR:
    'Text decoding failed: read/write with the correct encoding (often utf-8 vs the platform default).',
  NETWORK_ERROR:
    'A network call failed: check connectivity/proxy and whether the target service is running.',
  TIMEOUT:
    'The run exceeded its limit: raise the timeout only after confirming the workload is not hanging (look at the last log lines).',
  CONFIG_ERROR:
    'A configuration value is invalid: compare it against .devpilot/config.yml and the tool docs.',
  GIT_ERROR:
    'Git refused the operation: resolve the repository state (branch, conflicts) before continuing.',
  UNKNOWN:
    'No rule matched: read the evidence lines and the log artifact, then decide; consider adding a rule to diagnose/patterns.ts.',
};

export function hintFor(category: DiagnosisCategory): string {
  return HINTS[category];
}

export interface RuleMatch {
  category: DiagnosisCategory;
  weight: 'strong' | 'weak';
}

/**
 * Classify a log. Strong rules beat weak ones; inside a weight class the first rule (and thus
 * the most specific pattern) wins. `UNKNOWN` when nothing matched.
 */
export function classifyFailure(text: string): RuleMatch {
  let weak: RuleMatch | undefined;
  for (const rule of DIAGNOSIS_RULES) {
    if (!rule.pattern.test(text)) continue;
    if (rule.weight === 'strong') return { category: rule.category, weight: 'strong' };
    weak ??= { category: rule.category, weight: 'weak' };
  }
  return weak ?? { category: 'UNKNOWN', weight: 'weak' };
}

/** Lines worth showing the agent: errors, exceptions, stack frames, summaries. */
export const EVIDENCE_PATTERN =
  /(?:\berror\b|\bexception\b|\bfailed\b|\bfailure\b|traceback|assert|caused by|\bat\s+\S+\(|\bFile "|E\s{2,}|npm ERR!|\[ERROR\]|panic:|fatal:|^\s*\d+ (?:passed|failed))/i;

/**
 * Lines that carry a source location but are pure noise as evidence.
 *
 * The second alternative drops `node --test` TAP diagnostic *keys* — `error: |-`,
 * `code: 'ERR_ASSERTION'`, `duration_ms: 5.238` — which match EVIDENCE_PATTERN through the words
 * "error" and "assert" without saying anything. A key whose value is prose
 * (`error: Expected 1 to be 2`) is kept, because there the text is the evidence.
 */
export const EVIDENCE_NOISE =
  /^\s*(?:at\s+(?:node:|internal\/|native)|Note:|DeprecationWarning)|^\s*(?:error|code|location|failureType|duration_ms|operator|expected|actual|compare|type|name|stack):\s*(?:\|-?|\||'[^']*'|"[^"]*"|-?\d+(?:\.\d+)?)\s*$/;
