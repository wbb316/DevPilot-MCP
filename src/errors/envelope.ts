import type { ErrEnvelope, OkEnvelope, ToolEnvelope } from '../types/errors.js';
import { redactDeep, redactSecrets } from '../security/redact.js';
import { DevPilotError } from './devpilot-error.js';

export interface OkExtras {
  artifacts?: Record<string, string>;
  warnings?: string[];
}

/**
 * Build a success envelope. `summary` must be a sentence an agent can show a human.
 *
 * Secret redaction lives here because this is the single choke point every tool result passes
 * through: a tool added later cannot forget to sanitise its own payload (Phase 9). When something
 * was replaced the envelope says so, so a truncated-looking value is never mistaken for the real one.
 */
export function ok<T>(summary: string, data: T, extras: OkExtras = {}): OkEnvelope<T> {
  const safeSummary = redactSecrets(summary);
  const safeData = redactDeep(data);
  const warnings = [...(extras.warnings ?? [])];
  const matches = safeSummary.matches + safeData.matches;
  if (matches > 0) {
    const kinds = [...new Set([...safeSummary.kinds, ...safeData.kinds])].join(', ');
    warnings.push(`${matches} secret-like value(s) were redacted from this output (${kinds})`);
  }

  const envelope: OkEnvelope<T> = { success: true, summary: safeSummary.text, data: safeData.value };
  if (extras.artifacts && Object.keys(extras.artifacts).length > 0) {
    envelope.artifacts = redactDeep(extras.artifacts).value;
  }
  if (warnings.length > 0) {
    envelope.warnings = warnings;
  }
  return envelope;
}

/** Build a failure envelope from anything throwable. Never leaks a raw stack, never leaks a secret. */
export function fail(error: unknown): ErrEnvelope {
  const envelope = DevPilotError.from(error).toEnvelope();
  const message = redactSecrets(envelope.error.message);
  const safe: ErrEnvelope = { ...envelope, error: { ...envelope.error, message: message.text } };

  const hint = envelope.error.hint === undefined ? undefined : redactSecrets(envelope.error.hint);
  if (hint !== undefined && hint.matches > 0) safe.error.hint = hint.text;
  if (envelope.error.details !== undefined) safe.error.details = redactDeep(envelope.error.details).value;

  return safe;
}

export function isOk<T>(envelope: ToolEnvelope<T>): envelope is OkEnvelope<T> {
  return envelope.success === true;
}

/** Chain-of-lifecycle helpers keep tool handlers free of try/catch boilerplate. */
export async function guard<T>(fn: () => Promise<ToolEnvelope<T>>): Promise<ToolEnvelope<T>> {
  try {
    return await fn();
  } catch (error) {
    return fail(error);
  }
}
