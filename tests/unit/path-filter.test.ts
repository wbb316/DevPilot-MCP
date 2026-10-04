import { describe, expect, it } from 'vitest';

import { normalizePathFilter, resolvePathFilter } from '../../src/tools/shared';

/**
 * The code-intelligence `path` argument is a filter, and agents routinely pass the workspace
 * root to it the way they do for every other DevPilot tool. Read as a literal prefix that
 * matched nothing, which is how the live DSH session first answered "no such symbol" for a
 * symbol that existed. These cases pin the fixed reading.
 */
const root = 'D:\\Projects\\demo';

describe('normalizePathFilter', () => {
  it('normalises separators, leading ./ and trailing slashes', () => {
    expect(normalizePathFilter('src\\catalog')).toBe('src/catalog');
    expect(normalizePathFilter('./src/')).toBe('src');
    expect(normalizePathFilter('/src')).toBe('src');
    expect(normalizePathFilter('./')).toBeUndefined();
    expect(normalizePathFilter(undefined)).toBeUndefined();
  });
});

describe('resolvePathFilter', () => {
  it('reads the workspace root, "." and an empty value as "no filter"', () => {
    expect(resolvePathFilter(undefined, root)).toEqual({});
    expect(resolvePathFilter('', root)).toEqual({});
    expect(resolvePathFilter('.', root)).toEqual({});
    expect(resolvePathFilter('.\\', root)).toEqual({});
    expect(resolvePathFilter('D:\\Projects\\demo', root)).toEqual({});
    expect(resolvePathFilter('D:/Projects/demo', root)).toEqual({});
    expect(resolvePathFilter('D:\\Projects\\demo\\', root)).toEqual({});
    // Windows paths are case-insensitive.
    expect(resolvePathFilter('d:/projects/demo', root)).toEqual({});
  });

  it('turns an absolute path inside the workspace into a relative prefix', () => {
    expect(resolvePathFilter('D:\\Projects\\demo\\src', root)).toEqual({ filter: 'src' });
    expect(resolvePathFilter('D:/Projects/demo/src/catalog', root)).toEqual({ filter: 'src/catalog' });
  });

  it('keeps relative prefixes as written', () => {
    expect(resolvePathFilter('src', root)).toEqual({ filter: 'src' });
    expect(resolvePathFilter('./src/', root)).toEqual({ filter: 'src' });
    expect(resolvePathFilter('src\\catalog', root)).toEqual({ filter: 'src/catalog' });
  });

  it('reports a path outside the workspace instead of silently matching nothing', () => {
    expect(resolvePathFilter('D:\\Projects\\other', root)).toEqual({ outside: 'D:/Projects/other' });
    expect(resolvePathFilter('C:/Users/someone', root)).toEqual({ outside: 'C:/Users/someone' });
  });
});
