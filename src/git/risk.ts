import type { ChangedFileStatus, RiskLevel } from '../types/git.js';

/**
 * Deterministic risk rules for `review_diff` (docs/TOOLS.md Phase 7).
 *
 * The point is not cleverness — it is that a human (or an agent) gets a stated reason for every
 * level, so "HIGH" is never an unexplained verdict. Rules are ordered; every matching rule
 * contributes a reason, and the file's level is the highest one that matched.
 */

export interface RiskInput {
  path: string;
  status: ChangedFileStatus;
  addedLines: number;
  deletedLines: number;
  binary: boolean;
  changedSymbols: readonly string[];
}

export interface RiskAssessment {
  risk: RiskLevel;
  reasons: string[];
}

export const RISK_ORDER: Record<RiskLevel, number> = { LOW: 0, MEDIUM: 1, HIGH: 2 };

export function maxRisk(a: RiskLevel, b: RiskLevel): RiskLevel {
  return RISK_ORDER[a] >= RISK_ORDER[b] ? a : b;
}

/** Workspace-relative POSIX path of a recognised test file. */
export const TEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)(tests?|specs?|__tests__)\//i,
  /(^|\/)src\/test\//i,
  /(^|_)(test|spec)[^/]*\.(py|js|jsx|ts|tsx|mjs|cjs)$/i,
  /_test\.(py|go)$/i,
  /Test(s)?\.java$/,
  /(^|\/)conftest\.py$/i,
];

export function isTestPath(relativePath: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(relativePath));
}

const SECRET_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.env(\.[^/]*)?$/i,
  /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i,
  /\.(pem|key|p12|pfx|keystore|jks)$/i,
  /(^|\/)(secrets?|credentials?)(\.[a-z]+)?$/i,
];

const SECURITY_DIR_PATTERNS: readonly RegExp[] = [
  /(^|\/)(security|auth|authentication|authorization|permissions?|payments?|billing|crypto)\//i,
  /(^|\/)(Login|Auth|Security|Permission)[A-Za-z]*\.(java|kt|ts|js|py)$/,
];

const MIGRATION_PATTERNS: readonly RegExp[] = [
  /(^|\/)(migrations?|schema)\/.*\.(sql|py|java|ts)$/i,
  /(^|\/)V\d+__.*\.sql$/i,
];

const DEPLOY_PATTERNS: readonly RegExp[] = [
  /(^|\/)(Dockerfile|docker-compose\.ya?ml|Jenkinsfile|\.gitlab-ci\.ya?ml)$/i,
  /(^|\/)\.github\/workflows\//i,
  /(^|\/)(k8s|kubernetes|helm|deploy|deployment)\//i,
  /(^|\/)(Makefile|makefile)$/,
];

const MANIFEST_PATTERNS: readonly RegExp[] = [
  /(^|\/)(package\.json|pom\.xml|build\.gradle(\.kts)?|settings\.gradle(\.kts)?|requirements\.txt|pyproject\.toml|setup\.py|Pipfile|go\.mod|Cargo\.toml)$/i,
  /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|poetry\.lock|Cargo\.lock)$/i,
];

const CONFIG_PATTERNS: readonly RegExp[] = [
  /(^|\/)tsconfig(\.[a-z]+)?\.json$/i,
  /(^|\/)\.devpilot\/config\.yml$/i,
  /(^|\/)(config|configs|conf)\/.*\.(json|ya?ml|toml|ini|properties)$/i,
  /(^|\/)(application|application-[a-z]+)\.(yml|yaml|properties)$/,
];

const GENERATED_PATTERNS: readonly RegExp[] = [
  /(^|\/)(dist|build|out|target|coverage)\//i,
  /\.(min\.js|min\.css|map)$/i,
];

interface Rule {
  id: string;
  risk: RiskLevel;
  reason: string;
  matches: (input: RiskInput) => boolean;
  anyOf?: readonly RegExp[];
}

const MANY_DELETED_LINES = 200;
const SOME_DELETED_LINES = 50;
const LARGE_CHANGE_LINES = 400;

const RULES: readonly Rule[] = [
  {
    id: 'deleted-file',
    risk: 'HIGH',
    reason: 'file deleted',
    matches: (input) => input.status === 'deleted',
  },
  {
    id: 'secret-file',
    risk: 'HIGH',
    reason: 'secret-bearing file',
    matches: (input) => SECRET_PATTERNS.some((pattern) => pattern.test(input.path)),
  },
  {
    id: 'security-module',
    risk: 'HIGH',
    reason: 'security-sensitive module',
    matches: (input) => SECURITY_DIR_PATTERNS.some((pattern) => pattern.test(input.path)),
  },
  {
    id: 'migration',
    risk: 'HIGH',
    reason: 'database migration or schema',
    matches: (input) => MIGRATION_PATTERNS.some((pattern) => pattern.test(input.path)),
  },
  {
    id: 'large-deletion',
    risk: 'HIGH',
    reason: `large deletion (>= ${MANY_DELETED_LINES} lines removed)`,
    matches: (input) => input.deletedLines >= MANY_DELETED_LINES,
  },
  {
    id: 'deploy-config',
    risk: 'MEDIUM',
    reason: 'build/deploy configuration',
    matches: (input) => DEPLOY_PATTERNS.some((pattern) => pattern.test(input.path)),
  },
  {
    id: 'manifest',
    risk: 'MEDIUM',
    reason: 'dependency manifest or lockfile',
    matches: (input) => MANIFEST_PATTERNS.some((pattern) => pattern.test(input.path)),
  },
  {
    id: 'config',
    risk: 'MEDIUM',
    reason: 'configuration change',
    matches: (input) => CONFIG_PATTERNS.some((pattern) => pattern.test(input.path)),
  },
  {
    id: 'generated',
    risk: 'MEDIUM',
    reason: 'generated artifact',
    matches: (input) => GENERATED_PATTERNS.some((pattern) => pattern.test(input.path)),
  },
  {
    id: 'binary',
    risk: 'MEDIUM',
    reason: 'binary file changed',
    matches: (input) => input.binary,
  },
  {
    id: 'substantial-deletion',
    risk: 'MEDIUM',
    reason: `substantial deletion (>= ${SOME_DELETED_LINES} lines removed)`,
    matches: (input) => input.deletedLines >= SOME_DELETED_LINES && input.deletedLines < MANY_DELETED_LINES,
  },
  {
    id: 'large-change',
    risk: 'MEDIUM',
    reason: `large change (>= ${LARGE_CHANGE_LINES} lines touched)`,
    matches: (input) =>
      input.addedLines + input.deletedLines >= LARGE_CHANGE_LINES &&
      input.deletedLines < SOME_DELETED_LINES,
  },
];

export function assessRisk(input: RiskInput): RiskAssessment {
  let risk: RiskLevel = 'LOW';
  const reasons: string[] = [];

  for (const rule of RULES) {
    if (!rule.matches(input)) continue;
    risk = maxRisk(risk, rule.risk);
    reasons.push(`[${rule.risk}] ${rule.reason}`);
  }

  if (input.changedSymbols.length > 0) {
    const shown = input.changedSymbols.slice(0, 5).join(', ');
    const more = input.changedSymbols.length > 5 ? ` (+${input.changedSymbols.length - 5} more)` : '';
    reasons.push(`touches ${input.changedSymbols.length} symbol(s): ${shown}${more}`);
  }

  if (reasons.length === 0) {
    reasons.push(isTestPath(input.path) ? 'test change' : 'source change');
  }

  return { risk, reasons };
}
