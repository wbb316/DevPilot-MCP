import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { PathPolicy, isInside, isSensitiveFile, longestRootMatch, normalizeForCompare } from '../../src/security/path-policy';
import { makeTempDir, removeDir } from '../helpers/index';

describe('PathPolicy', () => {
  let root: string;
  let outside: string;

  beforeAll(async () => {
    root = await makeTempDir('devpilot-policy-root-');
    outside = await makeTempDir('devpilot-policy-outside-');
  });

  afterAll(async () => {
    await removeDir(root);
    await removeDir(outside);
  });

  it('resolves a relative path inside the workspace', () => {
    const policy = new PathPolicy(root);
    expect(policy.resolve('src/app.py')).toBe(path.join(root, 'src', 'app.py'));
  });

  it('rejects a path outside the workspace', () => {
    const policy = new PathPolicy(root);
    expect(() => policy.resolve(path.join(outside, 'file.txt'))).toThrowError(/outside the workspace/i);
    try {
      policy.resolve(path.join(outside, 'file.txt'));
    } catch (error) {
      expect((error as { code?: string }).code).toBe('PATH_OUTSIDE_WORKSPACE');
    }
  });

  it('rejects traversal that climbs out of the workspace', () => {
    const policy = new PathPolicy(root);
    expect(() => policy.resolve('../escape.txt')).toThrowError(/outside the workspace/i);
  });

  it('allows outside paths only when explicitly enabled', () => {
    const policy = new PathPolicy(root, { allowOutside: true });
    expect(policy.resolve(path.join(outside, 'file.txt'))).toBe(path.join(outside, 'file.txt'));
  });

  it('reports workspace-relative paths with forward slashes', () => {
    const policy = new PathPolicy(root);
    expect(policy.relative(path.join(root, 'src', 'app.py'))).toBe('src/app.py');
    expect(policy.relative(root)).toBe('.');
  });

  it('treats the root itself as inside', () => {
    expect(isInside(root, root)).toBe(true);
    expect(isInside(root, path.join(root, 'nested', 'deep.txt'))).toBe(true);
    expect(isInside(root, outside)).toBe(false);
  });

  it('normalises case on Windows only', () => {
    const upper = normalizeForCompare(path.join(root, 'Mixed.Case'));
    if (process.platform === 'win32') expect(upper).toBe(upper.toLowerCase());
    else expect(upper).toBe(path.resolve(path.join(root, 'Mixed.Case')));
  });

  it('picks the longest matching root', () => {
    const nested = path.join(root, 'packages', 'app');
    expect(longestRootMatch([root, nested], path.join(nested, 'src', 'index.ts'))).toBe(nested);
    expect(longestRootMatch([root], outside)).toBeUndefined();
  });
});

describe('sensitive files', () => {
  it('flags secrets and credentials', () => {
    for (const name of ['.env', '.env.local', 'id_rsa', 'server.pem', 'credentials.json', '.npmrc', 'my-password.txt']) {
      expect(isSensitiveFile(name), name).toBe(true);
    }
  });

  it('leaves ordinary sources alone', () => {
    for (const name of ['main.py', 'pom.xml', 'index.ts', 'README.md', 'environment.py']) {
      expect(isSensitiveFile(name), name).toBe(false);
    }
  });
});
