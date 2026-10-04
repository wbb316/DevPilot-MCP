import { promises as fs } from 'node:fs';
import path from 'node:path';

import { errors } from '../errors/devpilot-error.js';

/**
 * Workspace confinement. Every path an agent can reach is validated here
 * (docs/ARCHITECTURE.md §6, docs/WORKSPACE-LIFECYCLE.md).
 */

/** Files whose contents are withheld unless the human explicitly asks (docs §22). */
export const SENSITIVE_PATTERNS: readonly RegExp[] = [
  /^\.env(\..+)?$/i,
  /^\.envrc$/i,
  /^.*\.(pem|key|p12|pfx|jks|keystore)$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.netrc$/i,
  /^credentials(\.json|\.yml|\.yaml|\.xml)?$/i,
  /^secrets?(\.json|\.yml|\.yaml|\.toml|\.ini|\.txt)?$/i,
  /^\.git-credentials$/i,
  /^.*password.*$/i,
  /^.*\.pfx$/i,
];

export function isSensitiveFile(filePath: string): boolean {
  const base = path.basename(filePath);
  return SENSITIVE_PATTERNS.some((pattern) => pattern.test(base));
}

/** Normalise for comparison: absolute, resolved, case-folded on Windows. */
export function normalizeForCompare(target: string): string {
  const absolute = path.resolve(target);
  return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
}

/** True when `child` is `parent` itself or lives underneath it. */
export function isInside(parent: string, child: string): boolean {
  const from = normalizeForCompare(parent);
  const to = normalizeForCompare(child);
  if (from === to) return true;
  const rel = path.relative(from, to);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

export function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

export interface PathPolicyOptions {
  /** When true, paths outside the root are permitted (config: allow_outside_workspace). */
  allowOutside?: boolean;
}

export class PathPolicy {
  readonly root: string;
  private readonly allowOutside: boolean;

  constructor(root: string, options: PathPolicyOptions = {}) {
    this.root = path.resolve(root);
    this.allowOutside = options.allowOutside ?? false;
  }

  /** Resolve `input` (absolute or root-relative) and assert containment. */
  resolve(input: string): string {
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.root, input);
    this.assertInside(candidate);
    return candidate;
  }

  /** Assert an already-resolved absolute path stays inside the root. */
  assertInside(candidate: string): void {
    if (this.allowOutside) return;
    if (!isInside(this.root, candidate)) {
      throw errors.pathOutsideWorkspace(candidate, this.root);
    }
  }

  /** Workspace-relative path with forward slashes; '.' for the root itself. */
  relative(candidate: string | undefined): string | undefined {
    if (candidate === undefined) return undefined;
    const rel = path.relative(this.root, path.resolve(candidate));
    if (rel === '') return '.';
    return toPosix(rel);
  }

  /**
   * `fs.realpath` with typed errors. Symlinks are resolved so a link inside the
   * workspace cannot be used to escape it (docs/ARCHITECTURE.md §6).
   */
  async realpath(input: string): Promise<string> {
    const candidate = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.root, input);
    try {
      return await fs.realpath(candidate);
    } catch (error) {
      throw nodeErrorToDevPilot(candidate, error);
    }
  }

  /** Realpath + containment check, for paths that must exist. */
  async realpathInside(input: string): Promise<string> {
    const resolved = await this.realpath(input);
    this.assertInside(resolved);
    return resolved;
  }

  async assertDirectory(input: string): Promise<string> {
    const resolved = await this.realpath(input);
    const stat = await statOrThrow(resolved);
    if (!stat.isDirectory()) {
      throw errors.workspaceNotFound(resolved, 'not a directory');
    }
    return resolved;
  }
}

export async function statOrThrow(target: string): Promise<Awaited<ReturnType<typeof fs.stat>>> {
  try {
    return await fs.stat(target);
  } catch (error) {
    throw nodeErrorToDevPilot(target, error);
  }
}

export function nodeErrorToDevPilot(target: string, error: unknown): Error {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  const message = error instanceof Error ? error.message : String(error);
  switch (code) {
    case 'ENOENT':
      return errors.fileNotFound(target, 'no such file or directory');
    case 'ENOTDIR':
      return errors.workspaceNotFound(target, 'a path component is not a directory');
    case 'EACCES':
    case 'EPERM':
      return errors.permissionDenied(`Access denied: ${target}`, message);
    default:
      return errors.internal(`Filesystem error for ${target}: ${message}`, { code });
  }
}

/** Resolve the workspace root that owns `target`, choosing the longest match. */
export function longestRootMatch(roots: readonly string[], target: string): string | undefined {
  const matches = roots.filter((root) => isInside(root, target));
  if (matches.length === 0) return undefined;
  return matches.sort((a, b) => normalizeForCompare(b).length - normalizeForCompare(a).length)[0];
}
