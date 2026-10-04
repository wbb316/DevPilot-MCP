import type { AnyToolDefinition } from '../server/tool-registry.js';
import { closeWorkspaceTool } from './close-workspace.js';
import { getWorkspaceStatusTool } from './get-workspace-status.js';
import { openWorkspaceTool } from './open-workspace.js';

/**
 * Every tool the server registers. New tools are added here and are picked up by
 * `server/mcp-server.ts` automatically (docs/ARCHITECTURE.md §7).
 *
 * Phase 1: workspace lifecycle. Phases 2–9 add scan_project, get_project_map,
 * find_symbol, find_references, impact_analysis, run_project, run_tests,
 * diagnose_failure, review_diff, build_project, doctor, checkpoints and benchmark.
 */
export const ALL_TOOLS: readonly AnyToolDefinition[] = [
  openWorkspaceTool,
  getWorkspaceStatusTool,
  closeWorkspaceTool,
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
