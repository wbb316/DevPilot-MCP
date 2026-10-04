import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { WorkspacePaths } from '../types/workspace.js';

/**
 * Storage layout (docs/WORKSPACE-LIFECYCLE.md §3, docs/DATA-MODEL.md §9).
 *
 * Two very different places:
 *  - DevPilot home (machine level): registry + server logs. Never inside a project.
 *  - <workspace>\.devpilot\ (project level): config, cache, logs, checkpoints, index DB.
 */

export function devpilotHome(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env['DEVPILOT_HOME'];
  if (explicit && explicit.trim() !== '') return path.resolve(explicit);

  if (process.platform === 'win32') {
    const localAppData = env['LOCALAPPDATA'] ?? env['APPDATA'];
    if (localAppData && localAppData.trim() !== '') return path.join(localAppData, 'DevPilot');
    return path.join(os.homedir(), 'AppData', 'Local', 'DevPilot');
  }

  const xdg = env['XDG_DATA_HOME'];
  if (xdg && xdg.trim() !== '') return path.join(xdg, 'devpilot');
  return path.join(os.homedir(), '.local', 'share', 'devpilot');
}

export function registryFile(home: string): string {
  return path.join(home, 'registry.json');
}

export function globalConfigFile(home: string): string {
  return path.join(home, 'config.json');
}

export function globalLogsDir(home: string): string {
  return path.join(home, 'logs');
}

/** Resolved once at open time and carried in WorkspaceState.paths. */
export function workspacePaths(root: string): WorkspacePaths {
  const devpilotDir = path.join(root, '.devpilot');
  return {
    root,
    devpilotDir,
    configFile: path.join(devpilotDir, 'config.yml'),
    cacheDir: path.join(devpilotDir, 'cache'),
    logsDir: path.join(devpilotDir, 'logs'),
    checkpointsDir: path.join(devpilotDir, 'checkpoints'),
    databaseFile: path.join(devpilotDir, 'devpilot.db'),
  };
}

export async function pathExists(target: string): Promise<boolean> {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

/** mkdir -p that reports whether the directory already existed. */
export async function ensureDir(dir: string): Promise<boolean> {
  const existed = await pathExists(dir);
  await fs.mkdir(dir, { recursive: true });
  return !existed;
}

export interface WorkspaceLayoutResult {
  /** true when <root>\.devpilot did not exist before this call. */
  createdDevpilotDir: boolean;
  devpilotDir: string;
}

/** Create <root>\.devpilot\{cache,logs,checkpoints}. Never touches user files. */
export async function ensureWorkspaceLayout(paths: WorkspacePaths): Promise<WorkspaceLayoutResult> {
  const createdDevpilotDir = await ensureDir(paths.devpilotDir);
  await ensureDir(paths.cacheDir);
  await ensureDir(paths.logsDir);
  await ensureDir(paths.checkpointsDir);
  return { createdDevpilotDir, devpilotDir: paths.devpilotDir };
}

export async function ensureHomeLayout(home: string): Promise<void> {
  await ensureDir(home);
  await ensureDir(globalLogsDir(home));
}

/** `devpilot-YYYYMMDD.log` for a workspace, plus the machine-level log file. */
export function workspaceLogFile(paths: WorkspacePaths, now: Date = new Date()): string {
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  return path.join(paths.logsDir, `devpilot-${stamp}.log`);
}

export function globalLogFile(home: string): string {
  return path.join(globalLogsDir(home), 'devpilot.log');
}
