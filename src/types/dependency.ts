/**
 * Dependency-audit domain types — docs/TOOLS.md Phase 9 (`dependency_audit`).
 *
 * The `data` keys frozen by docs/TOOLS.md are `ecosystems`, `direct`, `transitive`,
 * `outdated`, `vulnerable` (optional) and `lockIssues`. Additions are allowed, renames are
 * not, so the extra keys of `DependencyAuditResult` are documented here rather than folded
 * into the frozen shape: `notes`, `truncated`, `network`, `scannedFiles`.
 *
 * `outdated[]` and `vulnerable[]` need a registry (network). This build is offline by
 * default: with `network: false` the tool returns an empty `outdated`, omits `vulnerable`
 * entirely and says so in `notes` plus a `warnings` entry. It never opens a socket.
 */

/** The package ecosystems this tool understands. */
export type DependencyEcosystem = 'npm' | 'python' | 'maven' | 'gradle';

/** Declaration bucket, kept so a caller can tell a test-only dependency from a runtime one. */
export type DependencyScope = 'runtime' | 'dev' | 'optional' | 'peer' | 'managed';

/** How the specifier was written in the manifest, which is what the issue checks reason about. */
export type DependencySpecKind = 'exact' | 'range' | 'unpinned' | 'unresolved' | 'vcs' | 'catalog';

/** One declared dependency, as written in one manifest. */
export interface DependencyRecord {
  /** bare package name (`@scope/name` for npm, `group:artifact` for maven/gradle) */
  name: string;
  /** the specifier verbatim (`^1.2.3`, `>=2.1`, `${junit.version}`), '' when the format has none */
  spec: string;
  kind: DependencySpecKind;
  scope: DependencyScope;
  /** workspace-relative POSIX path of the manifest that declared it */
  source: string;
  /** requested version(s) when a specifier could be reduced to one ('' when it could not) */
  requestedVersion?: string;
  /** groupId / group for maven and gradle */
  group?: string;
}

/** One entry of `ecosystems[]`. */
export interface EcosystemDependencyProfile {
  name: DependencyEcosystem;
  /** workspace-relative POSIX paths of every manifest read for this ecosystem, sorted */
  manifestFiles: string[];
  /** distinct declared dependencies (same name declared twice counts once) */
  direct: number;
  /**
   * Dependencies that only a lockfile knows about. 0 when the ecosystem has no lockfile:
   * that is a fact about the input, not a claim that the project has no transitive deps.
   */
  transitive: number;
  lockFile?: string;
  notes?: string[];
}

export type LockIssueKind =
  | 'missing_lock'
  | 'lock_out_of_sync'
  | 'unpinned'
  | 'duplicate_version'
  | 'unresolved_version'
  | 'missing_manifest';

/** One finding. Derived from parsed data only — never guessed. */
export interface LockIssue {
  path: string;
  kind: LockIssueKind;
  message: string;
  severity: 'WARNING' | 'ERROR';
}

/** A dependency that a registry would report as outdated. Empty without network. */
export interface OutdatedDependency {
  name: string;
  ecosystem: DependencyEcosystem;
  current: string;
  latest?: string;
  wanted?: string;
  source: string;
}

/** `data` of the `dependency_audit` tool. */
export interface DependencyAuditResult {
  ecosystems: EcosystemDependencyProfile[];
  direct: number;
  transitive: number;
  outdated: OutdatedDependency[];
  vulnerable?: unknown[];
  lockIssues: LockIssue[];
  /** Why the result looks the way it does (offline, no manifests, truncation). */
  notes: string[];
  /** A read cap was hit: at most READ_FILE_LIMIT files and MAX_FILE_BYTES per file. */
  truncated: boolean;
  /** Echo of the `network` input: false means `outdated` is empty and `vulnerable` absent. */
  network: boolean;
  /** Number of manifests and lockfiles actually read. */
  scannedFiles: number;
}

/** Options of the pure analyzer (`src/environment/dependency-audit.ts`). */
export interface DependencyAuditOptions {
  root: string;
  exclude: readonly string[];
  /** Per-file read cap. Defaults to MAX_FILE_BYTES (5 MiB). */
  maxFileSizeBytes?: number;
  /** Registry lookups; this build never enables it. */
  network?: boolean;
}
