import type { ErrEnvelope, OkEnvelope, ToolEnvelope } from '../types/errors.js';
import { DevPilotError } from './devpilot-error.js';

export interface OkExtras {
  artifacts?: Record<string, string>;
  warnings?: string[];
}

/** Build a success envelope. `summary` must be a sentence an agent can show a human. */
export function ok<T>(summary: string, data: T, extras: OkExtras = {}): OkEnvelope<T> {
  const envelope: OkEnvelope<T> = { success: true, summary, data };
  if (extras.artifacts && Object.keys(extras.artifacts).length > 0) {
    envelope.artifacts = extras.artifacts;
  }
  if (extras.warnings && extras.warnings.length > 0) {
    envelope.warnings = extras.warnings;
  }
  return envelope;
}

/** Build a failure envelope from anything throwable. Never leaks a raw stack. */
export function fail(error: unknown): ErrEnvelope {
  return DevPilotError.from(error).toEnvelope();
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
