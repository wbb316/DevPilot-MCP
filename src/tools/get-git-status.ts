import type { GitStatusData } from '../types/git.js';
import { defineTool } from '../server/tool-registry.js';
import { errors } from '../errors/devpilot-error.js';
import { ok } from '../errors/envelope.js';
import { GitManager } from '../git/git-manager.js';
import { CheckpointStore } from '../git/checkpoint-store.js';
import { readBaseline } from '../git/baseline.js';
import { requireWorkspaceContext } from './scan-project.js';
import { workspacePathSchema } from './shared.js';

/** `get_git_status` — docs/TOOLS.md Phase 7. Branch/HEAD/upstream plus the changed-path lists. */

const inputSchema = {
  path: workspacePathSchema,
};

export const getGitStatusTool = defineTool({
  name: 'get_git_status',
  title: 'Get git status',
  description:
    'Report local git state: branch, HEAD, upstream and ahead/behind counts, changed and untracked paths, whether those changes predate DevPilot (preExisting), and how many DevPilot checkpoints exist. Read-only.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (_args, context) => {
    const workspace = context.workspace;
    if (workspace === undefined) throw errors.workspaceNotOpen();
    const { paths } = requireWorkspaceContext(context.ctx, workspace);
    const entry = await context.ctx.workspaces.resolveEntry(workspace.id);

    const git = new GitManager({ cwd: entry.state.root, timeoutMs: 20_000 });
    if (!(await git.isAvailable())) throw errors.gitNotAvailable('git binary not found on PATH');
    const repoRoot = await git.repositoryRoot();
    if (repoRoot === undefined) {
      throw errors.gitNotAvailable(`${entry.state.root} is not inside a git repository`);
    }

    const statuses = await git.pathStatuses();
    const changedFiles = [...statuses.entries()]
      .filter(([, xy]) => xy !== '??')
      .map(([file]) => file)
      .sort();
    const untracked = [...statuses.entries()]
      .filter(([, xy]) => xy === '??')
      .map(([file]) => file)
      .sort();

    const branch = await git.currentBranch();
    const head = await git.revParse('HEAD');
    const upstream = await git.upstream();
    const baseline = await readBaseline(paths);
    const store = new CheckpointStore(paths);

    const notes: string[] = [];
    if (baseline === undefined) {
      notes.push('no baseline was captured for this workspace: preExisting cannot be decided');
    }
    if (repoRoot !== entry.state.root) {
      notes.push(`paths are relative to the repository root ${repoRoot}, not to the workspace root`);
    }

    const data: GitStatusData = {
      ...(branch === undefined ? {} : { branch }),
      ...(head === undefined ? {} : { head: head.slice(0, 7) }),
      ...(upstream === undefined ? {} : { upstream: upstream.name }),
      ahead: upstream?.ahead ?? 0,
      behind: upstream?.behind ?? 0,
      dirty: changedFiles.length + untracked.length > 0,
      changedFiles,
      untracked,
      preExisting: baseline === undefined ? false : changedFiles.some((file) => baseline.changed.includes(file)),
      devpilotCheckpoints: await store.count(),
    };

    const summary = [
      `${data.branch ?? 'DETACHED'}${data.head === undefined ? '' : ` @ ${data.head}`}`,
      `${data.changedFiles.length} changed, ${data.untracked.length} untracked`,
      data.dirty ? 'dirty' : 'clean',
      upstream === undefined ? 'no upstream' : `${upstream.ahead} ahead / ${upstream.behind} behind ${upstream.name}`,
      `${data.devpilotCheckpoints} checkpoint(s)`,
    ].join('; ');

    return ok(summary, data, { warnings: notes });
  },
});
