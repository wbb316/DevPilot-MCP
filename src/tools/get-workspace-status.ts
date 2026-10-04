import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { workspacePathSchema } from './shared.js';

const inputSchema = {
  path: workspacePathSchema,
};

export const getWorkspaceStatusTool = defineTool({
  name: 'get_workspace_status',
  title: 'Get workspace status',
  description:
    'Report the current workspace state: resolved root, project profile, git snapshot, index state, DevPilot home and how many workspaces are known. Use it to confirm which workspace a session is bound to before acting.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, { ctx }) => {
    const status = await ctx.workspaces.getStatus(args.path);
    const { workspace } = status;
    const gitSummary = workspace.git.isRepo
      ? `${workspace.git.branch ?? 'detached'}@${workspace.git.head ?? '?'}${workspace.git.dirty ? ' (dirty)' : ''}`
      : 'no git repository';

    return ok(
      `Workspace ${workspace.name} is open at ${workspace.root}: ${workspace.profile.languages.join('/') || 'unknown'} / ${workspace.profile.projectType}, git ${gitSummary}, index ${status.index.state}.`,
      status,
    );
  },
});
