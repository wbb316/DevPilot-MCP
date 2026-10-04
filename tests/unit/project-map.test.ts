import { afterAll, describe, expect, it } from 'vitest';

import { defaultConfig } from '../../src/config/config-schema';
import { detectProject } from '../../src/workspace/project-detector';
import { buildProjectMap, parseJava, parseJavaScript, parsePython } from '../../src/workspace/project-map';
import { copyFixture, makeTempDir, removeDir, writeFiles } from '../helpers/index';

const roots: string[] = [];

async function prepare(fixture: string): Promise<string> {
  const root = await makeTempDir(`devpilot-map-${fixture}-`);
  await copyFixture(fixture, root);
  roots.push(root);
  return root;
}

afterAll(async () => {
  for (const root of roots) await removeDir(root);
});

describe('source parsing (heuristic engine)', () => {
  it('extracts python imports, classes and methods', () => {
    const parsed = parsePython(
      'import os, sys\nfrom .mod import thing\n\nclass A:\n    def go(self):\n        pass\n\ndef top():\n    pass\n',
    );
    expect(parsed.imports).toEqual(['os', 'sys', '.mod']);
    expect(parsed.symbols).toEqual(['A', 'A.go', 'top']);
    expect(parsed.lines).toBe(10);
  });

  it('extracts java package, imports, type and methods', () => {
    const parsed = parseJava(
      'package com.example;\n\nimport java.util.List;\n\npublic class UserService {\n    public int lengthOfTitle(User user) {\n        return 1;\n    }\n}\n',
    );
    expect(parsed.packageName).toBe('com.example');
    expect(parsed.imports).toEqual(['java.util.List']);
    expect(parsed.symbols).toEqual(['UserService', 'lengthOfTitle']);
  });

  it('extracts js/ts imports and exported symbols', () => {
    const parsed = parseJavaScript(
      "import { a } from './x.js';\nconst mod = require('node:path');\nexport function run() {}\nexport class Thing {}\n",
    );
    expect(parsed.imports).toEqual(['./x.js', 'node:path']);
    expect(parsed.symbols).toEqual(['run', 'Thing']);
  });
});

describe('buildProjectMap', () => {
  const config = defaultConfig();

  it('maps the Python fixture with real dependency edges', async () => {
    const root = await prepare('python-project');
    const profile = await detectProject(root, { config });
    const map = await buildProjectMap({ root, profile, config, includeTests: true });

    expect(map.engine).toBe('heuristic-regex');
    expect(map.entrypoints.map((entry) => entry.path)).toContain('train.py');
    expect(map.notes.some((note) => note.includes('heuristic-regex'))).toBe(true);

    const byPath = new Map(map.modules.map((module) => [module.path, module]));
    expect(byPath.get('train.py')?.dependsOn).toEqual(['data.py', 'model.py']);
    expect(byPath.get('model.py')?.usedBy).toEqual(['tests/test_model.py', 'train.py']);
    expect(byPath.get('model.py')?.symbols).toContain('CausalSelfAttention');
    expect(byPath.get('model.py')?.symbols).toContain('GPT.loss');
    expect(byPath.get('train.py')?.role).toBe('entrypoint');
    expect(byPath.get('tests/test_model.py')?.role).toBe('test');
    expect(byPath.get('tests/test_model.py')?.dependsOn).toEqual(['data.py', 'model.py']);

    // Not source, so never a module.
    expect(map.modules.map((module) => module.path)).not.toContain('pyproject.toml');
    expect(map.modules.map((module) => module.path)).not.toContain('README.md');

    const hidden = await buildProjectMap({ root, profile, config });
    expect(hidden.modules.map((module) => module.path)).not.toContain('tests/test_model.py');
    expect(hidden.notes.some((note) => note.includes('test files are hidden'))).toBe(true);
  }, 30_000);

  it('returns a layers hint for the Java fixture and falls back to graph roots', async () => {
    const root = await prepare('maven-project');
    const profile = await detectProject(root, { config });
    const map = await buildProjectMap({ root, profile, config, includeTests: true });

    // 'Database' is only claimed when a Repository actually exists — the fixture has none.
    expect(map.layers).toEqual(['Service']);
    const app = map.modules.find((module) => module.path.endsWith('App.java'));
    expect(app?.symbols).toContain('main');
    expect(app?.role).toBe('source');
    expect(map.notes.some((note) => /graph roots/.test(note))).toBe(true);
  }, 30_000);

  it('derives the Controller → Service → Repository → Database chain when it is really there', async () => {
    const root = await makeTempDir('devpilot-map-spring-');
    roots.push(root);
    await writeFiles(root, {
      'pom.xml': '<project><groupId>com.example</groupId><artifactId>demo</artifactId></project>\n',
      'src/main/java/com/example/UserController.java':
        'package com.example;\n\n@RestController\npublic class UserController {\n    public String get() {\n        return "ok";\n    }\n}\n',
      'src/main/java/com/example/UserService.java':
        'package com.example;\n\n@Service\npublic class UserService {\n    public String find() {\n        return "ok";\n    }\n}\n',
      'src/main/java/com/example/UserRepository.java':
        'package com.example;\n\n@Repository\npublic class UserRepository {\n    public String load() {\n        return "ok";\n    }\n}\n',
      'src/main/java/com/example/UserEntity.java':
        'package com.example;\n\n@Entity\npublic class UserEntity {\n    private String name;\n}\n',
    });

    const profile = await detectProject(root, { config });
    const map = await buildProjectMap({ root, profile, config });
    expect(map.layers).toEqual(['Controller', 'Service', 'Repository', 'Entity', 'Database']);
  }, 30_000);

  it('maps the Node fixture and follows relative imports into tests', async () => {
    const root = await prepare('node-project');
    const profile = await detectProject(root, { config });
    const map = await buildProjectMap({ root, profile, config, includeTests: true });

    const index = map.modules.find((module) => module.path === 'src/index.js');
    expect(index?.symbols).toEqual(expect.arrayContaining(['sum', 'divide', 'main']));
    expect(map.entrypoints.map((entry) => entry.path)).toContain('src/index.js');

    const test = map.modules.find((module) => module.path === 'test/index.test.js');
    expect(test?.dependsOn).toContain('src/index.js');
    expect(index?.usedBy).toContain('test/index.test.js');
  }, 30_000);

  it('does not invent Java layers for a TypeScript project', async () => {
    const root = await makeTempDir('devpilot-map-ts-');
    roots.push(root);
    await writeFiles(root, {
      'package.json': JSON.stringify({ name: 'ts-layers', scripts: { build: 'tsc' } }),
      'src/UserService.ts': 'export class UserService {}\n',
      'src/AppConfig.ts': 'export class AppConfig {}\n',
    });

    const profile = await detectProject(root, { config });
    const map = await buildProjectMap({ root, profile, config });
    expect(map.layers).toBeUndefined();
    expect(map.modules.length).toBeGreaterThan(0);
  }, 30_000);

  it('centres the map on a focus with a bounded number of hops', async () => {
    const root = await prepare('node-project');
    const profile = await detectProject(root, { config });
    const focused = await buildProjectMap({
      root,
      profile,
      config,
      includeTests: true,
      focus: 'src',
      depth: 1,
    });

    expect(focused.modules.map((module) => module.path).sort()).toEqual([
      'src/index.js',
      'test/index.test.js',
    ]);
    expect(focused.notes.some((note) => /focused on "src"/.test(note))).toBe(true);
  }, 30_000);

  it('caps the module list and says so', async () => {
    const root = await prepare('python-project');
    const profile = await detectProject(root, { config });
    const capped = await buildProjectMap({ root, profile, config, includeTests: true, maxModules: 2 });
    expect(capped.modules).toHaveLength(2);
    expect(capped.truncated).toBe(true);
    expect(capped.notes.some((note) => /module cap reached/.test(note))).toBe(true);
  }, 30_000);
});
