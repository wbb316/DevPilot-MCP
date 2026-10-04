import { describe, expect, it } from 'vitest';

import { decideTestStatus } from '../../src/test/test-runner';

const base = {
  timedOut: false,
  exitCode: 0,
  parsed: true,
  noTestsDetected: false,
  total: 3,
  failed: 0,
  errors: 0,
};

describe('decideTestStatus', () => {
  it('reports passed only when a summary was really read', () => {
    expect(decideTestStatus(base)).toBe('passed');
  });

  it('refuses to call an unreadable run passed (Phase 10: Maven -q hid the summary)', () => {
    expect(decideTestStatus({ ...base, parsed: false, total: 0 })).toBe('unknown');
  });

  it('reports no_tests when the framework said there is nothing to run', () => {
    expect(decideTestStatus({ ...base, noTestsDetected: true, parsed: false, total: 0 })).toBe('no_tests');
    expect(decideTestStatus({ ...base, parsed: true, total: 0 })).toBe('no_tests');
  });

  it('treats a non-zero exit with counts as failed, without counts as error', () => {
    expect(decideTestStatus({ ...base, exitCode: 1, failed: 2 })).toBe('failed');
    expect(decideTestStatus({ ...base, exitCode: 1, parsed: false, total: 0 })).toBe('error');
  });

  it('lets a timeout outrank everything else', () => {
    expect(decideTestStatus({ ...base, timedOut: true, exitCode: 0 })).toBe('timeout');
  });
});
