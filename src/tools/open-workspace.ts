import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { permissionLevelSchema } from './shared.js';

const inputSchema = {
  path: z.string().min(1).describe('Absolute path to the project root to open.'),
  name: z.string().min(1).optional().describe('Display name; defaults to the folder name.'),
  createConfig: z
    .boolean()
    .optional()
    .describe('Create .devpilot/config.yml when missing (default true).'),
  permission: permissionLevelSchema
    .optional()
    .describe('Session permission ceiling; defaults to the workspace config value.'),
};

export const openWorkspaceTool = defineTool({
  name: 'open_workspace',
  title: 'Open workspace',
  description:
    'Open (and register) a project directory as the DevPilot workspace. Creates <root>/.devpilot/ when missing, loads or writes config.yml, detects the project type and snapshots git state. Every other tool resolves its paths through the workspace opened here.',
  permission: 'READ_ONLY',
  inputSchema,
  handler: async (args, { ctx }) => {
    const result = await ctx.workspaces.openWorkspace({
      path: args.path,
      ...(args.name === undefined ? {} : { name: args.name }),
      ...(args.createConfig === undefined ? {} : { createConfig: args.createConfig }),
      ...(args.permission === undefined ? {} : { permission: args.permission }),
    });

    const { workspace } = result;
    const languages = workspace.profile.languages.join('/') || 'unknown';
    const gitSummary = workspace.git.isRepo
      ? `${workspace.git.branch ?? 'detached'}${workspace.git.dirty ? ', dirty' : ', clean'}`
      : workspace.git.available
        ? 'no git repository'
        : 'git unavailable';

    const data = {
      workspace,
      createdDevpilotDir: result.createdDevpilotDir,
      configPath: result.configPath,
      ...(result.gitNotice === undefined ? {} : { gitNotice: result.gitNotice }),
    };

    return ok(
      `Opened workspace ${workspace.name} (${languages} / ${workspace.profile.projectType}) at ${workspace.root} — git: ${gitSummary}, permission: ${workspace.permission}.`,
      data,
      {
        warnings: result.warnings,
        artifacts: { config: '.devpilot/config.yml' },
      },
    );
  },
});
