import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { IndexState, OpenWorkspaceData, OpenWorkspaceOptions, PermissionLevel, ProjectProfile, WorkspacePaths, WorkspaceRegistry, WorkspaceRegistryEntry, WorkspaceState } from '../types/workspace.js';
import { PERMISSION_LEVELS } from '../types/workspace.js';
import { errors } from '../errors/devpilot-error.js';
import { GitManager } from '../git/git-manager.js';
import { loadWorkspaceConfig } from '../config/config-loader.js';
import { capabilities, type SessionCapabilities } from '../security/permission.js';
import { isInside, longestRootMatch, nodeErrorToDevPilot, normalizeForCompare } from '../security/path-policy.js';
import { createLogger, silentLogger } from '../log/logger.js';
import { devpilotHome, ensureDir, ensureHomeLayout, ensureWorkspaceLayout, globalConfigFile, registryFile, workspaceLogFile, workspacePaths } from '../storage/paths.js';
import { readJson, writeJsonAtomic } from '../storage/json-store.js';
import { detectProject } from './project-detector.js';

/**
 * Workspace lifecycle (docs/WORKSPACE-LIFECYCLE.md §2). The workspace is both the unit of
 * context and the security boundary: every later phase resolves paths, commands and caches
 * through the state created here.
 */

export interface WorkspaceManagerOptions {
  /** DevPilot home (machine level). Defaults to $DEVPILOT_HOME or %LOCALAPPDATA%\DevPilot. */
  home?: string;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
}

/** OpenWorkspaceData plus the notices the tool layer turns into `envelope.warnings`. */
export interface OpenWorkspaceResult extends OpenWorkspaceData {
  warnings: string[];
}

export interface WorkspaceStatusData {
  workspace: WorkspaceState;
  git: WorkspaceState['git'];
  index: { state: IndexState; fileCount?: number };
  devpilotHome: string;
  registry: { known: number };
}

interface OpenEntry {
  state: WorkspaceState;
  paths: WorkspacePaths;
  config: DevPilotConfig;
  logger: Logger;
}

export function isPermissionLevel(value: unknown): value is PermissionLevel {
  return typeof value === 'string' && (PERMISSION_LEVELS as readonly string[]).includes(value);
}

/** Stable, case-insensitive-on-Windows workspace identity. */
export function workspaceId(root: string): string {
  return createHash('sha1').update(normalizeForCompare(root)).digest('hex').slice(0, 12);
}

export class WorkspaceManager {
  readonly home: string;
  private readonly baseLogger: Logger;
  private readonly env: NodeJS.ProcessEnv;
  private readonly open = new Map<string, OpenEntry>();
  private activeId?: string;

  constructor(options: WorkspaceManagerOptions = {}) {
    this.env = options.env ?? process.env;
    this.home = options.home ?? devpilotHome(this.env);
    this.baseLogger = options.logger ?? silentLogger('workspace');
  }

  /** true when at least one workspace is open in this session. */
  get hasOpen(): boolean {
    return this.open.size > 0;
  }

  get activeWorkspaceId(): string | undefined {
    return this.activeId;
  }

  listOpen(): WorkspaceState[] {
    return [...this.open.values()].map((entry) => entry.state);
  }

  getActive(): WorkspaceState | undefined {
    return this.activeId === undefined ? undefined : this.open.get(this.activeId)?.state;
  }

  configOf(id: string): DevPilotConfig | undefined {
    return this.open.get(id)?.config;
  }

  loggerOf(id: string): Logger | undefined {
    return this.open.get(id)?.logger;
  }

  pathsOf(id: string): WorkspacePaths | undefined {
    return this.open.get(id)?.paths;
  }

  /** Session capabilities: permission level + limited execute + shell policy. */
  sessionCapabilities(state: WorkspaceState): SessionCapabilities {
    const config = this.open.get(state.id)?.config;
    return capabilities(state.permission, {
      execute: config?.security.execute ?? true,
      allowShell: config?.security.allow_shell ?? false,
    });
  }

  async openWorkspace(options: OpenWorkspaceOptions): Promise<OpenWorkspaceResult> {
    const warnings: string[] = [];
    const requested = (options.path ?? '').trim();
    if (requested === '') {
      throw errors.invalidArgument('open_workspace requires `path` (absolute path of the project root).');
    }

    // 1. the path must exist and be a directory
    const absolute = path.resolve(requested);
    let stats;
    try {
      stats = await fs.stat(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw errors.fileNotFound(absolute, 'no such directory');
      }
      throw nodeErrorToDevPilot(absolute, error);
    }
    if (!stats.isDirectory()) throw errors.workspaceNotFound(absolute, 'not a directory');

    // 2./3. realpath (kills symlink escapes) → stable id
    const realRoot = await fs.realpath(absolute);
    const id = workspaceId(realRoot);
    const now = new Date().toISOString();

    const existing = this.open.get(id);
    if (existing) {
      // Idempotent reopen: nothing is recreated, but the outside world may have moved on,
      // so the git snapshot and the notices are refreshed (docs/WORKSPACE-LIFECYCLE.md §2).
      existing.state.lastUsedAt = now;
      if (options.permission !== undefined) {
        existing.state.permission = this.effectivePermission(options.permission, existing.config);
      }
      existing.state.git = await this.probeGit(realRoot, warnings);
      await this.touchRegistry({ id, name: existing.state.name, root: realRoot, lastOpenedAt: now });
      await this.collectNotices(existing.state, warnings);
      this.activeId = id;

      const reopened: OpenWorkspaceResult = {
        workspace: existing.state,
        createdDevpilotDir: false,
        configPath: existing.state.paths.configFile,
        warnings,
      };
      const reopenNotice = this.gitNotice(existing.state.git);
      if (reopenNotice !== undefined) reopened.gitNotice = reopenNotice;
      return reopened;
    }

    await ensureHomeLayout(this.home);

    // 4. <root>\.devpilot\ {cache,logs,checkpoints}
    const paths = workspacePaths(realRoot);
    const layout = await ensureWorkspaceLayout(paths);

    // 5. config (CONFIG_INVALID aborts the open and leaves the file untouched)
    const loaded = await loadWorkspaceConfig(paths, {
      create: options.createConfig ?? true,
      globalConfigPath: globalConfigFile(this.home),
    });
    const config = loaded.config;

    // 6. project detection (Phase 1: marker level)
    const profile = await detectProject(realRoot, {
      name: options.name ?? path.basename(realRoot),
      config,
    });

    // 7. git snapshot — never fatal
    const git = await this.probeGit(realRoot, warnings);

    const logger = createLogger({
      name: `workspace:${path.basename(realRoot)}`,
      file: workspaceLogFile(paths),
    });
    logger.info('workspace opened', { id, root: realRoot, permission: options.permission ?? config.security.permission });

    const state: WorkspaceState = {
      id,
      name: options.name ?? path.basename(realRoot),
      root: realRoot,
      paths,
      permission: this.effectivePermission(options.permission, config),
      profile,
      git,
      indexState: 'none',
      openedAt: now,
      lastUsedAt: now,
    };

    // 8. registry (machine level)
    await this.touchRegistry({ id, name: state.name, root: realRoot, lastOpenedAt: now });

    // 9./10. notices an agent (and a human) should see
    if (loaded.created) {
      warnings.push(`created ${path.relative(realRoot, paths.configFile)} with default settings`);
    }
    await this.collectNotices(state, warnings);

    this.open.set(id, { state, paths, config, logger });
    this.activeId = id;

    const data: OpenWorkspaceResult = {
      workspace: state,
      createdDevpilotDir: layout.createdDevpilotDir,
      configPath: paths.configFile,
      warnings,
    };
    const gitNotice = this.gitNotice(git);
    if (gitNotice !== undefined) data.gitNotice = gitNotice;
    return data;
  }

  async getStatus(target?: string): Promise<WorkspaceStatusData> {
    const entry = await this.resolveEntry(target);
    entry.state.lastUsedAt = new Date().toISOString();

    const index: { state: IndexState; fileCount?: number } = { state: entry.state.indexState };
    const cached = await this.readCachedScanCount(entry.paths);
    if (cached !== undefined) index.fileCount = cached;

    const registry = await this.readRegistry();
    return {
      workspace: entry.state,
      git: entry.state.git,
      index,
      devpilotHome: this.home,
      registry: { known: registry.workspaces.length },
    };
  }

  async close(target?: string): Promise<{ closed: string; remainingOpen: number }> {
    const entry = await this.resolveEntry(target);
    this.open.delete(entry.state.id);
    if (this.activeId === entry.state.id) this.activeId = undefined;
    entry.logger.info('workspace closed', { id: entry.state.id });
    return { closed: entry.state.id, remainingOpen: this.open.size };
  }

  async listKnown(): Promise<WorkspaceRegistryEntry[]> {
    return (await this.readRegistry()).workspaces;
  }

  /**
   * Record the outcome of a scan on the live session state (Phase 2). The tool layer calls
   * this so `get_workspace_status` reports the full profile instead of the marker-level one
   * produced at open time.
   */
  applyScan(id: string, profile: ProjectProfile, indexState: IndexState): void {
    const entry = this.open.get(id);
    if (entry === undefined) return;
    entry.state.profile = profile;
    entry.state.indexState = indexState;
    entry.state.lastUsedAt = new Date().toISOString();
  }

  /** Record the outcome of an index refresh on the live session state (Phase 3). */
  setIndexState(id: string, indexState: IndexState): void {
    const entry = this.open.get(id);
    if (entry === undefined) return;
    entry.state.indexState = indexState;
    entry.state.lastUsedAt = new Date().toISOString();
  }

  /** Resolve the workspace a tool call refers to, or throw a typed error. */
  async resolveEntry(target?: string): Promise<OpenEntry> {
    const trimmed = (target ?? '').trim();
    if (trimmed === '') {
      const active = this.activeId === undefined ? undefined : this.open.get(this.activeId);
      if (!active) throw errors.workspaceNotOpen();
      return active;
    }

    // A workspace may be named by its id, by an absolute path, or by a path relative to
    // the active workspace (docs/TOOLS.md).
    const byId = this.open.get(trimmed);
    if (byId) return byId;

    if (!path.isAbsolute(trimmed)) {
      const active = this.activeId === undefined ? undefined : this.open.get(this.activeId);
      const ordered: OpenEntry[] = active === undefined ? [...this.open.values()] : [active, ...this.open.values()];
      for (const entry of ordered) {
        const candidate = path.resolve(entry.state.root, trimmed);
        if (candidate === entry.state.root || isInside(entry.state.root, candidate)) return entry;
      }
    }

    const absolute = path.resolve(trimmed);
    const roots = [...this.open.values()].map((entry) => entry.state.root);
    const match = longestRootMatch(roots, absolute);
    if (match !== undefined) {
      const found = [...this.open.values()].find(
        (entry) => normalizeForCompare(entry.state.root) === normalizeForCompare(match),
      );
      if (found) return found;
    }

    const registry = await this.readRegistry();
    const known = registry.workspaces.find(
      (entry) =>
        normalizeForCompare(entry.root) === normalizeForCompare(absolute) ||
        longestRootMatch([entry.root], absolute) !== undefined,
    );
    if (known) {
      throw errors.workspaceNotOpen(
        `${known.root} is a known workspace but is not open in this session`,
      );
    }
    throw errors.workspaceNotFound(absolute, 'no open or known workspace matches this path');
  }

  private effectivePermission(
    requested: PermissionLevel | undefined,
    config: DevPilotConfig,
  ): PermissionLevel {
    if (requested !== undefined) return requested;
    const fromConfig = config.security.permission;
    return isPermissionLevel(fromConfig) ? fromConfig : 'SAFE_WRITE';
  }

  /**
   * Notices an agent (and a human) should see on open and on reopen: git availability,
   * a dirty tree that must be protected, and a .gitignore that would commit DevPilot data.
   */
  private async collectNotices(state: WorkspaceState, warnings: string[]): Promise<void> {
    const git = state.git;
    if (git.available && git.isRepo && !(await this.gitignoreCoversDevpilot(state.root))) {
      warnings.push('.devpilot/ is not listed in .gitignore — add it so workspace data stays out of git');
    }
    if (!git.available) {
      warnings.push('git is not available on PATH; git-backed tools will report GIT_NOT_AVAILABLE');
    }
    if (git.isRepo && git.dirty) {
      warnings.push(
        `working tree already has ${git.changedFiles ?? 0} changed and ${git.untrackedFiles ?? 0} untracked file(s); DevPilot will not touch them`,
      );
    }
  }

  private async probeGit(root: string, warnings: string[]): Promise<WorkspaceState['git']> {
    try {
      return await new GitManager({ cwd: root, logger: this.baseLogger }).probe();
    } catch (error) {
      warnings.push(`git probe failed: ${error instanceof Error ? error.message : String(error)}`);
      return {
        available: true,
        isRepo: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private gitNotice(git: WorkspaceState['git']): string | undefined {
    if (!git.available) return 'git is not available; git features are disabled for this session';
    if (!git.isRepo) return 'not a git repository; checkpoint and diff tools are unavailable';
    if (git.dirty) {
      return `uncommitted changes present (${git.changedFiles ?? 0} changed, ${git.untrackedFiles ?? 0} untracked) — DevPilot protects them`;
    }
    return undefined;
  }

  private async gitignoreCoversDevpilot(root: string): Promise<boolean> {
    for (const name of ['.gitignore']) {
      try {
        const content = await fs.readFile(path.join(root, name), 'utf8');
        if (/^\s*\/?\.devpilot\/?\s*$/m.test(content)) return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  private async readCachedScanCount(paths: WorkspacePaths): Promise<number | undefined> {
    const file = path.join(paths.cacheDir, 'project.json');
    try {
      const result = await readJson<{ stats?: { files?: number } } | undefined>(file, undefined);
      const files = result.value?.stats?.files;
      return typeof files === 'number' ? files : undefined;
    } catch {
      return undefined;
    }
  }

  private async readRegistry(): Promise<WorkspaceRegistry> {
    const result = await readJson<unknown>(registryFile(this.home), {
      version: 1,
      workspaces: [],
    });
    const value = result.value;
    if (typeof value !== 'object' || value === null) return { version: 1, workspaces: [] };
    const raw = (value as { workspaces?: unknown }).workspaces;
    if (!Array.isArray(raw)) return { version: 1, workspaces: [] };
    const workspaces = raw.filter((entry): entry is WorkspaceRegistryEntry => {
      if (typeof entry !== 'object' || entry === null) return false;
      const candidate = entry as Partial<WorkspaceRegistryEntry>;
      return (
        typeof candidate.id === 'string' &&
        typeof candidate.root === 'string' &&
        typeof candidate.name === 'string'
      );
    });
    return { version: 1, workspaces };
  }

  private async touchRegistry(entry: WorkspaceRegistryEntry): Promise<void> {
    const registry = await this.readRegistry();
    const index = registry.workspaces.findIndex((known) => known.id === entry.id);
    if (index >= 0) registry.workspaces[index] = entry;
    else registry.workspaces.push(entry);

    registry.workspaces.sort((a, b) => (a.lastOpenedAt < b.lastOpenedAt ? 1 : -1));
    registry.workspaces = registry.workspaces.slice(0, 50);
    await ensureDir(this.home);
    await writeJsonAtomic(registryFile(this.home), registry);
  }
}
