import { z } from 'zod';

import { defineTool } from '../server/tool-registry.js';
import { ok } from '../errors/envelope.js';
import { runDoctor } from '../environment/doctor.js';

/**
 * `doctor` — docs/TOOLS.md Phase 9. Machine-scoped and read-only: it needs no workspace, because the
 * question it answers ("what does this machine actually have?") is about the host, not the repo.
 * When a workspace is open its root is the directory the project-aware checks use.
 */

const inputSchema = {
  verbose: z
    .boolean()
    .optional()
    .describe('Include the probe inventory in notes (default false)'),
};

export const doctorTool = defineTool({
  name: 'doctor',
  title: 'Environment doctor',
  description:
    'Diagnose the local toolchain: OS/CPU/RAM, git, node/npm/pnpm, python/pip/conda, java/maven/gradle, docker, WSL, CUDA, GPU, plus conflicts (several pythons or JDKs on PATH, JAVA_HOME vs PATH, CUDA vs PyTorch, missing toolchain for this project, an unreachable docker daemon). Call it before concluding that a build failure is a code problem. It reports only — it never installs or reconfigures anything.',
  permission: 'READ_ONLY',
  requiresWorkspace: false,
  inputSchema,
  handler: async (args, context) => {
    const workspace = context.workspace;
    const cwd =
      workspace === undefined
        ? process.cwd()
        : (await context.ctx.workspaces.resolveEntry(workspace.id)).state.root;

    const report = await runDoctor({
      cwd,
      verbose: args.verbose === true,
      logger: context.ctx.logger,
    });

    const errors =
      report.tools.filter((tool) => tool.status === 'ERROR').length +
      report.conflicts.filter((conflict) => conflict.status === 'ERROR').length;
    const warnings =
      report.tools.filter((tool) => tool.status === 'WARNING').length +
      report.conflicts.filter((conflict) => conflict.status === 'WARNING').length;
    const ok_ = report.tools.filter((tool) => tool.status === 'OK').length;

    const summary =
      `environment ${report.overall} on ${report.os.platform} ${report.os.arch}: ` +
      `${ok_} toolchain probe(s) OK, ${warnings} warning(s), ${errors} error(s)`;

    return ok(summary, report, { warnings: report.notes });
  },
});
