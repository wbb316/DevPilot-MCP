import type { AnyToolDefinition } from '../server/tool-registry.js';
import { buildProjectTool } from './build-project.js';
import { closeWorkspaceTool } from './close-workspace.js';
import { createCheckpointTool } from './create-checkpoint.js';
import { diagnoseFailureTool } from './diagnose-failure.js';
import { findReferencesTool } from './find-references.js';
import { findSymbolTool } from './find-symbol.js';
import { getGitStatusTool } from './get-git-status.js';
import { getProjectMapTool } from './get-project-map.js';
import { getWorkspaceStatusTool } from './get-workspace-status.js';
import { impactAnalysisTool } from './impact-analysis.js';
import { openWorkspaceTool } from './open-workspace.js';
import { reviewDiffTool } from './review-diff.js';
import { rollbackCheckpointTool } from './rollback-checkpoint.js';
import { runProjectTool } from './run-project.js';
import { runTestTool } from './run-test.js';
import { runTestsTool } from './run-tests.js';
import { scanProjectTool } from './scan-project.js';

/**
 * Every tool the server registers. New tools are added here and are picked up by
 * `server/mcp-server.ts` automatically (docs/ARCHITECTURE.md §7).
 *
 * Phase 1: workspace lifecycle. Phase 2: project scan and project map. Phase 3: symbol and
 * reference search. Phase 4: build and run. Phase 5: test runner. Phase 6: failure diagnosis.
 * Phase 7: diff review and checkpoints. Phases 8–9 add impact_analysis, doctor and
 * dependency_audit.
 */
export const ALL_TOOLS: readonly AnyToolDefinition[] = [
  openWorkspaceTool,
  getWorkspaceStatusTool,
  closeWorkspaceTool,
  scanProjectTool,
  getProjectMapTool,
  findSymbolTool,
  findReferencesTool,
  buildProjectTool,
  runProjectTool,
  runTestsTool,
  runTestTool,
  diagnoseFailureTool,
  reviewDiffTool,
  getGitStatusTool,
  createCheckpointTool,
  rollbackCheckpointTool,
  impactAnalysisTool,
];

/** Tool names grouped by delivery phase, used by the CLI and by tests. */
export const TOOLS_BY_PHASE: Record<number, readonly string[]> = {
  1: ['open_workspace', 'get_workspace_status', 'close_workspace'],
  2: ['scan_project', 'get_project_map'],
  3: ['find_symbol', 'find_references'],
  4: ['build_project', 'run_project'],
  5: ['run_tests', 'run_test'],
  6: ['diagnose_failure'],
  7: ['review_diff', 'get_git_status', 'create_checkpoint', 'rollback_checkpoint'],
  8: ['impact_analysis'],
  9: ['doctor', 'dependency_audit'],
};
