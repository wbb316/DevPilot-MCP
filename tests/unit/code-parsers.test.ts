import { describe, expect, it } from 'vitest';

import { extractFile, supportsLanguage } from '../../src/code/extract';
import { javaParser } from '../../src/code/lang/java';
import { resolveRelativeSpecifier, typescriptParser } from '../../src/code/lang/javascript';
import { pythonParser } from '../../src/code/lang/python';
import { maskNonCode } from '../../src/code/text-utils';

/**
 * Parser tests pin the two things an agent depends on: real scope boundaries (start/end
 * lines) and the *absence* of bogus symbols — a body statement must never become a method,
 * and a brace inside a string must never end a class.
 */

const PYTHON = [
  'import math',
  'from typing import Optional',
  '',
  '',
  'class Block:',
  '    """A block."""',
  '',
  '    def __init__(self, size=4):',
  '        self.size = size',
  '',
  '    def forward(self, x):',
  '        return helper(x)',
  '',
  '    @staticmethod',
  '    def reset(block):',
  '        block.size = 0',
  '',
  '',
  'def helper(x):',
  '    return math.sqrt(x)',
  '',
  '',
  'WIDTH = 3',
  '',
].join('\n');

const JAVA = [
  'package com.example;',
  '',
  'import java.util.List;',
  '',
  '@Service',
  'public class UserService extends BaseService implements Runnable {',
  '    private final UserRepository repository;',
  '',
  '    public UserService(UserRepository repository) {',
  '        this.repository = repository;',
  '    }',
  '',
  '    public String findName(long id) throws IllegalStateException {',
  '        String raw = repository.load(id);',
  '        return raw + "}";',
  '    }',
  '',
  '    @Override',
  '    public void run() {',
  '        findName(1L);',
  '    }',
  '}',
  '',
].join('\n');

const TYPESCRIPT = [
  "import { readFile } from 'node:fs';",
  "import { helper } from './util';",
  "import React from 'react';",
  '',
  'export interface Options {',
  '  verbose: boolean;',
  '}',
  '',
  'export class Trainer extends Base implements Runner {',
  '  private epochs = 3;',
  '  readonly name: string;',
  '',
  '  constructor(name: string) {',
  '    super();',
  '    this.name = name;',
  '  }',
  '',
  '  async train(data: number[]): Promise<void> {',
  '    helper(data);',
  '    const model = new Model();',
  '    model.fit(data);',
  '  }',
  '}',
  '',
  'export function makeTrainer(): Trainer {',
  "  return new Trainer('x');",
  '}',
  '',
  'export const arrow = (n: number) => n * 2;',
  '',
].join('\n');

describe('python parser', () => {
  const parsed = pythonParser.parse(PYTHON);
  const byName = (name: string) => parsed.symbols.filter((symbol) => symbol.name === name);

  it('tracks indentation-based scope ends', () => {
    const block = byName('Block')[0];
    expect(block?.kind).toBe('class');
    expect(block?.startLine).toBe(5);
    expect(block?.endLine).toBe(16);
    expect(block?.doc).toBe('A block.');
  });

  it('separates methods from module functions and fields from variables', () => {
    const forward = byName('forward')[0];
    expect(forward?.kind).toBe('method');
    expect(forward?.parentName).toBe('Block');
    expect(forward?.startLine).toBe(11);
    expect(byName('helper')[0]?.kind).toBe('function');
    expect(byName('helper')[0]?.parentName).toBeUndefined();
    expect(byName('WIDTH')[0]?.kind).toBe('variable');
    expect(byName('__init__')[0]?.visibility).toBe('public');
  });

  it('records imports, calls, attribute calls and self-fields', () => {
    expect(parsed.imports.some((edge) => edge.toPath === 'typing.py')).toBe(true);
    const imports = parsed.refs.filter((ref) => ref.kind === 'import');
    expect(imports.map((ref) => ref.name)).toContain('Optional');
    expect(parsed.refs.some((ref) => ref.name === 'helper' && ref.kind === 'call')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'sqrt' && ref.kind === 'call')).toBe(true);
    const selfField = parsed.refs.find((ref) => ref.name === 'size' && ref.kind === 'field');
    expect(selfField?.containerName).toBe('__init__');
    expect(parsed.refs.some((ref) => ref.name === 'staticmethod' && ref.kind === 'text')).toBe(true);
    expect(parsed.refsTruncated).toBe(false);
  });
});

describe('java parser', () => {
  const parsed = javaParser.parse(JAVA);
  const byName = (name: string) => parsed.symbols.filter((symbol) => symbol.name === name);

  it('keeps the class body intact even with a brace inside a string literal', () => {
    const service = byName('UserService').find((symbol) => symbol.kind === 'class');
    expect(service?.startLine).toBe(6);
    // `return raw + "}"` must not terminate the class early.
    expect(service?.endLine).toBe(22);
  });

  it('finds the class, its members and their visibility', () => {
    expect(byName('repository')[0]).toMatchObject({
      kind: 'field',
      visibility: 'private',
      parentName: 'UserService',
      startLine: 7,
    });
    expect(byName('UserService').some((symbol) => symbol.kind === 'constructor')).toBe(true);
    expect(byName('findName')[0]).toMatchObject({ kind: 'method', visibility: 'public', startLine: 13 });
    expect(byName('run')[0]?.kind).toBe('method');
  });

  it('never turns a statement inside a method body into a member', () => {
    // `String raw = repository.load(id);` used to look like a method named `load`.
    expect(byName('raw')).toHaveLength(0);
    expect(byName('load')).toHaveLength(0);
  });

  it('records imports, inheritance, annotations and calls', () => {
    expect(parsed.imports[0]?.toPath).toBe('java/util/List.java');
    expect(parsed.refs.some((ref) => ref.name === 'BaseService' && ref.kind === 'extends')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'Runnable' && ref.kind === 'implements')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'Service' && ref.kind === 'type')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'findName' && ref.kind === 'call')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'String' && ref.kind === 'type')).toBe(true);
  });
});

describe('typescript parser', () => {
  const parsed = typescriptParser.parse(TYPESCRIPT, { path: 'src/trainer.ts' });
  const byName = (name: string) => parsed.symbols.filter((symbol) => symbol.name === name);

  it('resolves relative specifiers and leaves bare ones unresolved', () => {
    expect(resolveRelativeSpecifier('src/trainer.ts', './util')).toBe('src/util');
    expect(parsed.imports.map((edge) => edge.toPath)).toEqual([undefined, 'src/util', undefined]);
  });

  it('finds classes, interfaces, functions, arrows and members', () => {
    expect(byName('Trainer')[0]).toMatchObject({ kind: 'class', startLine: 9 });
    expect(byName('Options')[0]?.kind).toBe('interface');
    expect(byName('makeTrainer')[0]?.kind).toBe('function');
    expect(byName('arrow')[0]?.kind).toBe('function');
    expect(byName('epochs')[0]).toMatchObject({ kind: 'field', parentName: 'Trainer' });
    expect(byName('train')[0]).toMatchObject({ kind: 'method', parentName: 'Trainer', startLine: 18 });
    expect(byName('constructor')[0]?.kind).toBe('constructor');
  });

  it('never turns a statement inside a method body into a member', () => {
    expect(byName('helper')).toHaveLength(0);
    expect(byName('fit')).toHaveLength(0);
    expect(byName('model')).toHaveLength(0);
  });

  it('records inheritance, this-fields, types and calls', () => {
    expect(parsed.refs.some((ref) => ref.name === 'Base' && ref.kind === 'extends')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'Runner' && ref.kind === 'implements')).toBe(true);
    // containerName is the enclosing *type* for java/ts parsers, the enclosing block for python.
    expect(parsed.refs.find((ref) => ref.name === 'name' && ref.kind === 'field')?.containerName).toBe('Trainer');
    expect(parsed.refs.some((ref) => ref.name === 'helper' && ref.kind === 'call')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'Model' && ref.kind === 'call')).toBe(true);
    expect(parsed.refs.some((ref) => ref.name === 'Promise' && ref.kind === 'type')).toBe(true);
  });
});

describe('extract dispatcher', () => {
  it('reports support per language and contains parser failures to one file', () => {
    expect(supportsLanguage('python')).toBe(true);
    expect(supportsLanguage('kotlin')).toBe(false);
    expect(extractFile('kotlin', 'fun main() {}')).toBeUndefined();
    const parsed = extractFile('python', 'def broken(:\n');
    expect(parsed).toBeDefined();
  });

  it('masks comments and string bodies without moving offsets', () => {
    const source = 'x = "# not a comment"  # real comment\ny = 1\n';
    const masked = maskNonCode(source, 'python');
    expect(masked).toHaveLength(source.length);
    expect(masked.split('\n')[0]).not.toContain('not a comment');
    expect(masked.split('\n')[1]).toBe('y = 1');
    // Newlines survive, so line numbers taken from the masked text stay correct.
    expect(masked.split('\n')).toHaveLength(source.split('\n').length);
  });
});
