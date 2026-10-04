import { describe, expect, it } from 'vitest';

import { IgnoreMatcher, globToRegExpSource, parseGitignore } from '../../src/workspace/gitignore';

describe('globToRegExpSource', () => {
  it('keeps * inside one path segment and lets ** cross directories', () => {
    expect(globToRegExpSource('*.py')).toBe('[^/]*\\.py');
    expect(globToRegExpSource('a/*/b')).toBe('a/[^/]*/b');
    expect(globToRegExpSource('a/**/b')).toBe('a/(?:.*/)?b');
    expect(globToRegExpSource('**/*.log')).toBe('(?:.*/)?[^/]*\\.log');
    expect(globToRegExpSource('file?.txt')).toBe('file[^/]\\.txt');
  });

  it('supports character classes and escapes regex metacharacters', () => {
    expect(globToRegExpSource('[abc].txt')).toBe('[abc]\\.txt');
    expect(globToRegExpSource('[!abc].txt')).toBe('[^abc]\\.txt');
    expect(globToRegExpSource('a+b(c)')).toBe('a\\+b\\(c\\)');
  });
});

describe('parseGitignore', () => {
  it('skips comments and blank lines', () => {
    expect(parseGitignore('# comment\n\n   \nfoo')).toHaveLength(1);
    expect(parseGitignore('# comment\n\n\n')).toHaveLength(0);
  });

  it('records negation, directory-only and anchored rules', () => {
    const rules = parseGitignore('node_modules/\n!keep.log\n/build\n*.tmp');
    expect(rules[0]).toMatchObject({ source: 'node_modules', dirOnly: true, anchored: false });
    expect(rules[1]).toMatchObject({ source: 'keep.log', negated: true });
    expect(rules[2]).toMatchObject({ source: 'build', anchored: true, dirOnly: false });
    expect(rules[3]).toMatchObject({ source: '*.tmp', anchored: false });
  });
});

describe('IgnoreMatcher', () => {
  it('applies git-ish rules with last-match-wins', () => {
    const matcher = new IgnoreMatcher();
    matcher.addLayer('', ['node_modules/', '*.log', '!keep.log', '/build', 'docs/**/*.tmp'].join('\n'));

    expect(matcher.isIgnored('node_modules', true)).toBe(true);
    expect(matcher.isIgnored('deep/node_modules', true)).toBe(true);
    expect(matcher.isIgnored('a/b/debug.log', false)).toBe(true);
    expect(matcher.isIgnored('keep.log', false)).toBe(false);
    expect(matcher.isIgnored('build', true)).toBe(true);
    expect(matcher.isIgnored('src/build', true)).toBe(false);
    expect(matcher.isIgnored('docs/a/b/x.tmp', false)).toBe(true);
    expect(matcher.isIgnored('main.py', false)).toBe(false);
  });

  it('does not apply directory-only rules to files', () => {
    const matcher = new IgnoreMatcher();
    matcher.addLayer('', 'dist/');
    expect(matcher.isIgnored('dist', true)).toBe(true);
    expect(matcher.isIgnored('dist', false)).toBe(false);
  });

  it('scopes nested layers to their directory and lets them override the root', () => {
    const matcher = new IgnoreMatcher();
    matcher.addLayer('', '*.tmp');
    matcher.addLayer('vendor', '!*.tmp');
    expect(matcher.isIgnored('a.tmp', false)).toBe(true);
    expect(matcher.isIgnored('vendor/a.tmp', false)).toBe(false);
    expect(matcher.layerCount).toBe(2);
    expect(matcher.ruleCount).toBe(2);
  });
});
