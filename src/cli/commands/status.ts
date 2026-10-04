import path from 'node:path';

import type { CliIo } from '../cli.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';

export interface StatusOptions {
  target: string;
  json: boolean;
}

/** `devpilot status [path]` — what a human wants to know before handing the repo to an agent. */
export async function statusCommand(io: CliIo, options: StatusOptions): Promise<number> {
  const target = path.resolve(options.target);
  const manager = new WorkspaceManager({ env: io.env });
  const result = await manager.openWorkspace({ path: target, createConfig: false });
  const status = await manager.getStatus(result.workspace.id);

  if (options.json) {
    io.stdout(`${JSON.stringify(status, null, 2)}\n`);
    return 0;
  }

  const { workspace } = status;
  const profile = workspace.profile;
  const lines = [
    `Workspace   : ${workspace.name} (id ${workspace.id})`,
    `Root        : ${workspace.root}`,
    `Type        : ${profile.languages.join('/') || 'unknown'} / ${profile.projectType}${profile.framework ? ` (${profile.framework})` : ''}`,
    `Build/test  : ${profile.buildSystem ?? 'none'} / ${profile.testFramework ?? 'none'}`,
    `Markers     : ${profile.markers.join(', ') || '-'}`,
    `Entrypoints : ${profile.entrypoints.join(', ') || '-'}`,
    `Source dirs : ${profile.sourceDirs.join(', ') || '-'}`,
    `Candidates  : build=${profile.candidates.build ?? '-'} test=${profile.candidates.test ?? '-'} run=${profile.candidates.run ?? '-'}`,
    `Git         : ${workspace.git.isRepo ? `${workspace.git.branch ?? 'detached'}@${workspace.git.head ?? '?'}${workspace.git.dirty ? ` dirty(${workspace.git.changedFiles ?? 0} changed, ${workspace.git.untrackedFiles ?? 0} untracked)` : ' clean'}` : workspace.git.available ? 'no repository' : 'unavailable'}`,
    `Index       : ${status.index.state}`,
    `Permission  : ${workspace.permission}`,
    `DevPilot    : ${workspace.paths.devpilotDir}`,
    `Home        : ${status.devpilotHome} (${status.registry.known} known workspace(s))`,
  ];
  for (const warning of result.warnings) lines.push(`Warning     : ${warning}`);

  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
