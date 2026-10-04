/**
 * Git / diff / checkpoint domain types.
 *
 * Frozen contract — see docs/DATA-MODEL.md §6 and docs/TOOLS.md Phase 7.
 */

export type ChangedFileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'untracked';

export type RiskLevel = 'HIGH' | 'MEDIUM' | 'LOW';

export interface ChangedFile {
  path: string;
  status: ChangedFileStatus;
  addedLines: number;
  deletedLines: number;
  binary?: boolean;
  changedSymbols?: string[];
  risk: RiskLevel;
  reasons: string[];
}

export interface DiffReview {
  files: ChangedFile[];
  totals: { files: number; addedLines: number; deletedLines: number };
  riskLevel: RiskLevel;
  affectedTests: string[];
  /** Changed files that match no declared intent — empty until an intent set is supplied. */
  unrelatedFiles: string[];
  highRisk: string[];
  /** User edits that already existed when the workspace was opened. */
  preExistingChanges: string[];
  patchArtifact?: string;
  notes?: string[];
  truncated?: boolean;
}

export interface GitTotals {
  files: number;
  addedLines: number;
  deletedLines: number;
}

export type CheckpointKind = 'manual' | 'pre_write' | 'pre_command';

export interface Checkpoint {
  id: string;
  kind: CheckpointKind;
  createdAt: string;
  branch: string;
  head: string;
  label?: string;
  /** Workspace-relative POSIX paths recorded at creation time. */
  files: string[];
  /** Workspace-relative POSIX path of the patch artifact (audit trail of the created diff). */
  patchFile: string;
  /**
   * Workspace-relative POSIX path of the content snapshot directory. A restore writes these
   * bytes back, so it works even when the same file was edited again after the checkpoint.
   */
  snapshotDir: string;
  baseRef: string;
  dirtyAtCreate: boolean;
  /** Files whose content could not be snapshotted (too large or unreadable). */
  snapshotSkipped?: string[];
}

export interface CheckpointIndexFile {
  version: 1;
  checkpoints: Checkpoint[];
}

export interface CreateCheckpointData {
  checkpoint: Checkpoint;
  note: string;
}

export interface RollbackCheckpointData {
  restored: string[];
  skipped: string[];
  protectedUserChanges: string[];
  dryRun: boolean;
  /** Why a file was skipped or protected, plus what DevPilot deliberately did not touch. */
  notes?: string[];
}

export interface GitStatusData {
  branch?: string;
  head?: string;
  upstream?: string;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: string[];
  untracked: string[];
  /** True when changes already existed before DevPilot touched the workspace. */
  preExisting: boolean;
  devpilotCheckpoints: number;
}

/** Snapshot taken by `open_workspace`, used to separate user edits from agent edits. */
export interface GitBaseline {
  version: 1;
  capturedAt: string;
  head?: string;
  branch?: string;
  /** Workspace-relative POSIX paths of tracked modifications at open time. */
  changed: string[];
  untracked: string[];
}

export const EMPTY_TREE_SHA = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
