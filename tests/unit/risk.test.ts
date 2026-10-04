import { describe, expect, it } from 'vitest';

import { assessRisk, isTestPath, maxRisk } from '../../src/git/risk';

const base = {
  status: 'modified' as const,
  addedLines: 3,
  deletedLines: 1,
  binary: false,
  changedSymbols: [] as string[],
};

describe('risk rules', () => {
  it('rates a plain source change LOW with a stated reason', () => {
    const result = assessRisk({ ...base, path: 'src/app.ts' });
    expect(result.risk).toBe('LOW');
    expect(result.reasons).toEqual(['source change']);
  });

  it('rates secret-bearing files HIGH', () => {
    for (const path of ['.env', 'config/.env.local', 'certs/server.pem', 'deploy/id_rsa']) {
      expect(assessRisk({ ...base, path }).risk).toBe('HIGH');
    }
    expect(assessRisk({ ...base, path: '.env' }).reasons).toContain('[HIGH] secret-bearing file');
  });

  it('rates security modules and migrations HIGH', () => {
    expect(assessRisk({ ...base, path: 'src/main/java/com/x/security/TokenFilter.java' }).risk).toBe('HIGH');
    expect(assessRisk({ ...base, path: 'db/migrations/V3__add_user.sql' }).risk).toBe('HIGH');
    expect(assessRisk({ ...base, path: 'src/auth/LoginService.java' }).risk).toBe('HIGH');
  });

  it('rates a deleted file HIGH regardless of content', () => {
    const result = assessRisk({ ...base, path: 'src/util.ts', status: 'deleted', deletedLines: 4 });
    expect(result.risk).toBe('HIGH');
    expect(result.reasons).toContain('[HIGH] file deleted');
  });

  it('rates manifests, deploy files and config MEDIUM', () => {
    expect(assessRisk({ ...base, path: 'package.json' }).risk).toBe('MEDIUM');
    expect(assessRisk({ ...base, path: 'pnpm-lock.yaml' }).risk).toBe('MEDIUM');
    expect(assessRisk({ ...base, path: '.github/workflows/ci.yml' }).risk).toBe('MEDIUM');
    expect(assessRisk({ ...base, path: 'config/app.yaml' }).risk).toBe('MEDIUM');
  });

  it('escalates big deletions and reports the threshold it used', () => {
    const large = assessRisk({ ...base, path: 'src/legacy.ts', deletedLines: 260, addedLines: 0 });
    expect(large.risk).toBe('HIGH');
    expect(large.reasons.some((reason) => reason.includes('>= 200 lines removed'))).toBe(true);

    const medium = assessRisk({ ...base, path: 'src/legacy.ts', deletedLines: 60, addedLines: 0 });
    expect(medium.risk).toBe('MEDIUM');
  });

  it('names the symbols a change touches without raising the level by itself', () => {
    const result = assessRisk({ ...base, path: 'src/app.ts', changedSymbols: ['run', 'Helper.parse'] });
    expect(result.risk).toBe('LOW');
    expect(result.reasons.some((reason) => reason.startsWith('touches 2 symbol(s): run, Helper.parse'))).toBe(true);
  });

  it('truncates a long symbol list instead of flooding the answer', () => {
    const many = Array.from({ length: 9 }, (_, index) => `fn${index}`);
    const result = assessRisk({ ...base, path: 'src/app.ts', changedSymbols: many });
    expect(result.reasons.some((reason) => reason.includes('(+4 more)'))).toBe(true);
  });

  it('labels test files as test changes', () => {
    const result = assessRisk({ ...base, path: 'tests/test_app.py' });
    expect(result.risk).toBe('LOW');
    expect(result.reasons).toEqual(['test change']);
  });

  it('recognises test paths across the supported stacks', () => {
    expect(isTestPath('tests/test_app.py')).toBe(true);
    expect(isTestPath('app/spec/user.spec.ts')).toBe(true);
    expect(isTestPath('src/test/java/com/x/UserServiceTest.java')).toBe(true);
    expect(isTestPath('src/main/java/com/x/UserService.java')).toBe(false);
    expect(isTestPath('contest/entry.py')).toBe(false);
  });

  it('orders risk levels consistently', () => {
    expect(maxRisk('LOW', 'HIGH')).toBe('HIGH');
    expect(maxRisk('MEDIUM', 'LOW')).toBe('MEDIUM');
    expect(maxRisk('LOW', 'LOW')).toBe('LOW');
  });
});
