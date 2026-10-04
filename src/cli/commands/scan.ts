import path from 'node:path';

import type { CliIo } from '../cli.js';
import { errors } from '../../errors/devpilot-error.js';
import { toPosix } from '../../security/path-policy.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';
import { scanProject } from '../../workspace/project-scanner.js';
import { formatBytes, formatDuration, topLanguages } from '../../util/format.js';

export interface ScanOptions {
  target: string;
  force: boolean;
  json: boolean;
}

/** `devpilot scan [path]` — the same work as the `scan_project` tool, for a human. */
export async function scanCommand(io: CliIo, options: ScanOptions): Promise<number> {
  const manager = new WorkspaceManager({ env: io.env });
  const opened = await manager.openWorkspace({
    path: path.resolve(options.target),
    createConfig: false,
  });
  const id = opened.workspace.id;
  const config = manager.configOf(id);
  const paths = manager.pathsOf(id);
  if (config === undefined || paths === undefined) {
    throw errors.internal('workspace configuration is not loaded after a successful open');
  }

  const result = await scanProject({
    root: opened.workspace.root,
    paths,
    config,
    name: opened.workspace.name,
    force: options.force,
    git: opened.workspace.git,
    logger: manager.loggerOf(id),
  });
  manager.applyScan(id, result.profile, result.indexState);

  if (options.json) {
    io.stdout(`${JSON.stringify(result, null, 2)}\n`);
    return 0;
  }

  const { profile, stats } = result;
  const lines = [
    `Workspace   : ${profile.name} (id ${id})`,
    `Type        : ${profile.languages.join('/') || 'unknown'} / ${profile.projectType}${profile.framework === undefined ? '' : ` (${profile.framework})`}`,
    `Files       : ${stats.files} files, ${stats.dirs} dirs, ${formatBytes(stats.bytes)} in ${formatDuration(stats.durationMs)}${stats.fromCache ? ' (cache hit)' : ''}`,
    `Languages   : ${topLanguages(result.languages) || '-'}`,
    `Markers     : ${profile.markers.join(', ') || '-'}`,
    `Entrypoints : ${profile.entrypoints.join(', ') || '-'}`,
    `Commands    : build=${profile.candidates.build ?? '-'} test=${profile.candidates.test ?? '-'} run=${profile.candidates.run ?? '-'}`,
    `Top level   : ${result.topLevel.slice(0, 8).map((entry) => `${entry.name}(${entry.hint})`).join(', ') || '-'}`,
    `Skipped     : oversized ${stats.skipped.oversized}, symlinks ${stats.skipped.symlinks}, excluded ${stats.skipped.excluded}, unreadable ${stats.skipped.unreadable}`,
    `Index       : ${result.indexState}`,
    `Cache       : ${toPosix(path.relative(opened.workspace.root, result.cacheFile))}`,
  ];
  for (const note of result.notes) lines.push(`Note        : ${note}`);
  if (stats.truncated) lines.push('Warning     : file cap reached — the profile is partial');
  for (const warning of opened.warnings) lines.push(`Warning     : ${warning}`);

  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
