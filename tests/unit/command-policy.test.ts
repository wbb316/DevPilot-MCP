import { describe, expect, it } from 'vitest';

import { containsShellMetacharacters, evaluateCommand } from '../../src/security/command-policy';
import { capabilities, comparePermission, grants, requireExecute } from '../../src/security/permission';

describe('command policy', () => {
  it('allows ordinary project commands', () => {
    expect(evaluateCommand('mvn', ['test']).allowed).toBe(true);
    expect(evaluateCommand('python', ['train.py', '--epochs', '2']).allowed).toBe(true);
    expect(evaluateCommand('npm', ['run', 'build']).allowed).toBe(true);
  });

  it('rejects dangerous binaries', () => {
    for (const command of ['diskpart', 'format', 'shutdown', 'mkfs', 'reg']) {
      const decision = evaluateCommand(command, []);
      expect(decision.allowed, command).toBe(false);
      expect(decision.rule).toBe('deny-list');
    }
  });

  it('rejects recursive deletes of a filesystem root', () => {
    expect(evaluateCommand('rm', ['-rf', '/']).allowed).toBe(false);
    expect(evaluateCommand('del', ['/s', '/q', 'C:\\']).allowed).toBe(false);
  });

  it('rejects destructive git commands', () => {
    const hard = evaluateCommand('git', ['reset', '--hard']);
    expect(hard.allowed).toBe(false);
    expect(hard.rule).toBe('destructive-git');
    expect(evaluateCommand('git', ['clean', '-fd']).allowed).toBe(false);
    expect(evaluateCommand('git', ['push', '--force']).allowed).toBe(false);
  });

  it('keeps safe git commands allowed', () => {
    expect(evaluateCommand('git', ['status', '--porcelain']).allowed).toBe(true);
    expect(evaluateCommand('git', ['diff', 'HEAD']).allowed).toBe(true);
    expect(evaluateCommand('git', ['rev-parse', '--short', 'HEAD']).allowed).toBe(true);
  });

  it('blocks shell interpretation by default', () => {
    expect(evaluateCommand('echo hi', []).allowed).toBe(false);
    expect(evaluateCommand('cmd', ['/c', 'a && b']).allowed).toBe(false);
    expect(evaluateCommand('node', ['-e', '1+1'], { allowShell: true }).allowed).toBe(true);
    expect(evaluateCommand('echo hi', [], { allowShell: true }).allowed).toBe(true);
  });

  it('detects metacharacters', () => {
    expect(containsShellMetacharacters('a && b')).toBe(true);
    expect(containsShellMetacharacters('plain-argument')).toBe(false);
  });

  it('rejects empty commands', () => {
    expect(evaluateCommand('   ', []).allowed).toBe(false);
  });
});

describe('permission model', () => {
  it('orders levels', () => {
    expect(grants('FULL', 'EXECUTE')).toBe(true);
    expect(grants('EXECUTE', 'SAFE_WRITE')).toBe(true);
    expect(grants('READ_ONLY', 'SAFE_WRITE')).toBe(false);
    expect(comparePermission('EXECUTE', 'SAFE_WRITE')).toBeGreaterThan(0);
  });

  it('models SAFE_WRITE + limited execute as the default', () => {
    expect(capabilities('SAFE_WRITE').execute).toBe(true);
    expect(capabilities('SAFE_WRITE', { execute: false }).execute).toBe(false);
    expect(capabilities('READ_ONLY').execute).toBe(false);
    expect(capabilities('SAFE_WRITE').shell).toBe(false);
    expect(capabilities('EXECUTE', { allowShell: true }).shell).toBe(true);
  });

  it('throws PERMISSION_DENIED when execute is unavailable', () => {
    try {
      requireExecute(capabilities('READ_ONLY'), 'run_tests');
      throw new Error('expected requireExecute to throw');
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PERMISSION_DENIED');
    }
  });
});
