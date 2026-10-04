/**
 * Stable error codes and the tool result envelope.
 *
 * Frozen contract — see docs/DATA-MODEL.md §1 and docs/TOOLS.md "Error code reference".
 * Tool names, argument names, `data` shapes and error codes are frozen once shipped in
 * V1; additions are allowed, silent renames are not.
 */

export const ERROR_CODES = [
  'INVALID_ARGUMENT',
  'PERMISSION_DENIED',
  'WORKSPACE_NOT_OPEN',
  'WORKSPACE_NOT_FOUND',
  'FILE_NOT_FOUND',
  'PATH_OUTSIDE_WORKSPACE',
  'SECRET_PROTECTED',
  'CONFIG_INVALID',
  'LIMIT_EXCEEDED',
  'NOT_IMPLEMENTED',
  'UNSUPPORTED_PROJECT',
  'INDEX_FAILED',
  'COMMAND_NOT_ALLOWED',
  'COMMAND_TIMEOUT',
  'COMMAND_FAILED',
  'BUILD_FAILED',
  'TEST_FAILED',
  'GIT_NOT_AVAILABLE',
  'GIT_DIRTY',
  'GIT_FAILED',
  'INTERNAL_ERROR',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetail {
  code: ErrorCode;
  message: string;
  /** Machine-readable context (zod issues, stderr tail, git output, ...). */
  details?: unknown;
  /** One line telling the agent what to do next. */
  hint?: string;
  /** True when retrying the same call may succeed (timeouts, transient locks). */
  retryable?: boolean;
}

export interface OkEnvelope<T> {
  success: true;
  /** One sentence an agent can print to a human. Never empty. */
  summary: string;
  data: T;
  /** Logical artifact name (`log`, `patch`, `report`) → path relative to workspace root. */
  artifacts?: Record<string, string>;
  warnings?: string[];
}

export interface ErrEnvelope {
  success: false;
  error: ErrorDetail;
}

export type ToolEnvelope<T> = OkEnvelope<T> | ErrEnvelope;

/** Codes for which retrying the identical call is meaningful. */
export const RETRYABLE_CODES: readonly ErrorCode[] = [
  'COMMAND_TIMEOUT',
  'INDEX_FAILED',
  'GIT_FAILED',
] as const;

export function isErrorCode(value: unknown): value is ErrorCode {
  return typeof value === 'string' && (ERROR_CODES as readonly string[]).includes(value);
}
