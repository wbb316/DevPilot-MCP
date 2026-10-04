import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { SymbolIndex } from '../../src/code/symbol-index';
import { defaultConfig } from '../../src/config/config-schema';
import { workspacePaths } from '../../src/storage/paths';
import { makeTempDir, removeDir, writeFiles } from '../helpers/index';

const PY_UTIL = ['def helper(value):', '    return value + 1', ''].join('\n');
const PY_MAIN = ['from util import helper', '', 'def main():', '    return helper(1)', ''].join('\n');
const JS_UTIL = ['export function compute(x) {', '  return x * 2;', '}', ''].join('\n');
const JS_INDEX = [
  "import { compute } from './util';",
  '',
  'export function run() {',
  '  return compute(2);',
  '}',
  '',
].join('\n');

async function freshIndex(root: string): Promise<SymbolIndex> {
  return SymbolIndex.open({ root, paths: workspacePaths(root), config: defaultConfig() });
}

async function seedWorkspace(): Promise<string> {
  const root = await makeTempDir('devpilot-index-');
  await writeFiles(root, {
    'util.py': PY_UTIL,
    'main.py': PY_MAIN,
    'util.js': JS_UTIL,
    'index.js': JS_INDEX,
  });
  return root;
}

describe('symbol index', () => {
  it('indexes symbols, call references and resolved import edges', async () => {
    const root = await seedWorkspace();
    try {
      const index = await freshIndex(root);
      const report = await index.refresh({ force: true });
      expect(report.indexState).toBe('ready');
      expect(report.files).toBe(4);
      expect(report.parsed).toBe(4);
      expect(report.parseErrors).toBe(0);
      expect(report.store === 'sqlite' || report.store === 'json').toBe(true);

      const helper = index.findSymbols('helper');
      expect(helper.total).toBe(1);
      expect(helper.results[0]).toMatchObject({ name: 'helper', kind: 'function', path: 'util.py' });
      expect(helper.confidence).toBe('high');

      const refs = await index.findReferences('helper');
      expect(refs.definition?.path).toBe('util.py');
      expect(refs.result.results.map((hit) => hit.path)).toContain('main.py');
      expect(refs.result.results[0]?.snippet).toContain('helper');

      const edges = index.importEdges();
      expect(edges.find((edge) => edge.fromPath === 'main.py')?.toPath).toBe('util.py');
      expect(edges.find((edge) => edge.fromPath === 'index.js')?.toPath).toBe('util.js');

      // The index file lives under .devpilot and is written by the refresh itself.
      const store = path.join(root, '.devpilot', report.store === 'sqlite' ? 'devpilot.db' : 'cache/index.json');
      await expect(fs.access(store)).resolves.toBeUndefined();
      index.close();
    } finally {
      await removeDir(root);
    }
  });

  it('re-parses only what changed, and drops deleted files', async () => {
    const root = await seedWorkspace();
    let index: SymbolIndex | undefined;
    try {
      index = await freshIndex(root);
      await index.refresh();

      const second = await index.refresh();
      expect(second.parsed).toBe(0);
      expect(second.reused).toBe(4);

      const mainFile = path.join(root, 'main.py');
      await fs.writeFile(mainFile, `${PY_MAIN}\ndef extra():\n    return 2\n`, 'utf8');
      const future = new Date(Date.now() + 3_000);
      await fs.utimes(mainFile, future, future);

      const third = await index.refresh();
      expect(third.parsed).toBe(1);
      expect(third.reused).toBe(3);
      expect(index.findSymbols('extra').total).toBe(1);

      await fs.rm(path.join(root, 'util.js'));
      const fourth = await index.refresh();
      expect(fourth.removed).toBe(1);
      expect(fourth.files).toBe(3);
      // `compute` was *defined* in the deleted file, so its symbol is gone; its caller in
      // index.js survives.
      expect(index.findSymbols('compute').total).toBe(0);
      expect(index.findSymbols('run').total).toBe(1);
    } finally {
      // Release the SQLite handle before deleting the directory: on Windows an open
      // database file makes the recursive remove retry for a long time.
      index?.close();
      await removeDir(root);
    }
  });

  it('persists the index and reloads it without re-parsing', async () => {
    const root = await seedWorkspace();
    try {
      const first = await freshIndex(root);
      const report = await first.refresh();
      await first.save();
      first.close();

      const reopened = await freshIndex(root);
      expect(reopened.indexState).toBe('ready');
      expect(reopened.counts().files).toBe(report.files);
      const incremental = await reopened.refresh();
      expect(incremental.parsed).toBe(0);
      expect(incremental.reused).toBe(report.files);
      expect(reopened.findSymbols('helper').total).toBe(1);
      reopened.close();
    } finally {
      await removeDir(root);
    }
  });

  it('answers qualified lookups and reports a miss honestly', async () => {
    const root = await seedWorkspace();
    try {
      const index = await freshIndex(root);
      await index.refresh();

      const qualified = index.findSymbols('compute');
      expect(qualified.results[0]?.kind).toBe('function');

      const missing = index.findSymbols('NothingLikeThis');
      expect(missing.total).toBe(0);
      expect(missing.confidence).toBe('low');
      expect(missing.results).toHaveLength(0);

      const missingRefs = await index.findReferences('NothingLikeThis');
      expect(missingRefs.result.total).toBe(0);
      expect(missingRefs.definition).toBeUndefined();
      expect(missingRefs.result.confidence).toBe('low');
      index.close();
    } finally {
      await removeDir(root);
    }
  });
});
