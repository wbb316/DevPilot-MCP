import { afterEach, describe, expect, it } from 'vitest';

import { auditDependencies } from '../../src/environment/dependency-audit';
import type { LockIssue, LockIssueKind } from '../../src/types/dependency';
import { makeTempDir, removeDir, writeFiles } from '../helpers/index';

/**
 * Unit tests for the pure analyzer. Every workspace is synthesised in a temp directory:
 * nothing is read from, written to, or executed inside `fixtures/`.
 */

const EXCLUDES = ['node_modules', '.git', 'dist', 'build', 'target', 'out', '.venv', 'venv'];

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) await removeDir(dir);
  }
});

/** Create a throwaway workspace with exactly these files. */
async function workspace(files: Record<string, string>): Promise<string> {
  const root = await makeTempDir('devpilot-dep-audit-');
  tempDirs.push(root);
  await writeFiles(root, files);
  return root;
}

async function audit(root: string, network?: boolean) {
  return await auditDependencies({
    root,
    exclude: EXCLUDES,
    ...(network === undefined ? {} : { network }),
  });
}

function kinds(issues: LockIssue[]): LockIssueKind[] {
  return issues.map((issue) => issue.kind).sort();
}

function issueFor(issues: LockIssue[], kind: LockIssueKind): LockIssue | undefined {
  return issues.find((issue) => issue.kind === kind);
}

/* ------------------------------------------------------------------ npm */

describe('npm', () => {
  it('counts direct declarations and lock-only packages, with no issues for a synced lock', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({
        name: 'demo',
        dependencies: { express: '^4.18.2', lodash: '4.17.21' },
        devDependencies: { vitest: '^1.0.0' },
      }),
      'package-lock.json': JSON.stringify({
        name: 'demo',
        lockfileVersion: 3,
        packages: {
          '': {
            name: 'demo',
            dependencies: { express: '^4.18.2', lodash: '4.17.21' },
            devDependencies: { vitest: '^1.0.0' },
          },
          'node_modules/express': { version: '4.18.2' },
          'node_modules/lodash': { version: '4.17.21' },
          'node_modules/vitest': { version: '1.6.0' },
          'node_modules/accepts': { version: '1.3.8' },
          'node_modules/express/node_modules/cookie': { version: '0.5.0' },
        },
      }),
    });

    const result = await audit(root);
    const npm = result.ecosystems.find((profile) => profile.name === 'npm');

    expect(result.direct).toBe(3);
    expect(result.transitive).toBe(2);
    expect(npm?.manifestFiles).toEqual(['package.json']);
    expect(npm?.lockFile).toBe('package-lock.json');
    expect(result.lockIssues).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.scannedFiles).toBe(2);
  });

  it('reports a missing lockfile when dependencies are declared without one', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { express: '^4.18.2' } }),
    });

    const result = await audit(root);
    const issue = issueFor(result.lockIssues, 'missing_lock');

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('ERROR');
    expect(issue?.path).toBe('package.json');
  });

  it('reports a direct declaration the lockfile never resolved', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({
        name: 'demo',
        dependencies: { express: '^4.18.2', leftpad: '1.0.0' },
      }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { express: '^4.18.2' } },
          'node_modules/express': { version: '4.18.2' },
        },
      }),
    });

    const result = await audit(root);
    const issue = issueFor(result.lockIssues, 'lock_out_of_sync');

    expect(issue).toBeDefined();
    expect(issue?.severity).toBe('WARNING');
    expect(issue?.message).toContain('leftpad');
    expect(issue?.message).toContain('package-lock.json');
    // The undeclared package is not in the lock either, so nothing is transitive.
    expect(result.transitive).toBe(0);
  });

  it('flags * and latest as unpinned but leaves caret ranges alone', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({
        name: 'demo',
        dependencies: { free: '*', mover: 'latest', fine: '^2.1.0' },
      }),
    });

    const result = await audit(root);
    const unpinned = result.lockIssues.filter((issue) => issue.kind === 'unpinned');
    const named = unpinned.map((issue) => issue.message.split(' ')[0]).sort();

    expect(named).toEqual(['free', 'mover']);
    expect(unpinned.every((issue) => issue.path === 'package.json')).toBe(true);
  });

  it('reports a package resolved to two different versions in the lockfile', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { express: '^4.18.2' } }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { express: '^4.18.2' } },
          'node_modules/express': { version: '4.18.2' },
          'node_modules/debug': { version: '2.6.9' },
          'node_modules/express/node_modules/debug': { version: '4.3.4' },
        },
      }),
    });

    const result = await audit(root);
    const issue = issueFor(result.lockIssues, 'duplicate_version');

    expect(issue).toBeDefined();
    // npm legitimately nests duplicates.
    expect(issue?.severity).toBe('WARNING');
    expect(issue?.message).toContain('debug');
    expect(issue?.message).toContain('2.6.9');
    expect(issue?.message).toContain('4.3.4');
  });

  it('reads pnpm-lock.yaml importers and package keys', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { react: '^18.2.0' } }),
      'pnpm-lock.yaml': [
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '  .:',
        '    dependencies:',
        '      react:',
        '        specifier: ^18.2.0',
        '        version: 18.2.0',
        '',
        'packages:',
        '',
        '  react@18.2.0:',
        '    resolution: {integrity: sha512-aaa}',
        '',
        '  loose-envify@1.4.0:',
        '    resolution: {integrity: sha512-bbb}',
        '',
      ].join('\n'),
    });

    const result = await audit(root);
    const npm = result.ecosystems.find((profile) => profile.name === 'npm');

    expect(npm?.lockFile).toBe('pnpm-lock.yaml');
    expect(result.direct).toBe(1);
    expect(result.transitive).toBe(1);
    expect(kinds(result.lockIssues)).not.toContain('lock_out_of_sync');
  });

  it('reads yarn.lock for name presence and says the resolved versions were not parsed', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { lodash: '^4.17.21' } }),
      'yarn.lock': [
        '# THIS IS AN AUTOGENERATED FILE. DO NOT EDIT THIS FILE DIRECTLY.',
        '# yarn lockfile v1',
        '',
        'lodash@^4.17.21:',
        '  version "4.17.21"',
        '  resolved "https://registry.yarnpkg.com/lodash/-/lodash-4.17.21.tgz#abc"',
        '',
      ].join('\n'),
    });

    const result = await audit(root);
    const npm = result.ecosystems.find((profile) => profile.name === 'npm');

    expect(npm?.lockFile).toBe('yarn.lock');
    expect(result.direct).toBe(1);
    expect(result.transitive).toBe(0);
    expect(result.lockIssues).toEqual([]);
    expect(npm?.notes?.join(' ')).toContain('yarn.lock');
  });
});

/* ------------------------------------------------------------------ python */

describe('python', () => {
  it('parses requirements.txt, follows -r one level, and reads poetry.lock transitives', async () => {
    const root = await workspace({
      'requirements.txt': ['-r requirements-dev.txt', 'torch>=2.1', 'requests==2.31.0'].join('\n'),
      'requirements-dev.txt': 'pytest~=7.4\n',
      'poetry.lock': [
        '[[package]]',
        'name = "torch"',
        'version = "2.1.0"',
        '',
        '[[package]]',
        'name = "requests"',
        'version = "2.31.0"',
        '',
        '[[package]]',
        'name = "pytest"',
        'version = "7.4.4"',
        '',
        '[[package]]',
        'name = "urllib3"',
        'version = "2.1.0"',
        '',
      ].join('\n'),
    });

    const result = await audit(root);
    const python = result.ecosystems.find((profile) => profile.name === 'python');

    // requirements-dev.txt is itself a root-level manifest, so it is read in its own right
    // as well as being pulled in by the `-r` include.
    expect(python?.manifestFiles).toEqual(['requirements-dev.txt', 'requirements.txt']);
    expect(result.direct).toBe(3);
    expect(python?.lockFile).toBe('poetry.lock');
    expect(result.transitive).toBe(1);
    // `torch>=2.1` and the included `pytest~=` line: `>=` has no upper bound, so torch is
    // unpinned (the same rule npm applies to a bare `>`); `~=` is a bounded range.
    const unpinned = result.lockIssues.filter((issue) => issue.kind === 'unpinned');
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]?.message).toContain('torch');
    // The included requirements-dev.txt contributes dependencies but is not a manifest.
    expect(result.lockIssues.some((issue) => issue.path === 'requirements-dev.txt')).toBe(false);
  });

  it('parses pyproject.toml [project] and [tool.poetry] dependencies', async () => {
    const root = await workspace({
      'pyproject.toml': [
        '[project]',
        'name = "demo"',
        'dependencies = [',
        '  "httpx>=0.27",',
        '  "pydantic==2.5.3",',
        ']',
        '',
        '[project.optional-dependencies]',
        'test = ["pytest>=7.4"]',
        '',
        '[tool.poetry.dependencies]',
        'python = "^3.11"',
        'rich = { version = "^13.7.0", optional = true }',
        '',
      ].join('\n'),
    });

    const result = await audit(root);
    const python = result.ecosystems.find((profile) => profile.name === 'python');

    expect(python?.manifestFiles).toEqual(['pyproject.toml']);
    // httpx, pydantic, pytest, rich — but never `python` (the interpreter, not a package).
    expect(result.direct).toBe(4);
    // `httpx>=0.27` and `pytest>=7.4` have no upper bound; pydantic is exact and rich a caret range.
    const unpinned = result.lockIssues.filter((issue) => issue.kind === 'unpinned');
    expect(unpinned.map((issue) => issue.message.split(' ')[0]).sort()).toEqual(['httpx', 'pytest']);
  });

  it('parses Pipfile and Pipfile.lock', async () => {
    const root = await workspace({
      Pipfile: ['[packages]', 'flask = "==3.0.0"', '', '[dev-packages]', 'pytest = "*"'].join('\n'),
      'Pipfile.lock': JSON.stringify({
        _meta: { hash: { sha256: 'x' } },
        default: { flask: { version: '==3.0.0' }, werkzeug: { version: '==3.0.1' } },
        develop: { pytest: { version: '==7.4.4' } },
      }),
    });

    const result = await audit(root);
    const python = result.ecosystems.find((profile) => profile.name === 'python');

    // `==3.0.0` is not valid YAML, which is exactly why the Pipfile reader does not use one.
    expect(result.direct).toBe(2);
    expect(python?.lockFile).toBe('Pipfile.lock');
    expect(result.transitive).toBe(1);
    const unpinned = result.lockIssues.filter((issue) => issue.kind === 'unpinned');
    expect(unpinned).toHaveLength(1);
    expect(unpinned[0]?.message).toContain('pytest');
  });
});

/* ------------------------------------------------------------------ maven */

describe('maven', () => {
  it('resolves ${property} versions and flags the ones nothing defines', async () => {
    const root = await workspace({
      'pom.xml': [
        '<?xml version="1.0" encoding="UTF-8"?>',
        '<project xmlns="http://maven.apache.org/POM/4.0.0">',
        '  <modelVersion>4.0.0</modelVersion>',
        '  <groupId>com.example</groupId>',
        '  <artifactId>demo</artifactId>',
        '  <version>1.0.0</version>',
        '  <properties>',
        '    <junit.version>5.10.0</junit.version>',
        '    <jackson.version>${jackson.base}</jackson.version>',
        '    <jackson.base>2.16.1</jackson.base>',
        '  </properties>',
        '  <dependencies>',
        '    <dependency>',
        '      <groupId>org.junit.jupiter</groupId>',
        '      <artifactId>junit-jupiter</artifactId>',
        '      <version>${junit.version}</version>',
        '      <scope>test</scope>',
        '    </dependency>',
        '    <dependency>',
        '      <groupId>com.fasterxml.jackson.core</groupId>',
        '      <artifactId>jackson-databind</artifactId>',
        '      <version>${jackson.version}</version>',
        '    </dependency>',
        '    <dependency>',
        '      <groupId>com.example</groupId>',
        '      <artifactId>ghost</artifactId>',
        '      <version>${undefined.property}</version>',
        '    </dependency>',
        '    <!-- <dependency><groupId>x</groupId><artifactId>commented</artifactId></dependency> -->',
        '  </dependencies>',
        '</project>',
      ].join('\n'),
    });

    const result = await audit(root);
    const maven = result.ecosystems.find((profile) => profile.name === 'maven');

    expect(maven?.manifestFiles).toEqual(['pom.xml']);
    expect(result.direct).toBe(3);
    // A commented-out dependency must not be counted as a fourth.
    expect(result.direct).not.toBe(4);
    const unresolved = result.lockIssues.filter((issue) => issue.kind === 'unresolved_version');
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]?.message).toContain('ghost');
    expect(unresolved[0]?.severity).toBe('ERROR');
    // Maven has no lockfile, so it must never claim one is missing.
    expect(result.lockIssues.filter((issue) => issue.kind === 'missing_lock')).toEqual([]);
  });

  it('reads submodule poms one level down and reports a duplicate across them', async () => {
    const root = await workspace({
      'pom.xml': [
        '<project>',
        '  <groupId>com.example</groupId>',
        '  <artifactId>aggregator</artifactId>',
        '  <version>1.0.0</version>',
        '  <modules><module>service</module></modules>',
        '</project>',
      ].join('\n'),
      'service/pom.xml': [
        '<project>',
        '  <parent><groupId>com.example</groupId><artifactId>aggregator</artifactId><version>1.0.0</version></parent>',
        '  <artifactId>service</artifactId>',
        '  <dependencies>',
        '    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>32.1.0-jre</version></dependency>',
        '  </dependencies>',
        '</project>',
      ].join('\n'),
      'other/pom.xml': [
        '<project>',
        '  <artifactId>other</artifactId>',
        '  <dependencies>',
        '    <dependency><groupId>com.google.guava</groupId><artifactId>guava</artifactId><version>31.0-jre</version></dependency>',
        '  </dependencies>',
        '</project>',
      ].join('\n'),
    });

    const result = await audit(root);
    const maven = result.ecosystems.find((profile) => profile.name === 'maven');

    expect(maven?.manifestFiles).toEqual(['other/pom.xml', 'pom.xml', 'service/pom.xml']);
    const duplicate = result.lockIssues.find(
      (issue) => issue.kind === 'duplicate_version' && issue.message.includes('com.google.guava:guava'),
    );
    expect(duplicate).toBeDefined();
    // One JVM classpath cannot hold two versions of the same artifact.
    expect(duplicate?.severity).toBe('ERROR');
  });
});

/* ------------------------------------------------------------------ gradle */

describe('gradle', () => {
  it('parses dependency lines, resolves ext variables, and flags an unresolvable version', async () => {
    const root = await workspace({
      'build.gradle': [
        'ext {',
        "  springVersion = '3.2.1'",
        "  guavaVersion = '32.1.0-jre'",
        '}',
        '',
        'dependencies {',
        '  implementation "org.springframework:spring-core:${springVersion}"',
        "  implementation 'com.google.guava:guava:${guavaVersion}'",
        "  testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'",
        "  compileOnly 'org.projectlombok:lombok:${lombokVersion}'",
        "  runtimeOnly 'org.postgresql:postgresql'",
        '  // implementation "com.example:commented:1.0.0"',
        '}',
        '',
      ].join('\n'),
    });

    const result = await audit(root);
    const gradle = result.ecosystems.find((profile) => profile.name === 'gradle');
    const unresolved = result.lockIssues.filter((issue) => issue.kind === 'unresolved_version');
    const messages = unresolved.map((issue) => issue.message).join(' ');

    expect(gradle?.manifestFiles).toEqual(['build.gradle']);
    expect(result.direct).toBe(5);
    // The two resolved `${...}` lines are not issues.
    expect(messages).toContain('lombok');
    // A versionless coordinate is unmanaged rather than an error.
    expect(messages).toContain('postgresql');
    expect(unresolved.map((issue) => issue.severity).sort()).toEqual(['ERROR', 'WARNING']);
  });

  it('resolves a libs.versions.toml alias referenced as libs.*', async () => {
    const root = await workspace({
      'build.gradle.kts': ['dependencies {', '  implementation(libs.guava)', '}', ''].join('\n'),
      'gradle/libs.versions.toml': [
        '[versions]',
        'guava = "32.1.0-jre"',
        '',
        '[libraries]',
        'guava = { module = "com.google.guava:guava", version.ref = "guava" }',
        '',
      ].join('\n'),
    });

    const result = await audit(root);
    const gradle = result.ecosystems.find((profile) => profile.name === 'gradle');

    expect(gradle?.manifestFiles).toEqual(['build.gradle.kts', 'gradle/libs.versions.toml']);
    expect(result.direct).toBe(1);
    expect(result.lockIssues).toEqual([]);
  });
});

/* ------------------------------------------------------------------ scope, caps, determinism */

describe('workspace scope and output contract', () => {
  it('never reads manifests the walker excludes', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { a: '1.0.0' } }),
      'node_modules/inner/package.json': JSON.stringify({ name: 'inner', dependencies: { b: '1.0.0' } }),
      'dist/package.json': JSON.stringify({ name: 'dist', dependencies: { c: '1.0.0' } }),
    });

    const result = await audit(root);

    expect(result.direct).toBe(1);
    expect(result.ecosystems[0]?.manifestFiles).toEqual(['package.json']);
  });

  it('reads monorepo packages / apps one level down and ignores deeper duplicates', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'root', dependencies: { a: '1.0.0' } }),
      'packages/web/package.json': JSON.stringify({ name: 'web', dependencies: { b: '1.0.0' } }),
      'apps/api/package.json': JSON.stringify({ name: 'api', dependencies: { c: '1.0.0' } }),
      'tools/deep/nested/package.json': JSON.stringify({ name: 'deep', dependencies: { d: '1.0.0' } }),
    });

    const result = await audit(root);
    const npm = result.ecosystems.find((profile) => profile.name === 'npm');

    expect(npm?.manifestFiles).toEqual([
      'apps/api/package.json',
      'package.json',
      'packages/web/package.json',
    ]);
    expect(result.direct).toBe(3);
  });

  it('returns a deterministic, path-sorted issue list and a stable ecosystem order', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { z: '*', a: 'latest' } }),
      'pom.xml': [
        '<project>',
        '  <dependencies>',
        '    <dependency><groupId>g</groupId><artifactId>m</artifactId><version>${nope}</version></dependency>',
        '  </dependencies>',
        '</project>',
      ].join('\n'),
      'requirements.txt': 'unpinned\n',
    });

    const first = await audit(root);
    const second = await audit(root);

    expect(first.ecosystems.map((profile) => profile.name)).toEqual(['npm', 'python', 'maven']);
    expect(JSON.stringify(first.lockIssues)).toBe(JSON.stringify(second.lockIssues));
    const paths = first.lockIssues.map((issue) => issue.path);
    expect([...paths].sort()).toEqual(paths);
  });

  it('is offline by default and keeps the frozen data keys', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { a: '1.0.0' } }),
    });

    const result = await audit(root);

    expect(result.outdated).toEqual([]);
    expect(result.vulnerable).toBeUndefined();
    expect(result.network).toBe(false);
    expect(Object.keys(result).sort()).toEqual(
      [
        'direct',
        'ecosystems',
        'lockIssues',
        'network',
        'notes',
        'outdated',
        'scannedFiles',
        'transitive',
        'truncated',
      ].sort(),
    );
    expect(result.notes.join(' ')).toContain('offline');
  });

  it('explains an empty workspace instead of returning a silent zero', async () => {
    const root = await workspace({ 'README.md': '# nothing to audit\n' });

    const result = await audit(root);

    expect(result.ecosystems).toEqual([]);
    expect(result.direct).toBe(0);
    expect(result.transitive).toBe(0);
    expect(result.lockIssues).toEqual([]);
    expect(result.notes.join(' ')).toContain('no dependency manifest or lockfile was found');
    expect(result.notes.join(' ')).toContain('offline');
  });

  it('reports vulnerable as present-but-empty when network:true is requested, without calling out', async () => {
    const root = await workspace({
      'package.json': JSON.stringify({ name: 'demo', dependencies: { a: '1.0.0' } }),
    });

    const result = await audit(root, true);

    expect(result.network).toBe(true);
    expect(result.outdated).toEqual([]);
    expect(result.vulnerable).toEqual([]);
    expect(result.notes.join(' ')).toContain('no registry client');
  });
});
