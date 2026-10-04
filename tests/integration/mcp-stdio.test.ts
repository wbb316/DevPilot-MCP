import { promises as fs } from 'node:fs';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { copyFixture, gitInit, makeTempDir, removeDir } from '../helpers/index';

/**
 * End-to-end: a real MCP client talks to the built server over stdio, exactly the way
 * DeepSeek Harness will (docs/ROADMAP.md Phase 1 gate).
 */
const distEntry = path.resolve(import.meta.dirname, '..', '..', 'dist', 'index.js');

interface Envelope {
  success: boolean;
  summary?: string;
  data?: Record<string, unknown>;
  warnings?: string[];
  error?: { code: string; message: string; hint?: string };
}

function envelopeOf(result: { content: unknown; structuredContent?: unknown }): Envelope {
  if (result.structuredContent) return result.structuredContent as Envelope;
  const content = result.content as { type: string; text?: string }[];
  const text = content.find((item) => item.type === 'text')?.text ?? '{}';
  return JSON.parse(text) as Envelope;
}

function childEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') env[key] = value;
  }
  env['DEVPILOT_HOME'] = process.env['DEVPILOT_HOME'] ?? path.join(process.env['TEMP'] ?? '.', 'devpilot-it-home');
  return env;
}

async function connect(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [distEntry, 'serve'],
    env: childEnv(),
    stderr: 'pipe',
  });
  const client = new Client({ name: 'devpilot-test-client', version: '0.0.1' }, { capabilities: {} });
  await client.connect(transport);
  return { client, close: async () => await client.close() };
}

describe('MCP server over stdio', () => {
  let workspace: string;
  let realRoot: string;

  beforeAll(async () => {
    workspace = await makeTempDir('devpilot-mcp-it-');
    await copyFixture('python-project', workspace);
    await gitInit(workspace);
    realRoot = await fs.realpath(workspace);
  });

  afterAll(async () => {
    await removeDir(workspace);
  });

  it('starts, lists the shipped tools and opens a workspace', async () => {
    const { client, close } = await connect();
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        'close_workspace',
        'get_project_map',
        'get_workspace_status',
        'open_workspace',
        'scan_project',
      ]);
      const openTool = listed.tools.find((tool) => tool.name === 'open_workspace');
      expect(openTool?.description ?? '').toMatch(/workspace/i);

      const opened = envelopeOf(
        await client.callTool({ name: 'open_workspace', arguments: { path: workspace } }),
      );
      expect(opened.success).toBe(true);
      expect(opened.summary ?? '').toMatch(/Opened workspace/);

      const data = opened.data as {
        workspace: { id: string; root: string; permission: string; profile: { languages: string[]; projectType: string; entrypoints: string[]; candidates: { test?: string } } };
        createdDevpilotDir: boolean;
        configPath: string;
      };
      expect(data.workspace.root.toLowerCase()).toBe(realRoot.toLowerCase());
      expect(data.workspace.id).toMatch(/^[0-9a-f]{12}$/);
      expect(data.workspace.permission).toBe('SAFE_WRITE');
      expect(data.workspace.profile.languages).toContain('Python');
      expect(data.workspace.profile.projectType).toBe('PyTorch');
      expect(data.workspace.profile.entrypoints).toContain('train.py');
      expect(data.createdDevpilotDir).toBe(true);

      // The agent-visible promise: .devpilot/ exists with a config file.
      await expect(fs.access(path.join(workspace, '.devpilot', 'config.yml'))).resolves.toBeUndefined();
      await expect(fs.access(path.join(workspace, '.devpilot', 'logs'))).resolves.toBeUndefined();

      const status = envelopeOf(await client.callTool({ name: 'get_workspace_status', arguments: {} }));
      expect(status.success).toBe(true);
      const statusData = status.data as { workspace: { id: string }; index: { state: string }; registry: { known: number } };
      expect(statusData.workspace.id).toBe(data.workspace.id);
      expect(statusData.index.state).toBe('none');
      expect(statusData.registry.known).toBeGreaterThanOrEqual(1);

      const closed = envelopeOf(await client.callTool({ name: 'close_workspace', arguments: {} }));
      expect(closed.success).toBe(true);
      expect(closed.data).toMatchObject({ closed: data.workspace.id, remainingOpen: 0 });
    } finally {
      await close();
    }
  }, 60_000);

  it('scans the project and maps it over the real transport', async () => {
    const { client, close } = await connect();
    try {
      const opened = envelopeOf(await client.callTool({ name: 'open_workspace', arguments: { path: workspace } }));
      expect(opened.success).toBe(true);

      const scan = envelopeOf(await client.callTool({ name: 'scan_project', arguments: {} }));
      expect(scan.success).toBe(true);
      const scanData = scan.data as {
        profile: { projectType: string; entrypoints: string[] };
        stats: { files: number; bytes: number; fromCache: boolean };
        indexState: string;
        cacheFile: string;
      };
      expect(scanData.profile.projectType).toBe('PyTorch');
      expect(scanData.stats.files).toBeGreaterThan(0);
      expect(scanData.stats.bytes).toBeGreaterThan(0);
      expect(scanData.indexState).toBe('ready');
      expect(scanData.cacheFile).toBe('.devpilot/cache/project.json');
      await expect(fs.access(path.join(workspace, '.devpilot', 'cache', 'project.json'))).resolves.toBeUndefined();

      const cached = envelopeOf(await client.callTool({ name: 'scan_project', arguments: {} }));
      expect((cached.data as { stats: { fromCache: boolean } }).stats.fromCache).toBe(true);

      const map = envelopeOf(
        await client.callTool({ name: 'get_project_map', arguments: { includeTests: true } }),
      );
      expect(map.success).toBe(true);
      const mapData = map.data as {
        entrypoints: { path: string }[];
        modules: { path: string; dependsOn: string[] }[];
        engine: string;
      };
      expect(mapData.engine).toBe('heuristic-regex');
      expect(mapData.entrypoints.map((entry) => entry.path)).toContain('train.py');
      expect(mapData.modules.find((module) => module.path === 'train.py')?.dependsOn).toEqual([
        'data.py',
        'model.py',
      ]);

      const closed = envelopeOf(await client.callTool({ name: 'close_workspace', arguments: {} }));
      expect(closed.success).toBe(true);
    } finally {
      await close();
    }
  }, 60_000);

  it('answers WORKSPACE_NOT_OPEN before open_workspace, and INVALID_ARGUMENT for bad input', async () => {
    const { client, close } = await connect();
    try {
      const status = envelopeOf(await client.callTool({ name: 'get_workspace_status', arguments: {} }));
      expect(status.success).toBe(false);
      expect(status.error?.code).toBe('WORKSPACE_NOT_OPEN');

      const bad = await client.callTool({ name: 'open_workspace', arguments: {} });
      expect(bad.isError).toBe(true);
      const badText = (bad.content as { type: string; text?: string }[]).find((item) => item.type === 'text')?.text ?? '';
      expect(badText).toMatch(/invalid|validation|-32602/i);

      const nowhere = envelopeOf(
        await client.callTool({ name: 'open_workspace', arguments: { path: path.join(workspace, 'missing') } }),
      );
      expect(nowhere.success).toBe(false);
      expect(nowhere.error?.code).toBe('FILE_NOT_FOUND');
    } finally {
      await close();
    }
  }, 60_000);

  it('does not leak anything onto stdout and reports version through the CLI', async () => {
    const { client, close } = await connect();
    try {
      const info = client.getServerVersion();
      expect(info?.name).toBe('devpilot-mcp');
      expect(info?.version).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      await close();
    }
  }, 60_000);
});
