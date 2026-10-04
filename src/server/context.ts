import type { LogLevel, Logger } from '../log/logger.js';
import { createLogger } from '../log/logger.js';
import { closeAllSymbolIndexes } from '../code/index-registry.js';
import { devpilotHome, ensureHomeLayout, globalLogFile } from '../storage/paths.js';
import { VERSION } from '../version.js';
import { WorkspaceManager } from '../workspace/workspace-manager.js';

/**
 * Dependency-injection root for one MCP session (docs/ARCHITECTURE.md §3).
 * One server process = one session; workspace state lives here, the registry on disk.
 */
export interface ServerContextOptions {
  home?: string;
  logger?: Logger;
  env?: NodeJS.ProcessEnv;
  logLevel?: LogLevel;
}

export class ServerContext {
  readonly home: string;
  readonly logger: Logger;
  readonly workspaces: WorkspaceManager;
  readonly startedAt: string;
  readonly version = VERSION;

  private constructor(home: string, logger: Logger) {
    this.home = home;
    this.logger = logger;
    this.workspaces = new WorkspaceManager({ home, logger: logger.child('workspace') });
    this.startedAt = new Date().toISOString();
  }

  static async create(options: ServerContextOptions = {}): Promise<ServerContext> {
    const env = options.env ?? process.env;
    const home = options.home ?? devpilotHome(env);
    await ensureHomeLayout(home);
    const logger =
      options.logger ??
      createLogger({
        name: 'devpilot',
        file: globalLogFile(home),
        level: options.logLevel ?? 'info',
      });
    return new ServerContext(home, logger);
  }

  async dispose(): Promise<void> {
    // Flush and release every open symbol index: a live SQLite handle would otherwise
    // outlive the session and block the workspace directory (docs/DATA-MODEL.md §9).
    try {
      await closeAllSymbolIndexes();
    } catch (error) {
      this.logger.warn('failed to close symbol indexes during dispose', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
    this.logger.info('server context disposed', { openWorkspaces: this.workspaces.listOpen().length });
  }
}
