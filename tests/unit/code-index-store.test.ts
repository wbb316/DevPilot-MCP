import path from 'node:path';
import { describe, expect, it } from 'vitest';

import type { IndexSnapshot } from '../../src/code/index-store';
import {
  INDEX_SCHEMA_VERSION,
  JsonPersistence,
  hashContent,
  openPersistence,
} from '../../src/code/index-store';
import { workspacePaths } from '../../src/storage/paths';
import { makeTempDir, removeDir } from '../helpers/index';

function snapshot(): IndexSnapshot {
  return {
    meta: {
      schemaVersion: INDEX_SCHEMA_VERSION,
      rootHash: 'abc123',
      indexedAt: '2025-01-01T00:00:00.000Z',
      fileCount: 1,
    },
    files: [
      {
        id: 1,
        path: 'model.py',
        language: 'python',
        sizeBytes: 42,
        mtimeMs: 1_700_000_000_000,
        hash: 'deadbeef',
        parsedAt: '2025-01-01T00:00:00.000Z',
      },
    ],
    symbols: [
      {
        id: 1,
        fileId: 1,
        path: 'model.py',
        name: 'Block',
        kind: 'class',
        startLine: 1,
        endLine: 5,
        signature: 'class Block:',
        visibility: 'public',
      },
    ],
    refs: [
      {
        id: 1,
        symbolName: 'Block',
        path: 'model.py',
        line: 9,
        column: 3,
        kind: 'call',
        containerName: 'main',
      },
    ],
    imports: [{ fromPath: 'model.py', toPath: 'util.py', raw: 'import util', line: 1 }],
  };
}

describe('index persistence', () => {
  it('round-trips a snapshot through the configured store', async () => {
    const root = await makeTempDir('devpilot-store-ws-');
    try {
      const paths = workspacePaths(root);
      const { persistence, fallbackReason } = await openPersistence(paths);
      if (fallbackReason !== undefined) {
        // Reported, never silent: the JSON fallback must still round-trip.
        expect(persistence.kind).toBe('json');
      }
      await persistence.save(snapshot());
      const loaded = await persistence.load();
      expect(loaded).toEqual(snapshot());
      persistence.close();
    } finally {
      await removeDir(root);
    }
  });

  it('round-trips through the JSON fallback store explicitly', async () => {
    const dir = await makeTempDir('devpilot-store-json-');
    try {
      const file = path.join(dir, 'index.json');
      const persistence = new JsonPersistence(file);
      await persistence.save(snapshot());
      expect(persistence.kind).toBe('json');
      const loaded = await persistence.load();
      expect(loaded?.symbols[0]?.name).toBe('Block');
      expect(loaded?.refs[0]?.kind).toBe('call');
      expect(loaded?.imports[0]?.toPath).toBe('util.py');
    } finally {
      await removeDir(dir);
    }
  });

  it('refuses a snapshot written by another schema version', async () => {
    const dir = await makeTempDir('devpilot-store-schema-');
    try {
      const file = path.join(dir, 'index.json');
      const persistence = new JsonPersistence(file);
      const stale = snapshot();
      stale.meta.schemaVersion = INDEX_SCHEMA_VERSION + 1;
      await persistence.save(stale);
      expect(await persistence.load()).toBeUndefined();
    } finally {
      await removeDir(dir);
    }
  });

  it('hashes content by revision, not by identity', () => {
    expect(hashContent('a')).toBe(hashContent('a'));
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });
});
