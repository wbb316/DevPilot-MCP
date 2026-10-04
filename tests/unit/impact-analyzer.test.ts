import { describe, expect, it } from 'vitest';

import { assessRisks, normalizeRelative } from '../../src/impact/impact-analyzer.js';
import type { ImpactRiskLevel, ImpactTargetKind } from '../../src/types/impact.js';
import type { SymbolKind } from '../../src/types/code.js';

/**
 * Phase 8 unit tests for the deterministic halves of impact analysis: target normalization
 * (never let a target escape the workspace) and the risk rules. The end-to-end behaviour of
 * `analyzeImpact` is covered by tests/integration/impact-tool.test.ts.
 */

describe('normalizeRelative', () => {
  it('accepts workspace-relative paths in either separator style', () => {
    expect(normalizeRelative('src/app.py')).toBe('src/app.py');
    expect(normalizeRelative('src\\app.py')).toBe('src/app.py');
    expect(normalizeRelative('./src/app.py')).toBe('src/app.py');
    expect(normalizeRelative('  src/app.py  ')).toBe('src/app.py');
    expect(normalizeRelative('src//app.py')).toBe('src/app.py');
    expect(normalizeRelative('src/./app.py')).toBe('src/app.py');
  });

  it('refuses absolute paths and anything that climbs out of the workspace', () => {
    expect(normalizeRelative('C:/Users/me/project')).toBeUndefined();
    expect(normalizeRelative('D:\\Projects\\x')).toBeUndefined();
    expect(normalizeRelative('/etc/passwd')).toBeUndefined();
    expect(normalizeRelative('../outside.py')).toBeUndefined();
    expect(normalizeRelative('src/../../outside.py')).toBeUndefined();
    expect(normalizeRelative('')).toBeUndefined();
    expect(normalizeRelative('   ')).toBeUndefined();
  });
});

interface RiskOverrides {
  referenceCount?: number;
  referenceFiles?: number;
  declarationPaths?: string[];
  declarationKinds?: SymbolKind[];
  targetKind?: ImpactTargetKind;
  rawTarget?: string;
  relatedTests?: string[];
  exactDefinitions?: number;
  reverse?: Map<string, string[]>;
  forward?: Map<string, string[]>;
  truncated?: boolean;
}

function riskInput(overrides: RiskOverrides = {}): Parameters<typeof assessRisks>[0] {
  return {
    facts: {
      referenceCount: overrides.referenceCount ?? 0,
      referenceFiles: overrides.referenceFiles ?? 0,
      declarationPaths: overrides.declarationPaths ?? ['src/app.py'],
      declarationKinds: overrides.declarationKinds ?? ['function'],
      truncated: overrides.truncated ?? false,
      totalAffected: 1,
    },
    targetKind: overrides.targetKind ?? 'symbol',
    declarationPaths: overrides.declarationPaths ?? ['src/app.py'],
    declarationKinds: overrides.declarationKinds ?? ['function'],
    rawTarget: overrides.rawTarget ?? 'app',
    relatedTests: overrides.relatedTests ?? [],
    reverse: overrides.reverse ?? new Map(),
    forward: overrides.forward ?? new Map(),
    exactDefinitions: overrides.exactDefinitions ?? 1,
  };
}

function levels(overrides: RiskOverrides = {}): ImpactRiskLevel[] {
  return assessRisks(riskInput(overrides)).map((risk) => risk.level);
}

describe('assessRisks', () => {
  it('scales with the reference count', () => {
    expect(levels({ referenceCount: 0, exactDefinitions: 0 })).not.toContain('HIGH');
    expect(levels({ referenceCount: 1, referenceFiles: 1, relatedTests: ['tests/test_app.py'] })).toContain('LOW');
    expect(levels({ referenceCount: 10, referenceFiles: 3, relatedTests: ['tests/test_app.py'] })).toContain(
      'MEDIUM',
    );
    expect(levels({ referenceCount: 31, referenceFiles: 9, relatedTests: ['tests/test_app.py'] })).toContain(
      'HIGH',
    );
  });

  it('flags type declarations, name collisions and qualified targets', () => {
    const typeRisk = assessRisks(
      riskInput({ declarationKinds: ['class'], referenceCount: 2, relatedTests: ['tests/t.py'] }),
    );
    expect(typeRisk.some((risk) => risk.reason.includes('type declaration'))).toBe(true);

    const collision = assessRisks(
      riskInput({ exactDefinitions: 3, referenceCount: 2, relatedTests: ['tests/t.py'] }),
    );
    expect(collision.some((risk) => risk.reason.includes('share this name'))).toBe(true);

    const qualified = assessRisks(
      riskInput({ rawTarget: 'GPT.forward', referenceCount: 2, relatedTests: ['tests/t.py'] }),
    );
    expect(qualified.some((risk) => risk.reason.includes('name-matched'))).toBe(true);
  });

  it('says when nothing was found at all', () => {
    const risks = assessRisks(riskInput({ referenceCount: 0, exactDefinitions: 0, declarationPaths: [] }));
    expect(risks.some((risk) => risk.reason.includes('confirm the spelling'))).toBe(true);
  });

  it('rates high fan-in, circular imports and manifests as structural hazards', () => {
    const fanIn = new Map<string, string[]>();
    fanIn.set('src/core.py', Array.from({ length: 12 }, (_v, i) => `src/m${i}.py`));
    const fanInRisks = assessRisks(
      riskInput({
        declarationPaths: ['src/core.py'],
        referenceCount: 3,
        relatedTests: ['tests/t.py'],
        reverse: fanIn,
      }),
    );
    expect(fanInRisks.some((risk) => risk.level === 'HIGH' && risk.reason.includes('imported by 12'))).toBe(true);

    const forward = new Map<string, string[]>();
    forward.set('src/a.py', ['src/b.py']);
    const reverse = new Map<string, string[]>();
    reverse.set('src/a.py', ['src/b.py']);
    const cyclic = assessRisks(
      riskInput({
        declarationPaths: ['src/a.py'],
        referenceCount: 3,
        relatedTests: ['tests/t.py'],
        reverse,
        forward,
      }),
    );
    expect(cyclic.some((risk) => risk.reason.includes('circular import'))).toBe(true);

    const manifest = assessRisks(
      riskInput({
        declarationPaths: ['package.json'],
        referenceCount: 3,
        relatedTests: ['tests/t.py'],
      }),
    );
    expect(manifest.some((risk) => risk.level === 'HIGH' && risk.reason.includes('manifest'))).toBe(true);
  });

  it('flags an untested target and orders risks strongest first', () => {
    const untested = assessRisks(riskInput({ referenceCount: 4, relatedTests: [] }));
    expect(untested.some((risk) => risk.reason.includes('unverified by the suite'))).toBe(true);

    const mixed = assessRisks(
      riskInput({
        referenceCount: 31,
        referenceFiles: 9,
        declarationKinds: ['class'],
        relatedTests: ['tests/t.py'],
      }),
    );
    expect(mixed[0]?.level).toBe('HIGH');
    expect(mixed[mixed.length - 1]?.level).toBe('MEDIUM');

    // A directory target is a summary, not a call site: no "untested" claim is made.
    const directory = assessRisks(
      riskInput({ targetKind: 'directory', referenceCount: 4, relatedTests: [] }),
    );
    expect(directory.some((risk) => risk.reason.includes('unverified by the suite'))).toBe(false);
  });
});
