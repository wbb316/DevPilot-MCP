import type { ErrorCode, ErrEnvelope } from '../types/errors.js';
import { RETRYABLE_CODES } from '../types/errors.js';

export interface DevPilotErrorOptions {
  details?: unknown;
  hint?: string;
  retryable?: boolean;
  cause?: unknown;
}

/**
 * Every failure surfaced to an agent is a DevPilotError with a stable code.
 * Unexpected throws are normalised through `DevPilotError.from()` so that a bug can never
 * leak a raw stack trace into an MCP reply (docs/ARCHITECTURE.md §5).
 */
export class DevPilotError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly hint?: string;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, options: DevPilotErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'DevPilotError';
    this.code = code;
    this.details = options.details;
    this.hint = options.hint;
    this.retryable = options.retryable ?? RETRYABLE_CODES.includes(code);
  }

  toEnvelope(): ErrEnvelope {
    const error: ErrEnvelope['error'] = { code: this.code, message: this.message };
    if (this.details !== undefined) error.details = this.details;
    if (this.hint !== undefined) error.hint = this.hint;
    if (this.retryable) error.retryable = true;
    return { success: false, error };
  }

  static from(error: unknown): DevPilotError {
    if (error instanceof DevPilotError) return error;
    if (error instanceof Error) {
      return new DevPilotError('INTERNAL_ERROR', error.message, {
        details: { name: error.name },
        hint: 'This is a DevPilot bug; the full stack is in the DevPilot log file.',
        retryable: false,
        cause: error,
      });
    }
    return new DevPilotError('INTERNAL_ERROR', String(error), { retryable: false });
  }
}

export const errors = {
  invalidArgument(message: string, details?: unknown): DevPilotError {
    return new DevPilotError('INVALID_ARGUMENT', message, {
      details,
      hint: 'Fix the call arguments and retry.',
    });
  },
  permissionDenied(message: string, hint?: string): DevPilotError {
    return new DevPilotError('PERMISSION_DENIED', message, { hint });
  },
  workspaceNotOpen(detail?: string): DevPilotError {
    return new DevPilotError(
      'WORKSPACE_NOT_OPEN',
      detail ? `No workspace is open: ${detail}` : 'No workspace is open.',
      { hint: 'Call open_workspace first.' },
    );
  },
  workspaceNotFound(target: string, detail?: string): DevPilotError {
    return new DevPilotError(
      'WORKSPACE_NOT_FOUND',
      detail ? `${target}: ${detail}` : `${target} is not a directory.`,
      { hint: 'Pass the absolute path of an existing project directory.' },
    );
  },
  fileNotFound(target: string, detail?: string): DevPilotError {
    return new DevPilotError('FILE_NOT_FOUND', detail ? `${target}: ${detail}` : `Not found: ${target}`);
  },
  pathOutsideWorkspace(target: string, root: string): DevPilotError {
    return new DevPilotError(
      'PATH_OUTSIDE_WORKSPACE',
      `Path resolves outside the workspace root: ${target} (root: ${root})`,
      { hint: 'Use a path inside the workspace, or ask the human to widen the scope.' },
    );
  },
  configInvalid(message: string, details?: unknown): DevPilotError {
    return new DevPilotError('CONFIG_INVALID', message, {
      details,
      hint: 'Fix .devpilot/config.yml (the zod path in details names the field).',
    });
  },
  limitExceeded(message: string, details?: unknown): DevPilotError {
    return new DevPilotError('LIMIT_EXCEEDED', message, {
      details,
      hint: 'Split the work into smaller stages.',
    });
  },
  notImplemented(feature: string, phase: number): DevPilotError {
    return new DevPilotError('NOT_IMPLEMENTED', `${feature} arrives in Phase ${phase}.`, {
      details: { feature, phase },
      hint: 'This tool exists in the roadmap but is not part of the current phase.',
    });
  },
  indexFailed(message: string, details?: unknown): DevPilotError {
    return new DevPilotError('INDEX_FAILED', message, {
      details,
      retryable: true,
      hint: 'Re-run scan_project { force: true }; if it persists, the details name the failing file.',
    });
  },
  gitNotAvailable(detail?: string): DevPilotError {
    return new DevPilotError(
      'GIT_NOT_AVAILABLE',
      detail ? `git is not usable: ${detail}` : 'git is not available.',
      { hint: 'Install git, or work without git-backed features.' },
    );
  },
  gitFailed(args: readonly string[], detail: string): DevPilotError {
    return new DevPilotError('GIT_FAILED', `git ${args.join(' ')} failed: ${detail}`, {
      details: { args: [...args], stderr: detail },
      retryable: true,
    });
  },
  commandNotAllowed(message: string, details?: unknown): DevPilotError {
    return new DevPilotError('COMMAND_NOT_ALLOWED', message, {
      details,
      hint: 'Use a supported build/test entrypoint or declare the command in .devpilot/config.yml.',
    });
  },
  commandTimeout(command: string, seconds: number, details?: unknown): DevPilotError {
    return new DevPilotError(
      'COMMAND_TIMEOUT',
      `Command exceeded ${seconds}s and was terminated: ${command}`,
      {
        details: { command, timeoutSeconds: seconds, ...(details === undefined ? {} : { result: details }) },
        retryable: true,
        hint: 'Raise timeoutSeconds, or run a shorter command; a long-running service is expected to time out.',
      },
    );
  },
  commandFailed(command: string, exitCode: number | null, details?: unknown): DevPilotError {
    return new DevPilotError(
      'COMMAND_FAILED',
      `${command} exited with code ${exitCode ?? 'null'}`,
      {
        details,
        hint: 'details.stdoutTail/stderrTail hold the last lines; details.job.logFile has the full output.',
      },
    );
  },
  buildFailed(command: string, exitCode: number | null, details?: unknown): DevPilotError {
    return new DevPilotError(
      'BUILD_FAILED',
      `${command} failed (exit code ${exitCode ?? 'null'})`,
      {
        details,
        hint: 'details.errors lists the first failures with file:line; details.job.logFile has the full log.',
      },
    );
  },
  unsupportedProject(message: string): DevPilotError {
    return new DevPilotError('UNSUPPORTED_PROJECT', message, {
      hint: 'Declare build/test/run commands in .devpilot/config.yml.',
    });
  },
  internal(message: string, details?: unknown, cause?: unknown): DevPilotError {
    return new DevPilotError('INTERNAL_ERROR', message, { details, cause, retryable: false });
  },
};
