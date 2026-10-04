import type { PermissionLevel } from '../types/workspace.js';
import { errors } from '../errors/devpilot-error.js';

/**
 * Permission model (docs/DATA-MODEL.md §2, docs/WORKSPACE-LIFECYCLE.md §4).
 *
 * `level` is the session maximum. "SAFE_WRITE + limited EXECUTE" — the default — is
 * expressed as `level: SAFE_WRITE` plus `execute: true`: EXECUTE-gated tools are then
 * reachable, but only through the command policy (allow-listed project commands, never a
 * shell). `execute: false` locks the session down to analysis only.
 */
export const PERMISSION_ORDER: Record<PermissionLevel, number> = {
  READ_ONLY: 0,
  SAFE_WRITE: 1,
  EXECUTE: 2,
  FULL: 3,
};

export interface SessionCapabilities {
  level: PermissionLevel;
  /** May run project commands through the command policy. */
  execute: boolean;
  /** May pass `shell: true`; always false unless explicitly enabled in config. */
  shell: boolean;
}

export function comparePermission(a: PermissionLevel, b: PermissionLevel): number {
  return PERMISSION_ORDER[a] - PERMISSION_ORDER[b];
}

/** Does `level` alone satisfy `required`? */
export function grants(level: PermissionLevel, required: PermissionLevel): boolean {
  return PERMISSION_ORDER[level] >= PERMISSION_ORDER[required];
}

export function capabilities(
  level: PermissionLevel,
  options: { execute?: boolean; allowShell?: boolean } = {},
): SessionCapabilities {
  // Limited execute: a capability flag can lift SAFE_WRITE to "may execute under policy",
  // but can never lift READ_ONLY.
  const execute = grants(level, 'EXECUTE') || (level === 'SAFE_WRITE' && options.execute !== false);
  return { level, execute, shell: options.allowShell === true && grants(level, 'EXECUTE') };
}

/** Throws PERMISSION_DENIED when the session cannot satisfy an EXECUTE-gated tool. */
export function requireExecute(caps: SessionCapabilities, toolName: string): void {
  if (caps.execute) return;
  throw errors.permissionDenied(
    `${toolName} requires EXECUTE, but this workspace session is ${caps.level} with execute disabled.`,
    'Reopen the workspace with permission EXECUTE (or set security.permission in .devpilot/config.yml).',
  );
}

/** Throws PERMISSION_DENIED when the session cannot satisfy a plain level requirement. */
export function requireLevel(
  caps: SessionCapabilities,
  required: PermissionLevel,
  toolName: string,
): void {
  if (required === 'EXECUTE') {
    requireExecute(caps, toolName);
    return;
  }
  if (grants(caps.level, required)) return;
  throw errors.permissionDenied(
    `${toolName} requires ${required}, but this workspace session is ${caps.level}.`,
    'Reopen the workspace with a higher permission level.',
  );
}
