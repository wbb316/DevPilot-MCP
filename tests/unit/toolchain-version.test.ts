import { describe, expect, it } from 'vitest';

import { parseToolVersion, TOOLS } from '../../src/environment/toolchain';

/**
 * Version parsing is the only place `doctor` can silently lie: a wrong regex turns "installed" into
 * "unknown" and makes the whole report misleading. These samples are the real output shapes of the
 * tools on the supported platforms.
 */
describe('toolchain version parsing', () => {
  const samples: { tool: string; output: string; expected: string }[] = [
    { tool: 'git', output: 'git version 2.51.1.windows.1', expected: '2.51.1' },
    { tool: 'node', output: 'v22.23.2', expected: '22.23.2' },
    { tool: 'npm', output: '10.9.2', expected: '10.9.2' },
    { tool: 'python', output: 'Python 3.11.9', expected: '3.11.9' },
    { tool: 'pip', output: 'pip 24.0 from /usr/lib/python3/dist-packages/pip (python 3.11)', expected: '24.0' },
    { tool: 'conda', output: 'conda 24.1.2', expected: '24.1.2' },
    { tool: 'java', output: 'openjdk version "21.0.1" 2023-10-17 LTS', expected: '21.0.1' },
    { tool: 'javac', output: 'javac 21.0.1', expected: '21.0.1' },
    {
      tool: 'mvn',
      output: 'Apache Maven 3.9.11 (3e54c93a704957b63ee3494413a2b544fd3d825b)',
      expected: '3.9.11',
    },
    { tool: 'gradle', output: 'Gradle 8.5', expected: '8.5' },
    { tool: 'nvcc', output: 'Cuda compilation tools, release 12.1, V12.1.105', expected: '12.1' },
    { tool: 'docker', output: 'Docker version 27.3.1, build ce12230', expected: '27.3.1' },
  ];

  for (const sample of samples) {
    it(`parses ${sample.tool}`, () => {
      const spec = TOOLS.find((candidate) => candidate.name === sample.tool);
      expect(spec?.versionPattern, `no probe defined for ${sample.tool}`).toBeDefined();
      expect(parseToolVersion(sample.output, spec?.versionPattern as RegExp)).toBe(sample.expected);
    });
  }

  it('reports nothing when the output does not carry a version', () => {
    const spec = TOOLS.find((candidate) => candidate.name === 'git');
    expect(parseToolVersion('command not found', spec?.versionPattern as RegExp)).toBeUndefined();
  });

  it('describes a fix for every probe it can fail on', () => {
    for (const spec of TOOLS) {
      expect(spec.fix.length, spec.name).toBeGreaterThan(0);
    }
  });
});
