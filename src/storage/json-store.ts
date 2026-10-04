import { promises as fs } from 'node:fs';
import path from 'node:path';

import { ensureDir } from './paths.js';

/**
 * Atomic JSON state, used until Phase 3 introduces SQLite.
 * Writes go to a temp file in the same directory and are renamed into place, so a crash
 * can never leave a half-written registry (docs/WORKSPACE-LIFECYCLE.md §5).
 */

export interface ReadJsonResult<T> {
  value: T;
  existed: boolean;
  /** true when the file existed but was unreadable/invalid and the fallback was used. */
  repaired: boolean;
  backupPath?: string;
}

export async function readJson<T>(file: string, fallback: T): Promise<ReadJsonResult<T>> {
  let raw: string;
  try {
    raw = await fs.readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { value: fallback, existed: false, repaired: false };
    }
    throw error;
  }

  try {
    return { value: JSON.parse(raw) as T, existed: true, repaired: false };
  } catch {
    // Corrupt state is preserved next to the original, never silently dropped.
    const backupPath = `${file}.bak`;
    try {
      await fs.writeFile(backupPath, raw, 'utf8');
    } catch {
      /* best effort */
    }
    return { value: fallback, existed: true, repaired: true, backupPath };
  }
}

export async function writeJsonAtomic(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  await fs.writeFile(temp, payload, 'utf8');
  try {
    await fs.rename(temp, file);
  } catch (error) {
    // Windows can refuse a rename while another handle is open; retry once.
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM' || code === 'EBUSY' || code === 'EACCES') {
      await new Promise((resolve) => setTimeout(resolve, 50));
      await fs.rename(temp, file);
      return;
    }
    await fs.rm(temp, { force: true });
    throw error;
  }
}

export async function writeTextAtomic(file: string, text: string): Promise<void> {
  await ensureDir(path.dirname(file));
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(temp, text, 'utf8');
  await fs.rename(temp, file);
}

/** Append a JSON line, creating parent directories as needed. */
export async function appendJsonLine(file: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(file));
  await fs.appendFile(file, `${JSON.stringify(value)}\n`, 'utf8');
}
