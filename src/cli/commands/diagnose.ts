import path from 'node:path';

import type { CliIo } from '../cli.js';
import { errors } from '../../errors/devpilot-error.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { describeDiagnosis, diagnoseJob } from '../../diagnose/diagnose-job.js';

export interface DiagnoseCommandOptions {
  target: string;
  jobId?: string;
  logFile?: string;
  maxEvidence?: number;
  json: boolean;
}

/**
 * `devpilot diagnose [path]` — the CLI twin of the `diagnose_failure` tool. Same use case, same
 * numbers: it classifies the last failed job and prints only the evidence that matters.
 *
 * Exit codes: 0 a diagnosis was produced (read-only report), 2 a DevPilot error (nothing to
 * diagnose, unknown job, path outside the workspace).
 */
export async function diagnoseCommand(io: CliIo, options: DiagnoseCommandOptions): Promise<number> {
  const manager = new WorkspaceManager({ env: io.env });
  const opened = await manager.openWorkspace({
    path: path.resolve(options.target),
    createConfig: false,
  });
  const id = opened.workspace.id;
  const paths = manager.pathsOf(id);
  const logger = manager.loggerOf(id);
  if (paths === undefined) {
    throw errors.internal('workspace paths are not loaded after a successful open');
  }

  const result = await diagnoseJob({
    workspaceId: id,
    root: opened.workspace.root,
    paths,
    ...(logger === undefined ? {} : { logger }),
    ...(options.jobId === undefined ? {} : { jobId: options.jobId }),
    ...(options.logFile === undefined ? {} : { logFile: options.logFile }),
    ...(options.maxEvidence === undefined ? {} : { maxEvidence: options.maxEvidence }),
  });

  if (options.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const lines = [
    `Category    : ${describeDiagnosis(result)}`,
    `Location    : ${
      result.location === undefined
        ? 'none extracted'
        : `${result.location.path}${result.location.line === undefined ? '' : `:${result.location.line}`}`
    }`,
    `Command     : ${result.relatedJob?.command ?? '(unknown — diagnosed from a log file)'}`,
  ];
  for (const line of result.evidence) lines.push(`Evidence    : ${line}`);
  for (const suspect of result.suspectFiles.slice(0, 10)) {
    lines.push(`Suspect     : ${suspect.reason.padEnd(16)} ${suspect.path}`);
  }
  if (result.suspectFiles.length > 10) {
    lines.push(`Suspect     : … ${result.suspectFiles.length - 10} more`);
  }
  if (result.hint !== undefined) lines.push(`Hint        : ${result.hint}`);
  if (result.logFile !== undefined) lines.push(`Log         : ${result.logFile}`);
  for (const note of result.notes ?? []) lines.push(`Note        : ${note}`);
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
