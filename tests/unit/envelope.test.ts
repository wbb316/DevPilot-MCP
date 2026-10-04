import { describe, expect, it } from 'vitest';

import { fail, guard, isOk, ok } from '../../src/errors/envelope';
import { DevPilotError, errors } from '../../src/errors/devpilot-error';
import { ERROR_CODES, RETRYABLE_CODES } from '../../src/types/errors';

describe('envelope', () => {
  it('builds a success envelope and omits empty extras', () => {
    const envelope = ok('did the thing', { value: 1 }, { artifacts: {}, warnings: [] });
    expect(envelope).toEqual({ success: true, summary: 'did the thing', data: { value: 1 } });
    expect(isOk(envelope)).toBe(true);
  });

  it('keeps artifacts and warnings when present', () => {
    const envelope = ok('ran', { total: 3 }, { artifacts: { log: '.devpilot/logs/x.log' }, warnings: ['careful'] });
    expect(envelope.artifacts).toEqual({ log: '.devpilot/logs/x.log' });
    expect(envelope.warnings).toEqual(['careful']);
  });

  it('turns a DevPilotError into a typed failure', () => {
    const envelope = fail(errors.workspaceNotOpen());
    expect(envelope.success).toBe(false);
    if (envelope.success) throw new Error('unreachable');
    expect(envelope.error.code).toBe('WORKSPACE_NOT_OPEN');
    expect(envelope.error.hint).toBe('Call open_workspace first.');
  });

  it('normalises an unexpected throw to INTERNAL_ERROR without a stack', () => {
    const envelope = fail(new Error('boom'));
    expect(envelope.success).toBe(false);
    if (envelope.success) throw new Error('unreachable');
    expect(envelope.error.code).toBe('INTERNAL_ERROR');
    expect(JSON.stringify(envelope)).not.toContain('at Object');
    expect(envelope.error.retryable).toBeUndefined();
  });

  it('marks timeouts as retryable', () => {
    const envelope = fail(errors.commandTimeout('npm test', 120));
    if (envelope.success) throw new Error('unreachable');
    expect(envelope.error.retryable).toBe(true);
  });

  it('guards async handlers', async () => {
    const good = await guard(async () => ok('fine', {}));
    expect(good.success).toBe(true);
    const bad = await guard(async () => {
      throw errors.notImplemented('run_tests', 5);
    });
    if (bad.success) throw new Error('unreachable');
    expect(bad.error.code).toBe('NOT_IMPLEMENTED');
  });
});

describe('error codes', () => {
  it('are unique', () => {
    expect(new Set(ERROR_CODES).size).toBe(ERROR_CODES.length);
  });

  it('include the codes the docs promise', () => {
    for (const code of ['WORKSPACE_NOT_OPEN', 'CONFIG_INVALID', 'PATH_OUTSIDE_WORKSPACE', 'PERMISSION_DENIED', 'TEST_FAILED']) {
      expect(ERROR_CODES).toContain(code as (typeof ERROR_CODES)[number]);
    }
  });

  it('keep the retryable list a subset of the codes', () => {
    for (const code of RETRYABLE_CODES) expect(ERROR_CODES).toContain(code);
  });

  it('preserves details for machine-readable fixes', () => {
    const error = new DevPilotError('INVALID_ARGUMENT', 'bad', { details: { field: 'path' } });
    const envelope = error.toEnvelope();
    expect(envelope.error.details).toEqual({ field: 'path' });
  });
});
