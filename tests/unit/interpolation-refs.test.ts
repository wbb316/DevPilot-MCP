import { describe, expect, it } from 'vitest';

import { extractFile } from '../../src/code/extract';
import { maskNonCode } from '../../src/code/text-utils';

/**
 * Phase 10 regression: code written inside a string interpolation is code. The masker used to
 * blank whole f-strings, so `f"{service.average_price('input'):.2f}"` produced no reference at
 * all — the real-project V1 acceptance run lost exactly that call site.
 */
describe('code inside string interpolations', () => {
  it('keeps Python f-string fields as code', () => {
    const masked = maskNonCode(`print(f"avg {service.average_price('input'):.2f}")`, 'python');
    expect(masked).toContain('service.average_price');
    // the nested string literal stays masked: only the expression around it is code
    expect(masked).not.toContain('input');
  });

  it('still masks an ordinary string body', () => {
    const masked = maskNonCode(`note = "call average_price(1) here"`, 'python');
    expect(masked).not.toContain('average_price');
    expect(masked).toContain('note =');
  });

  it('hides a string literal nested inside a field but keeps the expression', () => {
    const masked = maskNonCode(`label = f"{mapping['key']}"`, 'python');
    expect(masked).toContain('mapping[');
    expect(masked).not.toContain('key');
  });

  it('treats doubled braces as literal text', () => {
    const masked = maskNonCode(`t = f"{{not_a_state}} {render(item)}"`, 'python');
    expect(masked).not.toContain('not_a_state');
    expect(masked).toContain('render(item)');
  });

  it('does not treat an identifier ending in f as a f-string prefix', () => {
    const masked = maskNonCode(`value = myf"average_price(1)"`, 'python');
    expect(masked).not.toContain('average_price');
  });

  it('keeps JS/TS template substitutions as code', () => {
    const masked = maskNonCode('const s = `${format(total)} ms`;', 'typescript');
    expect(masked).toContain('format(total)');
    expect(masked).not.toContain(' ms');
  });

  it('reports references written inside an f-string (end-to-end through the parser)', () => {
    const source = [
      'class Formatter:',
      '    def render(self, value):',
      '        return f"value: {self.normalise(value)}"',
      '',
      '    def normalise(self, value):',
      '        return f"{value}"',
      '',
    ].join('\n');
    const parsed = extractFile('python', source, { path: 'src/app/fmt.py' });
    const refs = parsed.refs.map((ref) => `${ref.name}@${ref.line}`);
    expect(refs).toContain('normalise@3');
  });

  it('keeps template substitutions visible to the TypeScript parser', () => {
    const source = ['export function label(total: number): string {', '  return `${format(total)} ms`;', '}', ''].join('\n');
    const parsed = extractFile('typescript', source, { path: 'src/label.ts' });
    const refs = parsed.refs.map((ref) => `${ref.name}@${ref.line}`);
    expect(refs).toContain('format@2');
  });
});
