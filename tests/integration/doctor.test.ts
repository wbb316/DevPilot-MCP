import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { doctorTool } from '../../src/tools/doctor';
import { renderReport } from '../../src/cli/commands/doctor';
import type { EnvironmentReport, ToolchainCheck } from '../../src/types/environment';
import { makeTempDir, removeDir } from '../helpers/index';

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  error?: { code: string; message: string };
  warnings?: string[];
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

/**
 * `doctor` against the real machine. The point is that the report is not invented: git and node are
 * installed here, so they must come back OK *with a parsed version*, and node's version must match
 * the interpreter running the test.
 */
describe('doctor on this machine', () => {
  let context: ServerContext;
  let home: string;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-doctor-home-');
    context = await ServerContext.create({ home, logger: silentLogger() });
  }, 30_000);

  afterAll(async () => {
    await removeDir(home);
  });

  it('reports the toolchains this machine really has', async () => {
    const result = await invokeTool(context, doctorTool, {});
    const envelope = envelopeOf<EnvironmentReport>(result);
    expect(envelope.success, JSON.stringify(envelope.error)).toBe(true);

    const report = envelope.data as EnvironmentReport;
    expect(report.os.cpus).toBeGreaterThan(0);
    expect(report.os.memoryGb).toBeGreaterThan(0);
    expect(report.tools.length).toBeGreaterThan(5);
    expect(['OK', 'WARNING', 'ERROR']).toContain(report.overall);

    const find = (name: string): ToolchainCheck | undefined =>
      report.tools.find((tool) => tool.name === name) ??
      report.conflicts.find((conflict) => conflict.name === name);

    const git = find('git');
    expect(git?.status, 'git is installed on this machine').toBe('OK');
    expect(git?.version).toMatch(/^\d+\.\d+/);

    const node = find('node');
    expect(node?.status).toBe('OK');
    expect(node?.version).toBe(process.version.replace(/^v/, ''));
  }, 120_000);

  it('always gives an agent something actionable for a missing tool', async () => {
    const result = await invokeTool(context, doctorTool, { verbose: true });
    const report = envelopeOf<EnvironmentReport>(result).data as EnvironmentReport;
    for (const tool of report.tools) {
      if (tool.status === 'OK') continue;
      expect(tool.fix ?? tool.message, `${tool.name} has neither a fix nor a message`).toBeDefined();
    }
  }, 120_000);

  it('renders the same report for a human', async () => {
    const result = await invokeTool(context, doctorTool, {});
    const report = envelopeOf<EnvironmentReport>(result).data as EnvironmentReport;
    const text = renderReport(report);
    expect(text).toContain('Toolchains:');
    expect(text).toContain('Overall:');
    expect(text).toContain('git');
  }, 120_000);
});
