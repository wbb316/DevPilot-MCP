import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { ServerContext } from '../../src/server/context';
import { invokeTool } from '../../src/server/tool-registry';
import { silentLogger } from '../../src/log/logger';
import { closeWorkspaceTool } from '../../src/tools/close-workspace';
import { getProjectMapTool } from '../../src/tools/get-project-map';
import { getWorkspaceStatusTool } from '../../src/tools/get-workspace-status';
import { openWorkspaceTool } from '../../src/tools/open-workspace';
import { scanProjectTool } from '../../src/tools/scan-project';
import { copyFixture, makeTempDir, removeDir } from '../helpers/index';

interface Envelope<T> {
  success: boolean;
  summary?: string;
  data?: T;
  error?: { code: string; message: string; hint?: string };
  warnings?: string[];
}

function envelopeOf<T>(result: CallToolResult): Envelope<T> {
  return result.structuredContent as unknown as Envelope<T>;
}

interface ScanData {
  profile: { projectType: string; entrypoints: string[]; markers: string[]; languages: string[] };
  stats: { files: number; dirs: number; bytes: number; fromCache: boolean; truncated: boolean };
  topLevel: { name: string; hint: string }[];
  indexState: string;
  cacheFile: string;
  notes: string[];
}

interface StatusData {
  workspace: { profile: { projectType: string; entrypoints: string[] } };
  index: { state: string; fileCount?: number };
}

interface MapData {
  entrypoints: { path: string; imports: number; summary: string }[];
  modules: { path: string; role: string; symbols: string[]; dependsOn: string[]; usedBy: string[] }[];
  engine: string;
  notes: string[];
}

describe('Phase 2 tools through the registry', () => {
  let context: ServerContext;
  let home: string;
  let workspace: string;
  let emptyWorkspace: string;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-scan-tools-home-');
    workspace = await makeTempDir('devpilot-scan-tools-ws-');
    emptyWorkspace = await makeTempDir('devpilot-scan-tools-empty-');
    await copyFixture('python-project', workspace);
    context = await ServerContext.create({ home, logger: silentLogger() });
  }, 60_000);

  afterAll(async () => {
    await context.dispose();
    await removeDir(home);
    await removeDir(workspace);
    await removeDir(emptyWorkspace);
  });

  it('refuses to scan before a workspace is open', async () => {
    const result = await invokeTool(context, scanProjectTool, {});
    expect(result.isError).toBe(true);
    expect(envelopeOf(result).error?.code).toBe('WORKSPACE_NOT_OPEN');
  });

  it('scans the opened workspace, writes the cache and updates session state', async () => {
    const opened = await invokeTool(context, openWorkspaceTool, { path: workspace });
    expect(opened.isError).toBe(false);

    const first = await invokeTool(context, scanProjectTool, {});
    expect(first.isError).toBe(false);
    const data = envelopeOf<ScanData>(first).data as ScanData;
    expect(data.profile.projectType).toBe('PyTorch');
    expect(data.profile.entrypoints).toContain('train.py');
    expect(data.stats.files).toBeGreaterThan(0);
    expect(data.stats.bytes).toBeGreaterThan(0);
    expect(data.stats.fromCache).toBe(false);
    expect(data.stats.truncated).toBe(false);
    expect(data.indexState).toBe('ready');
    expect(data.cacheFile).toBe('.devpilot/cache/project.json');
    expect(data.topLevel.map((entry) => entry.name)).toContain('train.py');
    expect(data.notes.some((note) => note.includes('heuristic') || note.includes('cap'))).toBe(false);

    const second = await invokeTool(context, scanProjectTool, {});
    const secondData = envelopeOf<ScanData>(second).data as ScanData;
    expect(secondData.stats.fromCache).toBe(true);
    expect(secondData.stats.files).toBe(data.stats.files);

    const forced = await invokeTool(context, scanProjectTool, { force: true });
    expect((envelopeOf<ScanData>(forced).data as ScanData).stats.fromCache).toBe(false);

    // The scanned profile is what the session now reports.
    const status = await invokeTool(context, getWorkspaceStatusTool, {});
    const statusData = envelopeOf<StatusData>(status).data as StatusData;
    expect(statusData.index.state).toBe('ready');
    expect(statusData.index.fileCount).toBe(data.stats.files);
    expect(statusData.workspace.profile.entrypoints).toContain('train.py');
  }, 60_000);

  it('maps the project through the tool, with schema defaults applied', async () => {
    const result = await invokeTool(context, getProjectMapTool, { includeTests: true });
    expect(result.isError).toBe(false);
    const data = envelopeOf<MapData>(result).data as MapData;
    expect(data.engine).toBe('heuristic-regex');
    expect(data.entrypoints.map((entry) => entry.path)).toContain('train.py');
    const model = data.modules.find((module) => module.path === 'model.py');
    expect(model?.symbols).toContain('CausalSelfAttention');
    expect(model?.usedBy).toContain('train.py');

    // includeTests defaults to false: the test module disappears, and the note says so.
    const defaults = await invokeTool(context, getProjectMapTool, {});
    const defaultData = envelopeOf<MapData>(defaults).data as MapData;
    expect(defaultData.modules.some((module) => module.path.startsWith('tests/'))).toBe(false);
    expect(defaultData.notes.some((note) => note.includes('test files are hidden'))).toBe(true);
  }, 60_000);

  it('reports UNSUPPORTED_PROJECT for a directory with no project in it', async () => {
    const opened = await invokeTool(context, openWorkspaceTool, { path: emptyWorkspace });
    expect(opened.isError).toBe(false);

    const result = await invokeTool(context, scanProjectTool, {});
    expect(result.isError).toBe(true);
    const envelope = envelopeOf(result);
    expect(envelope.error?.code).toBe('UNSUPPORTED_PROJECT');
    expect(envelope.error?.hint).toMatch(/config\.yml/);

    // The workspace is still usable afterwards.
    const closed = await invokeTool(context, closeWorkspaceTool, {});
    expect(closed.isError).toBe(false);
  }, 60_000);
});
