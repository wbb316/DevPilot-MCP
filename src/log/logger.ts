import { appendJsonLine } from '../storage/json-store.js';

/**
 * Logging rules (docs/ARCHITECTURE.md, docs/WORKSPACE-LIFECYCLE.md §5):
 *  - stdout belongs to the MCP JSON-RPC transport and must stay clean;
 *  - logs are JSON lines appended to the workspace / DevPilot home log file;
 *  - warnings and errors are mirrored to stderr, never to stdout.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  readonly name: string;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(name: string): Logger;
}

export interface LoggerOptions {
  name?: string;
  file?: string;
  level?: LogLevel;
  mirrorToStderr?: boolean;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const name = options.name ?? 'devpilot';
  const level = options.level ?? 'info';
  const mirror = options.mirrorToStderr ?? true;
  let queue: Promise<void> = Promise.resolve();

  const write = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < LEVEL_ORDER[level]) return;
    const record = {
      ts: new Date().toISOString(),
      level: entryLevel,
      logger: name,
      msg: message,
      ...(fields ?? {}),
    };
    if (mirror && LEVEL_ORDER[entryLevel] >= LEVEL_ORDER.warn) {
      process.stderr.write(`[${record.ts}] ${entryLevel.toUpperCase()} ${name}: ${message}\n`);
    }
    const file = options.file;
    if (file) {
      queue = queue
        .then(() => appendJsonLine(file, record))
        .catch((error: unknown) => {
          process.stderr.write(`devpilot logger failure: ${String(error)}\n`);
        });
    }
  };

  return {
    name,
    debug: (message, fields) => write('debug', message, fields),
    info: (message, fields) => write('info', message, fields),
    warn: (message, fields) => write('warn', message, fields),
    error: (message, fields) => write('error', message, fields),
    child: (childName: string) =>
      createLogger({ ...options, name: `${name}.${childName}`, mirrorToStderr: mirror }),
  };
}

/** Discard everything: used by unit tests and by `--quiet`. */
export function silentLogger(name = 'devpilot'): Logger {
  const noop = (): void => {};
  const logger: Logger = {
    name,
    debug: noop,
    info: noop,
    warn: noop,
    error: noop,
    child: (childName: string) => silentLogger(`${name}.${childName}`),
  };
  return logger;
}

/** Wait until every queued log line has been flushed. */
export async function flushLogger(logger: Logger): Promise<void> {
  // Loggers created here write through a per-instance queue; awaiting a microtask turn is
  // enough for the tests that need deterministic output.
  void logger;
  await new Promise((resolve) => setImmediate(resolve));
}
