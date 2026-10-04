import path from 'node:path';

import type { CommandPolicyDecision } from '../types/workspace.js';

/**
 * Command policy. Phase 1 ships the deny-list and the no-shell rule; Phase 9 adds the
 * per-project allow-list and per-command argument validation on top of this file.
 *
 * Design: DevPilot never passes a command through a shell by default (docs §22), so a
 * command line containing shell metacharacters is rejected outright instead of being
 * interpreted.
 */

export interface DangerousRule {
  rule: string;
  matches: (command: string, argv: readonly string[]) => boolean;
  reason: string;
}

const DANGEROUS_COMMANDS: readonly string[] = [
  'format',
  'diskpart',
  'mkfs',
  'shutdown',
  'reboot',
  'halt',
  'poweroff',
  'fdisk',
  'dd',
  'bcdedit',
  'reg',
  'takeown',
  'icacls',
  'vssadmin',
  'cipher',
  'netsh',
];

/** `rm -rf /` and friends, on both Windows and POSIX spellings. */
function isRecursiveRootDelete(command: string, argv: readonly string[]): boolean {
  const base = path.basename(command).toLowerCase().replace(/\.exe$/, '');
  const joined = argv.join(' ');
  if (base === 'rm' || base === 'rmdir') {
    const recursive = /(^|\s)-[a-z]*r/i.test(` ${joined}`) || /--recursive/.test(joined);
    const target = argv.find((arg) => !arg.startsWith('-'));
    if (recursive && (target === '/' || target === '~' || /^[a-z]:[\\/]?$/i.test(target ?? ''))) {
      return true;
    }
  }
  if (base === 'del' || base === 'erase' || base === 'rd') {
    const recursive = /(^|\s)\/s(\s|$)/i.test(` ${joined}`);
    if (recursive && argv.some((arg) => /^[a-z]:[\\/]?\*?$/i.test(arg) || arg === '\\*')) return true;
  }
  return false;
}

/** Destructive git commands DevPilot never issues (docs/WORKSPACE-LIFECYCLE.md §6). */
function isDestructiveGit(argv: readonly string[]): string | undefined {
  const [sub, second] = argv;
  if (sub === 'reset' && second === '--hard') return 'git reset --hard would discard user work';
  if (sub === 'checkout' && (second === '-f' || second === '--force')) {
    return 'git checkout -f would discard user work';
  }
  if (sub === 'clean' && argv.some((arg) => /^-.*f/.test(arg))) {
    return 'git clean -fd would delete untracked user files';
  }
  if (sub === 'push' && argv.some((arg) => arg === '-f' || arg === '--force')) {
    return 'git push --force rewrites shared history';
  }
  return undefined;
}

export const DANGEROUS_RULES: readonly DangerousRule[] = [
  {
    rule: 'deny-list',
    matches: (command) =>
      DANGEROUS_COMMANDS.includes(path.basename(command).toLowerCase().replace(/\.exe$/, '')),
    reason: 'command is on the dangerous deny-list',
  },
  {
    rule: 'recursive-delete',
    matches: isRecursiveRootDelete,
    reason: 'recursive delete of a filesystem root',
  },
  {
    rule: 'destructive-git',
    matches: (command, argv) =>
      path.basename(command).toLowerCase() === 'git' && isDestructiveGit(argv) !== undefined,
    reason: 'destructive git command',
  },
];

const SHELL_METACHARACTERS = /[;&|<>`$(){}[\]\n\r]|\|\||&&/;

export interface EvaluateCommandOptions {
  /** config: security.allow_shell — default false. */
  allowShell: boolean;
  /** The command line is run through a shell (shell: true). */
  shell?: boolean;
}

export function containsShellMetacharacters(commandLine: string): boolean {
  return SHELL_METACHARACTERS.test(commandLine);
}

/**
 * Decide whether a single command invocation may run. Phase 1 answers "is this safe at
 * all"; the project allow-list check lives in the runner adapters (Phase 4).
 */
export function evaluateCommand(
  command: string,
  argv: readonly string[] = [],
  options: EvaluateCommandOptions = { allowShell: false },
): CommandPolicyDecision {
  if (command.trim() === '') {
    return { allowed: false, reason: 'empty command', rule: 'invalid' };
  }

  for (const rule of DANGEROUS_RULES) {
    if (rule.matches(command, argv)) {
      return { allowed: false, reason: `${rule.reason} (${command})`, rule: rule.rule };
    }
  }

  const destructive = path.basename(command).toLowerCase() === 'git' ? isDestructiveGit(argv) : undefined;
  if (destructive) return { allowed: false, reason: destructive, rule: 'destructive-git' };

  if (!options.allowShell) {
    if (options.shell === true) {
      return { allowed: false, reason: 'shell execution is disabled (security.allow_shell: false)', rule: 'no-shell' };
    }
    if (containsShellMetacharacters(command) || argv.some(containsShellMetacharacters)) {
      return {
        allowed: false,
        reason: 'command line contains shell metacharacters while allow_shell is false',
        rule: 'no-shell',
      };
    }
    if (/\s/.test(command)) {
      return {
        allowed: false,
        reason: 'command must be a single executable name; pass the rest as separate arguments',
        rule: 'no-shell',
      };
    }
  }

  return { allowed: true };
}
