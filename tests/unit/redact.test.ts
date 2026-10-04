import { describe, expect, it } from 'vitest';

import { containsSecret, redactDeep, redactSecrets, REDACTED } from '../../src/security/redact';

describe('secret redaction', () => {
  it('replaces known credential shapes', () => {
    const cases: string[] = [
      'aws key AKIAIOSFODNN7EXAMPLE here',
      'token ghp_1234567890abcdefghijklmnopqrstuvwx',
      'key sk-abcdefghijklmnopqrstuvwx',
      'slack xoxb-1234567890-abcdefghijkl',
      'google AIzaSyA1234567890abcdefghijklmnopqrstuv',
      'Authorization: Bearer abcdef123456ghijkl',
    ];
    for (const text of cases) {
      const result = redactSecrets(text);
      expect(result.matches, text).toBeGreaterThan(0);
      expect(result.text).toContain(REDACTED);
    }
  });

  it('replaces a PEM private key block as a whole', () => {
    const pem = ['-----BEGIN RSA PRIVATE KEY-----', 'MIIEowIBAAKCAQEA', '-----END RSA PRIVATE KEY-----'].join(
      '\n',
    );
    const result = redactSecrets(`before\n${pem}\nafter`);
    expect(result.text).not.toContain('MIIEowIBAAKCAQEA');
    expect(result.text.startsWith('before')).toBe(true);
    expect(result.text.endsWith('after')).toBe(true);
  });

  it('replaces quoted and opaque credential values but keeps the key name', () => {
    // ALL-CAPS keys are treated as dotenv/CI assignments: the whole value goes, quotes included.
    expect(redactSecrets('API_KEY = "super-secret-value"').text).toBe(`API_KEY = ${REDACTED}`);
    expect(redactSecrets('DB_PASSWORD=hunter2').text).toBe(`DB_PASSWORD=${REDACTED}`);
    // Lowercase names are only redacted when the value itself looks like a credential.
    expect(redactSecrets('auth_token: "super-secret-value"').text).toBe(`auth_token: "${REDACTED}"`);
    expect(redactSecrets('client_secret: 8f3a9b2c1d4e5f60718293a4b5c6d7e8').text).toBe(
      `client_secret: ${REDACTED}`,
    );
  });

  it('drops credentials embedded in a URL', () => {
    const result = redactSecrets('postgres://admin:s3cretpw@localhost:5432/app');
    expect(result.text).toBe('postgres://admin:[redacted]@localhost:5432/app');
  });

  it('leaves ordinary code alone', () => {
    const samples = [
      'const token = computeToken(request);',
      'self.token = self.tokenizer.vocab_size',
      'token: string;',
      'access_token_expiry_seconds = 3600',
      'password = hashPassword(userInput)',
    ];
    for (const sample of samples) {
      expect(redactSecrets(sample).text, sample).toBe(sample);
    }
  });

  it('reports whether a string carries a secret', () => {
    expect(containsSecret('nothing to see')).toBe(false);
    expect(containsSecret('ghp_1234567890abcdefghijklmnopqrstuvwx')).toBe(true);
  });

  it('walks nested values and leaves non-plain objects untouched', () => {
    const when = new Date('2025-01-01T00:00:00.000Z');
    const result = redactDeep({
      evidence: ['DB_PASSWORD=hunter2', 'plain line'],
      nested: { list: ['AKIAIOSFODNN7EXAMPLE'] },
      when,
      count: 3,
    });
    expect(result.matches).toBeGreaterThanOrEqual(2);
    expect(result.kinds).toContain('env_assignment');
    expect(result.value.evidence[0]).toBe(`DB_PASSWORD=${REDACTED}`);
    expect(result.value.evidence[1]).toBe('plain line');
    expect(result.value.nested.list[0]).toBe(REDACTED);
    expect(result.value.when).toBe(when);
    expect(result.value.count).toBe(3);
  });
});
