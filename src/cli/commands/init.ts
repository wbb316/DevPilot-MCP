import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { CliIo } from '../cli.js';
import { WorkspaceManager } from '../../workspace/workspace-manager.js';

export interface InitOptions {
  target: string;
  writeGitignore: boolean;
  json: boolean;
}

const GITIGNORE_LINE = '.devpilot/';

/**
 * `devpilot init [path]` — create the workspace-local DevPilot data directory.
 * Never restructures the project, and never edits .gitignore unless explicitly asked
 * (docs/WORKSPACE-LIFECYCLE.md §3).
 */
export async function initCommand(io: CliIo, options: InitOptions): Promise<number> {
  const target = path.resolve(options.target);
  const manager = new WorkspaceManager({ env: io.env });

  const result = await manager.openWorkspace({ path: target });
  const { workspace } = result;

  let gitignore: 'written' | 'present' | 'not-a-repo' | 'not-requested' = 'not-requested';
  if (workspace.git.isRepo) {
    const file = path.join(workspace.root, '.gitignore');
    let content = '';
    try {
      content = await fs.readFile(file, 'utf8');
    } catch {
      content = '';
    }
    const already = /^\s*\/?\.devpilot\/?\s*$/m.test(content);
    if (already) {
      gitignore = 'present';
    } else if (options.writeGitignore) {
      const prefix = content === '' || content.endsWith('\n') ? content : `${content}\n`;
      await fs.writeFile(file, `${prefix}${GITIGNORE_LINE}\n`, 'utf8');
      gitignore = 'written';
    }
  } else {
    gitignore = 'not-a-repo';
  }

  const payload = {
    workspace: {
      id: workspace.id,
      name: workspace.name,
      root: workspace.root,
      profile: workspace.profile,
      permission: workspace.permission,
      git: workspace.git,
    },
    createdDevpilotDir: result.createdDevpilotDir,
    configPath: result.configPath,
    devpilotHome: manager.home,
    gitignore,
    warnings: result.warnings,
  };

  if (options.json) {
    io.stdout(`${JSON.stringify(payload, null, 2)}\n`);
    return 0;
  }

  const lines = [
    `Initialised DevPilot workspace ${workspace.name}`,
    `  root        : ${workspace.root}`,
    `  devpilot dir: ${workspace.paths.devpilotDir}${result.createdDevpilotDir ? ' (created)' : ''}`,
    `  config      : ${result.configPath}`,
    `  home        : ${manager.home}`,
    `  detected    : ${workspace.profile.languages.join('/') || 'unknown'} / ${workspace.profile.projectType}`,
    `  build/test  : ${workspace.profile.buildSystem ?? 'none'} / ${workspace.profile.testFramework ?? 'none'}`,
    `  entrypoints : ${workspace.profile.entrypoints.join(', ') || '-'}`,
    `  git         : ${workspace.git.isRepo ? `${workspace.git.branch ?? 'detached'}${workspace.git.dirty ? ' (dirty)' : ''}` : 'no repository'}`,
  ];
  if (gitignore === 'written') lines.push(`  .gitignore  : added "${GITIGNORE_LINE}"`);
  else if (gitignore === 'present') lines.push(`  .gitignore  : already contains "${GITIGNORE_LINE}"`);
  else if (gitignore === 'not-a-repo') lines.push('  .gitignore  : skipped (not a git repository)');
  else lines.push(`  .gitignore  : add "${GITIGNORE_LINE}" yourself (or rerun with --write-gitignore)`);

  for (const warning of result.warnings) lines.push(`  warning     : ${warning}`);
  io.stdout(`${lines.join('\n')}\n`);
  return 0;
}
