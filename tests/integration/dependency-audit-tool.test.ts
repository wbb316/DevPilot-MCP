import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { closeWorkspaceTool } from '../../src/tools/close-workspace';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { dependencyAuditTool } from '../../src/tools/dependency-audit';
import { copyFixture, makeTempDir, removeDir, writeFiles } from '../helpers/index';

/**
 * `dependency_audit` through the registry. The tool is imported directly (registration in
 * src/tools/index.ts is wired elsewhere), and every fixture is copied into a temp directory
 * first: nothing runs inside `fixtures/`.
 */

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  error?: { code: string; message: string; hint?: string };
  warnings?: string[];
}

interface AuditData {
  ecosystems: {
    name: string;
    manifestFiles: string[];
    direct: number;
    transitive: number;
    lockFile?: string;
    notes?: string[];
  }[];
  direct: number;
  transitive: number;
  outdated: { name: string }[];
  vulnerable?: unknown[];
  lockIssues: { path: string; kind: string; message: string; severity: string }[];
  notes: string[];
  truncated: boolean;
  network: boolean;
  scannedFiles: number;
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

function auditDataOf(result: CallToolResult): AuditData {
  return envelopeOf<AuditData>(result).data as AuditData;
}

describe('dependency_audit through the registry', () => {
  let context: ServerContext;
  let home: string;
  let pythonWorkspace: string;
  let multiWorkspace: string;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-dep-audit-home-');
    pythonWorkspace = await makeTempDir('devpilot-dep-audit-py-');
    multiWorkspace = await makeTempDir('devpilot-dep-audit-multi-');
    await copyFixture('python-project', pythonWorkspace);
    // A workspace whose three ecosystems have known, hand-checkable counts.
    await writeFiles(multiWorkspace, {
      'package.json': JSON.stringify({
        name: 'multi',
        dependencies: { express: '^4.18.2' },
        devDependencies: { vitest: '^1.0.0' },
      }),
      'package-lock.json': JSON.stringify({
        lockfileVersion: 3,
        packages: {
          '': { dependencies: { express: '^4.18.2' }, devDependencies: { vitest: '^1.0.0' } },
          'node_modules/express': { version: '4.18.2' },
          'node_modules/vitest': { version: '1.6.0' },
          'node_modules/accepts': { version: '1.3.8' },
        },
      }),
      'requirements.txt': 'requests==2.31.0\n',
      'build.gradle': ["dependencies {", "  implementation 'com.google.guava:guava:32.1.0-jre'", "  testImplementation 'org.junit.jupiter:junit-jupiter:5.10.0'", '}', ''].join('\n'),
    });
    context = await ServerContext.create({ home, logger: silentLogger() });
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(pythonWorkspace);
    await removeDir(multiWorkspace);
  });

  it('refuses to audit before a workspace is open', async () => {
    const result = await invokeTool(context, dependencyAuditTool, {});
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('WORKSPACE_NOT_OPEN');
  });

  it('audits the opened python fixture and keeps the frozen data contract', async () => {
    const opened = await invokeTool(context, openWorkspaceTool, { path: pythonWorkspace });
    expect(opened.isError).toBe(false);

    const result = await invokeTool(context, dependencyAuditTool, {});
    expect(result.isError).toBe(false);
    const envelope = envelopeOf<AuditData>(result);
    const data = auditDataOf(result);

    // Frozen keys from docs/TOOLS.md Phase 9.
    expect(Object.keys(data)).toEqual(
      expect.arrayContaining(['ecosystems', 'direct', 'transitive', 'outdated', 'lockIssues']),
    );
    expect(data.ecosystems.map((profile) => profile.name)).toEqual(['python']);
    // The fixture also has a pyproject.toml. It is a python manifest (it is read), so it belongs in
    // the list even though it declares no runtime dependencies — the list names the manifests that
    // were parsed, not only the ones that contributed a dependency.
    expect(data.ecosystems[0]?.manifestFiles).toEqual(['pyproject.toml', 'requirements.txt']);
    expect(data.direct).toBe(2); // torch, pytest
    expect(data.transitive).toBe(0); // no lockfile: nothing knows about transitives
    // The fixture pins nothing, so both declarations are unpinned and no lockfile exists.
    expect(data.lockIssues.map((issue) => issue.kind).sort()).toEqual(['missing_lock', 'unpinned', 'unpinned']);
    expect(data.lockIssues.every((issue) => issue.path === 'requirements.txt')).toBe(true);
    expect(data.lockIssues.some((issue) => issue.severity === 'ERROR')).toBe(true);

    // Offline by default: outdated is empty, vulnerable is absent, and warnings say why.
    expect(data.network).toBe(false);
    expect(data.outdated).toEqual([]);
    expect(data.vulnerable).toBeUndefined();
    expect(data.notes.join(' ')).toContain('offline');
    expect(envelope.warnings?.join(' ')).toContain('offline');
    expect(envelope.summary).toContain('offline (network: false)');

    // An audit writes nothing into the workspace.
    const status = await invokeTool(context, dependencyAuditTool, { network: false });
    expect(status.isError).toBe(false);
  });

  it('selects the workspace through the path argument', async () => {
    const opened = await invokeTool(context, openWorkspaceTool, { path: multiWorkspace });
    expect(opened.isError).toBe(false);

    const result = await invokeTool(context, dependencyAuditTool, { path: multiWorkspace });
    expect(result.isError).toBe(false);
    const data = auditDataOf(result);

    const byName = new Map(data.ecosystems.map((profile) => [profile.name, profile]));
    expect([...byName.keys()]).toEqual(['npm', 'python', 'gradle']);

    const npm = byName.get('npm');
    expect(npm?.manifestFiles).toEqual(['package.json']);
    expect(npm?.lockFile).toBe('package-lock.json');
    expect(npm?.direct).toBe(2);
    expect(npm?.transitive).toBe(1); // accepts, known only to the lockfile

    const python = byName.get('python');
    expect(python?.direct).toBe(1);
    // Python has no lockfile here, and its single declaration is exact, so only missing_lock.
    expect(data.lockIssues.filter((issue) => issue.path === 'requirements.txt').map((issue) => issue.kind)).toEqual([
      'missing_lock',
    ]);

    const gradle = byName.get('gradle');
    expect(gradle?.manifestFiles).toEqual(['build.gradle']);
    expect(gradle?.direct).toBe(2);
    expect(gradle?.transitive).toBe(0);
    // Gradle avoids missing_lock: it keeps no lockfile unless dependency locking is enabled.
    expect(data.lockIssues.some((issue) => issue.kind === 'missing_lock' && issue.path === 'build.gradle')).toBe(false);

    expect(data.direct).toBe(5);
    expect(data.transitive).toBe(1);

    // Deterministic: a second call returns byte-identical issues.
    const again = await invokeTool(context, dependencyAuditTool, {});
    expect(JSON.stringify(auditDataOf(again).lockIssues)).toBe(JSON.stringify(data.lockIssues));
  });

  it('reports vulnerable as present-but-empty for network:true and warns that no lookup happened', async () => {
    const result = await invokeTool(context, dependencyAuditTool, { network: true });
    expect(result.isError).toBe(false);
    const envelope = envelopeOf<AuditData>(result);
    const data = auditDataOf(result);

    expect(data.network).toBe(true);
    expect(data.outdated).toEqual([]);
    expect(data.vulnerable).toEqual([]);
    expect(data.notes.join(' ')).toContain('no registry client');
    expect(envelope.warnings?.join(' ')).toContain('no registry client');
    expect(envelope.summary).toContain('offline (network: true)');
  });

  it('reports the missing lockfile as an ERROR warning count in the envelope', async () => {
    const result = await invokeTool(context, dependencyAuditTool, {});
    const envelope = envelopeOf<AuditData>(result);
    const errors = auditDataOf(result).lockIssues.filter((issue) => issue.severity === 'ERROR');

    expect(errors.length).toBeGreaterThan(0);
    expect(envelope.warnings?.some((warning) => warning.includes(`${errors.length} lock problem(s)`))).toBe(true);
  });

  it('closes the workspace and cleans up', async () => {
    const closed = await invokeTool(context, closeWorkspaceTool, {});
    expect(closed.isError).toBe(false);

    const after = await invokeTool(context, dependencyAuditTool, {});
    expect(after.isError).toBe(true);
    expect(envelopeOf(after).error?.code).toBe('WORKSPACE_NOT_OPEN');
  });
});
