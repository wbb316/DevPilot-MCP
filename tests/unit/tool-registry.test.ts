import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createMcpServer, listToolNames } from '../../src/server/mcp-server';
import { ServerContext } from '../../src/server/context';
import { defineTool, invokeTool, toCallToolResult } from '../../src/server/tool-registry';
import { ok } from '../../src/errors/envelope';
import { silentLogger } from '../../src/log/logger';
import { VERSION } from '../../src/version';
import { makeTempDir, removeDir } from '../helpers/index';

async function tempContext(): Promise<ServerContext> {
  const home = await makeTempDir('devpilot-context-');
  return await ServerContext.create({ home, logger: silentLogger() });
}

describe('server context', () => {
  it('creates the DevPilot home layout', async () => {
    const home = await makeTempDir('devpilot-home-');
    try {
      const context = await ServerContext.create({ home, logger: silentLogger() });
      expect(context.home).toBe(home);
      await expect(fs.access(path.join(home, 'logs'))).resolves.toBeUndefined();
      await context.dispose();
    } finally {
      await removeDir(home);
    }
  });
});

describe('tool registry', () => {
  const probeTool = defineTool({
    name: 'probe',
    title: 'Probe',
    description: 'test tool',
    permission: 'READ_ONLY',
    inputSchema: { value: z.number().int() },
    handler: async (args) => ok(`value ${args.value}`, { value: args.value }),
  });

  const workspaceTool = defineTool({
    name: 'probe_workspace',
    title: 'Probe workspace',
    description: 'test tool needing a workspace',
    permission: 'READ_ONLY',
    requiresWorkspace: true,
    inputSchema: {},
    handler: async (_args, context) => ok('ok', { root: context.workspace?.root ?? null }),
  });

  it('returns structured content for a valid call', async () => {
    const context = await tempContext();
    const result = await invokeTool(context, probeTool, { value: 7 });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      success: true,
      summary: 'value 7',
      data: { value: 7 },
    });
    expect(result.content[0]).toMatchObject({ type: 'text' });
  });

  it('reports INVALID_ARGUMENT with zod issues', async () => {
    const context = await tempContext();
    const result = await invokeTool(context, probeTool, { value: 'nope' });
    expect(result.isError).toBe(true);
    const envelope = result.structuredContent as { error: { code: string; details: unknown[] } };
    expect(envelope.error.code).toBe('INVALID_ARGUMENT');
    expect(Array.isArray(envelope.error.details)).toBe(true);
    expect(envelope.error.details.length).toBeGreaterThan(0);
  });

  it('requires an open workspace before running workspace tools', async () => {
    const context = await tempContext();
    const result = await invokeTool(context, workspaceTool, {});
    const envelope = result.structuredContent as { error: { code: string; hint?: string } };
    expect(envelope.error.code).toBe('WORKSPACE_NOT_OPEN');
    expect(envelope.error.hint).toMatch(/open_workspace/);
  });

  it('exposes envelopes as JSON text plus structured content', () => {
    const result = toCallToolResult(ok('done', { a: 1 }));
    const text = (result.content[0] as { text: string }).text;
    expect(JSON.parse(text)).toEqual(result.structuredContent);
  });

  it('assembles the MCP server with the tools of the shipped phases registered', async () => {
    const context = await tempContext();
    const server = createMcpServer(context);
    expect(listToolNames()).toEqual([
      'open_workspace',
      'get_workspace_status',
      'close_workspace',
      'scan_project',
      'get_project_map',
      'find_symbol',
      'find_references',
      'build_project',
      'run_project',
      'run_tests',
      'run_test',
    ]);
    const registered = Object.keys(
      (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools ?? {},
    );
    expect(registered.sort()).toEqual([
      'build_project',
      'close_workspace',
      'find_references',
      'find_symbol',
      'get_project_map',
      'get_workspace_status',
      'open_workspace',
      'run_project',
      'run_test',
      'run_tests',
      'scan_project',
    ]);
    await server.close();
  });

  it('keeps the reported version in sync with package.json', async () => {
    const raw = await fs.readFile(path.resolve(import.meta.dirname, '..', '..', 'package.json'), 'utf8');
    const pkg = JSON.parse(raw) as { name: string; version: string };
    expect(pkg.version).toBe(VERSION);
  });
});
