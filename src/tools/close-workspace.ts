import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { closeSymbolIndex } from '../code/index-registry.js';
import { workspacePathSchema } from './shared.js';

const inputSchema = {
  path: workspacePathSchema,
};

export const closeWorkspaceTool = defineTool({
  name: 'close_workspace',
  title: 'Close workspace',
  description:
    'Release a workspace from this session. The registry entry is kept so it can be reopened, and nothing inside <root>/.devpilot/ is deleted.',
  permission: 'READ_ONLY',
  requiresWorkspace: true,
  inputSchema,
  handler: async (args, { ctx }) => {
    // Resolve first so the symbol index of that workspace can be flushed and released.
    let closingId: string | undefined;
    try {
      const entry = await ctx.workspaces.resolveEntry(args.path);
      closingId = entry.state.id;
    } catch {
      /* not open under this selector: close() below reports it */
    }

    const result = await ctx.workspaces.close(args.path);
    if (closingId !== undefined) await closeSymbolIndex(closingId);

    return ok(
      `Closed workspace ${result.closed}; ${result.remainingOpen} workspace(s) still open.`,
      result,
    );
  },
});
