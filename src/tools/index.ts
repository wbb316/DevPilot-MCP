import type { AnyToolDefinition } from '../server/tool-registry.js';
import { closeWorkspaceTool } from './close-workspace.js';
import { findReferencesTool } from './find-references.js';
import { findSymbolTool } from './find-symbol.js';
import { getProjectMapTool } from './get-project-map.js';
import { getWorkspaceStatusTool } from './get-workspace-status.js';
import { openWorkspaceTool } from './open-workspace.js';
import { scanProjectTool } from './scan-project.js';

/**
 * Every tool the server registers. New tools are added here and are picked up by
 * `server/mcp-server.ts` automatically (docs/ARCHITECTURE.md §7).
 *
 * Phase 1: workspace lifecycle. Phase 2: project scan and project map. Phases 3–9 add
 * find_symbol, find_references, impact_analysis, build_project, run_project, run_tests,
 * diagnose_failure, review_diff, doctor, checkpoints and benchmark.
 */
export const ALL_TOOLS: readonly AnyToolDefinition[] = [
  openWorkspaceTool,
  getWorkspaceStatusTool,
  closeWorkspaceTool,
  scanProjectTool,
  getProjectMapTool,
  findSymbolTool,
  findReferencesTool,
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
