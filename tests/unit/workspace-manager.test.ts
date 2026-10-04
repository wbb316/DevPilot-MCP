import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { silentLogger } from '../../src/log/logger';
import { WorkspaceManager, isPermissionLevel, workspaceId } from '../../src/workspace/workspace-manager';
import { copyFixture, gitInit, makeTempDir, removeDir, writeFiles } from '../helpers/index';

describe('WorkspaceManager', () => {
  let home: string;
  let workspace: string;
  let second: string;
  let manager: WorkspaceManager;

  beforeAll(async () => {
    home = await makeTempDir('devpilot-wm-home-');
    workspace = await makeTempDir('devpilot-wm-project-');
    second = await makeTempDir('devpilot-wm-project2-');
    await copyFixture('python-project', workspace);
    await writeFiles(second, { 'README.md': '# second\n' });
    await gitInit(workspace);
    await gitInit(second, 'second initial');
    manager = new WorkspaceManager({
      home,
      logger: silentLogger(),
      env: { ...process.env, DEVPILOT_HOME: home },
    });
  });

  afterAll(async () => {
    await removeDir(home);
    await removeDir(workspace);
    await removeDir(second);
  });

  it('opens a workspace following the documented ten steps', async () => {
    const result = await manager.openWorkspace({ path: workspace });

    expect(result.workspace.id).toMatch(/^[0-9a-f]{12}$/);
    expect(result.workspace.id).toBe(workspaceId(result.workspace.root));
    expect(result.createdDevpilotDir).toBe(true);
    expect(result.workspace.permission).toBe('SAFE_WRITE');
    expect(result.workspace.indexState).toBe('none');
    expect(result.workspace.profile.languages).toContain('Python');

    // .devpilot layout + config file
    const devpilotDir = path.join(workspace, '.devpilot');
    expect(result.configPath).toBe(path.join(devpilotDir, 'config.yml'));
    for (const relative of ['.', 'cache', 'logs', 'checkpoints']) {
      await expect(fs.access(path.join(devpilotDir, relative))).resolves.toBeUndefined();
    }
    await expect(fs.readFile(result.configPath, 'utf8')).resolves.toContain('permission: SAFE_WRITE');

    // registry in the DevPilot home, never in the project
    const registry = JSON.parse(await fs.readFile(path.join(home, 'registry.json'), 'utf8')) as {
      workspaces: { id: string; root: string }[];
    };
    expect(registry.workspaces.map((entry) => entry.id)).toContain(result.workspace.id);
    await expect(fs.access(path.join(home, 'logs'))).resolves.toBeUndefined();

    // git snapshot of a committed tree
    expect(result.workspace.git.available).toBe(true);
    expect(result.workspace.git.isRepo).toBe(true);
    expect(result.workspace.git.branch).toBe('main');
    expect(result.workspace.git.head).toMatch(/^[0-9a-f]{7,}$/);
    expect(result.workspace.git.dirty).toBe(false);
  });

  it('warns that .devpilot is missing from .gitignore', async () => {
    const result = await manager.openWorkspace({ path: workspace });
    expect(result.warnings.join(' ')).toMatch(/\.gitignore/);
  });

  it('is idempotent for the same root', async () => {
    const result = await manager.openWorkspace({ path: workspace });
    expect(result.createdDevpilotDir).toBe(false);
    expect(result.warnings.join(' ')).not.toMatch(/created/);
    const registry = JSON.parse(await fs.readFile(path.join(home, 'registry.json'), 'utf8')) as {
      workspaces: unknown[];
    };
    expect(registry.workspaces).toHaveLength(1);
  });

  it('reports status for the active workspace and resolves by path', async () => {
    const opened = await manager.openWorkspace({ path: second });
    const byDefault = await manager.getStatus();
    expect(byDefault.workspace.id).toBe(opened.workspace.id);
    expect(byDefault.devpilotHome).toBe(home);
    expect(byDefault.registry.known).toBe(2);

    const byPath = await manager.getStatus(path.join(workspace, 'train.py'));
    expect(byPath.workspace.root.toLowerCase()).toBe((await fs.realpath(workspace)).toLowerCase());
  });

  it('detects a dirty working tree without touching it', async () => {
    await fs.writeFile(path.join(second, 'README.md'), '# second (edited)\n', 'utf8');
    const result = await manager.openWorkspace({ path: second, createConfig: false });
    expect(result.workspace.git.dirty).toBe(true);
    expect(result.workspace.git.changedFiles).toBe(1);
    expect(result.warnings.join(' ')).toMatch(/uncommitted|already has/i);
    // the user edit is still there
    expect(await fs.readFile(path.join(second, 'README.md'), 'utf8')).toContain('edited');
  });

  it('separates open workspaces by id and closes them', async () => {
    expect(manager.listOpen().length).toBeGreaterThanOrEqual(2);
    const closed = await manager.close(path.join(workspace, 'train.py'));
    expect(closed.closed).toBe(workspaceId(await fs.realpath(workspace)));
    const status = await manager.getStatus();
    expect(status.workspace.id).toBe(workspaceId(await fs.realpath(second)));
    await expect(manager.getStatus(path.join(workspace, 'train.py'))).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_OPEN',
    });
  });

  it('rejects a path that is not a directory', async () => {
    const file = path.join(second, 'README.md');
    await expect(manager.openWorkspace({ path: file })).rejects.toMatchObject({
      code: 'WORKSPACE_NOT_FOUND',
    });
  });

  it('reports a missing path as FILE_NOT_FOUND', async () => {
    await expect(manager.openWorkspace({ path: path.join(second, 'nope') })).rejects.toMatchObject({
      code: 'FILE_NOT_FOUND',
    });
  });

  it('fails CONFIG_INVALID without opening and leaves the file alone', async () => {
    const broken = await makeTempDir('devpilot-wm-broken-');
    try {
      await writeFiles(broken, { '.devpilot/config.yml': 'security:\n  permission: NOPE\n' });
      await expect(manager.openWorkspace({ path: broken })).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
      expect(await fs.readFile(path.join(broken, '.devpilot', 'config.yml'), 'utf8')).toContain('NOPE');
      await expect(manager.getStatus(broken)).rejects.toMatchObject({ code: 'WORKSPACE_NOT_FOUND' });
    } finally {
      await removeDir(broken);
    }
  });

  it('honours an explicit permission override', async () => {
    const result = await manager.openWorkspace({ path: workspace, permission: 'READ_ONLY' });
    expect(result.workspace.permission).toBe('READ_ONLY');
    expect(manager.sessionCapabilities(result.workspace).execute).toBe(false);
  });

  it('rebuilds a corrupt registry instead of failing', async () => {
    const file = path.join(home, 'registry.json');
    await fs.writeFile(file, '{ not json', 'utf8');
    const result = await manager.openWorkspace({ path: workspace });
    expect(result.workspace.id).toBeDefined();
    await expect(fs.access(`${file}.bak`)).resolves.toBeUndefined();
    const repaired = JSON.parse(await fs.readFile(file, 'utf8')) as { workspaces: unknown[] };
    expect(repaired.workspaces.length).toBeGreaterThan(0);
  });

  it('validates permission level literals', () => {
    expect(isPermissionLevel('SAFE_WRITE')).toBe(true);
    expect(isPermissionLevel('ADMIN')).toBe(false);
    expect(isPermissionLevel(undefined)).toBe(false);
  });

  it('resolves a workspace by id as well as by path', async () => {
    const opened = await manager.openWorkspace({ path: workspace });
    const byId = await manager.getStatus(opened.workspace.id);
    expect(byId.workspace.id).toBe(opened.workspace.id);
    const byRelativePath = await manager.getStatus('train.py');
    expect(byRelativePath.workspace.id).toBe(opened.workspace.id);
  });
});
