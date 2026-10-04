/**
 * Workspace, security and project domain types.
 *
 * Frozen contract — see docs/DATA-MODEL.md §2/§3 and docs/WORKSPACE-LIFECYCLE.md.
 */

export type PermissionLevel = 'READ_ONLY' | 'SAFE_WRITE' | 'EXECUTE' | 'FULL';

export const PERMISSION_LEVELS: readonly PermissionLevel[] = [
  'READ_ONLY',
  'SAFE_WRITE',
  'EXECUTE',
  'FULL',
] as const;

/** Hard ceilings for one workspace session (docs/DATA-MODEL.md §2). */
export interface Limits {
  maxCommandSeconds: number;
  maxOutputBytes: number;
  maxFilesChanged: number;
  maxLinesChanged: number;
  maxFilesIndexed: number;
  maxFileSizeBytes: number;
  walkMaxDepth: number;
}

export interface CommandPolicyDecision {
  allowed: boolean;
  /** e.g. 'dangerous command: diskpart' */
  reason?: string;
  /** 'deny-list' | 'allow-list' | 'no-shell' | 'not-in-allow-list' */
  rule?: string;
}

export interface GitState {
  /** git binary found */
  available: boolean;
  isRepo: boolean;
  branch?: string;
  /** short sha */
  head?: string;
  /** tracked modifications present */
  dirty?: boolean;
  changedFiles?: number;
  untrackedFiles?: number;
  error?: string;
}

/** Resolved once at open time, never re-derived ad hoc. */
export interface WorkspacePaths {
  /** realpath'd, absolute, native separators */
  root: string;
  /** <root>/.devpilot */
  devpilotDir: string;
  /** <root>/.devpilot/config.yml */
  configFile: string;
  cacheDir: string;
  logsDir: string;
  checkpointsDir: string;
  /** <root>/.devpilot/devpilot.db */
  databaseFile: string;
}

export type IndexState = 'none' | 'stale' | 'ready' | 'failed';

export interface ProjectProfile {
  name: string;
  root: string;
  /** ['Python'] | ['Java','Kotlin'] | ['TypeScript','JavaScript'] */
  languages: string[];
  /** 'PyTorch' | 'SpringBoot' | 'Node' | 'Unknown' */
  projectType: string;
  framework?: string;
  /** 'maven' | 'gradle' | 'npm' | 'pnpm' | 'pip' | 'poetry' | 'none' */
  buildSystem?: string;
  /** 'pytest' | 'jest' | 'vitest' | 'junit' | 'none' */
  testFramework?: string;
  packageManager?: string;
  /** relative paths */
  entrypoints: string[];
  /** detected marker files */
  markers: string[];
  sourceDirs: string[];
  testDirs: string[];
  configDirs: string[];
  /** rule-inferred commands, never LLM-generated */
  candidates: { build?: string; test?: string; run?: string };
  /** ISO timestamp */
  detectedAt: string;
}

export interface WorkspaceState {
  /** stable hash of realpath */
  id: string;
  /** folder name */
  name: string;
  /** realpath, always absolute, native separators */
  root: string;
  paths: WorkspacePaths;
  /** effective for the session */
  permission: PermissionLevel;
  /** Phase 1: marker level; Phase 2: full scan */
  profile: ProjectProfile;
  git: GitState;
  indexState: IndexState;
  openedAt: string;
  lastUsedAt: string;
}

export interface WorkspaceRegistryEntry {
  id: string;
  name: string;
  root: string;
  lastOpenedAt: string;
}

export interface WorkspaceRegistry {
  version: 1;
  workspaces: WorkspaceRegistryEntry[];
}

export interface OpenWorkspaceOptions {
  path: string;
  name?: string;
  createConfig?: boolean;
  permission?: PermissionLevel;
}

export interface OpenWorkspaceData {
  workspace: WorkspaceState;
  createdDevpilotDir: boolean;
  configPath: string;
  gitNotice?: string;
}

export interface CloseWorkspaceData {
  closed: string;
  remainingOpen: number;
}
