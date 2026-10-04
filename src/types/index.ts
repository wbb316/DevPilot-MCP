export type {
  ErrorCode,
  ErrorDetail,
  OkEnvelope,
  ErrEnvelope,
  ToolEnvelope,
} from './errors.js';
export { ERROR_CODES, RETRYABLE_CODES, isErrorCode } from './errors.js';

export type {
  PermissionLevel,
  Limits,
  CommandPolicyDecision,
  GitState,
  WorkspacePaths,
  IndexState,
  ProjectProfile,
  WorkspaceState,
  WorkspaceRegistry,
  WorkspaceRegistryEntry,
  OpenWorkspaceOptions,
  OpenWorkspaceData,
  CloseWorkspaceData,
} from './workspace.js';
export { PERMISSION_LEVELS } from './workspace.js';

export type {
  SymbolKind,
  ReferenceKind,
  Visibility,
  SearchEngine,
  SearchConfidence,
  FileRecord,
  SymbolRecord,
  ReferenceRecord,
  ImportEdge,
  IndexMeta,
  SymbolHit,
  ReferenceHit,
  SearchResult,
} from './code.js';
export { SYMBOL_KINDS, REFERENCE_KINDS } from './code.js';

export type {
  JobKind,
  JobRecord,
  IssueSeverity,
  IssueEntry,
  ExecutionStatus,
  BuildResult,
  RunResult,
  TestStatus,
  TestFailure,
  TestDuration,
  TestResult,
} from './execution.js';

export type {
  DiagnosisCategory,
  DiagnosisConfidence,
  DiagnosisLocation,
  DiagnosisJobRef,
  DiagnosisResult,
  SuspectFile,
  SuspectReason,
} from './diagnosis.js';
export { DIAGNOSIS_CATEGORIES } from './diagnosis.js';

export type {
  ChangedFile,
  ChangedFileStatus,
  Checkpoint,
  CheckpointIndexFile,
  CheckpointKind,
  CreateCheckpointData,
  DiffReview,
  GitBaseline,
  GitStatusData,
  GitTotals,
  RiskLevel,
  RollbackCheckpointData,
} from './git.js';
export { EMPTY_TREE_SHA } from './git.js';

export type {
  AffectedConfidence,
  AffectedFile,
  AffectedReason,
  AffectedSymbol,
  ImpactDefinition,
  ImpactMethod,
  ImpactResult,
  ImpactRisk,
  ImpactRiskLevel,
  ImpactTargetKind,
} from './impact.js';
