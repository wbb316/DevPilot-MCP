import { promises as fs } from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { defaultConfig, renderDefaultConfigYaml, resolveLimits } from '../../src/config/config-schema';
import { loadWorkspaceConfig, parseConfigText } from '../../src/config/config-loader';
import { workspacePaths } from '../../src/storage/paths';
import { makeTempDir, removeDir } from '../helpers/index';

describe('config schema', () => {
  it('applies documented defaults', () => {
    const config = defaultConfig();
    expect(config.security.permission).toBe('SAFE_WRITE');
    expect(config.security.execute).toBe(true);
    expect(config.security.allow_shell).toBe(false);
    expect(config.security.max_command_seconds).toBe(120);
    expect(config.security.max_files_changed).toBe(20);
    expect(config.security.max_lines_changed).toBe(3000);
    expect(config.security.max_output_bytes).toBe(262144);
    expect(config.workspace.max_files).toBe(20000);
    expect(config.git.protect_user_changes).toBe(true);
    expect(config.benchmark.enabled).toBe(false);
  });

  it('maps config onto limits', () => {
    const limits = resolveLimits(parseConfigText('security:\n  max_command_seconds: 30\n').config);
    expect(limits.maxCommandSeconds).toBe(30);
    expect(limits.maxOutputBytes).toBe(262144);
  });

  it('rejects unknown keys instead of ignoring them', () => {
    const result = parseConfigText('security:\n  allow_shell: true\n  max_command_second: 10\n');
    expect(result.error).toMatch(/max_command_second/);
  });

  it('rejects a bad permission level', () => {
    const result = parseConfigText('security:\n  permission: ADMIN\n');
    expect(result.error).toBeDefined();
  });

  it('renders a default file that parses back to the defaults', () => {
    const text = renderDefaultConfigYaml();
    const parsed = parseConfigText(text);
    expect(parsed.error).toBeUndefined();
    expect(parsed.config).toEqual(defaultConfig());
  });
});

describe('config loader', () => {
  let root: string;

  beforeAll(async () => {
    root = await makeTempDir('devpilot-config-');
  });

  afterAll(async () => {
    await removeDir(root);
  });

  it('creates .devpilot/config.yml when missing', async () => {
    const paths = workspacePaths(root);
    const loaded = await loadWorkspaceConfig(paths);
    expect(loaded.created).toBe(true);
    expect(loaded.source).toBe('workspace');
    const text = await fs.readFile(paths.configFile, 'utf8');
    expect(text).toMatch(/^# DevPilot workspace configuration/m);
  });

  it('reads an existing config', async () => {
    const paths = workspacePaths(root);
    await fs.writeFile(paths.configFile, 'security:\n  permission: READ_ONLY\n', 'utf8');
    const loaded = await loadWorkspaceConfig(paths);
    expect(loaded.created).toBe(false);
    expect(loaded.config.security.permission).toBe('READ_ONLY');
  });

  it('fails with CONFIG_INVALID and keeps the file for the user to fix', async () => {
    const paths = workspacePaths(root);
    await fs.writeFile(paths.configFile, 'security:\n  permission: NOPE\n', 'utf8');
    await expect(loadWorkspaceConfig(paths)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    expect(await fs.readFile(paths.configFile, 'utf8')).toContain('NOPE');
  });

  it('falls back to defaults without creating a file when create is false', async () => {
    const other = await makeTempDir('devpilot-config-nocreate-');
    try {
      const paths = workspacePaths(other);
      const loaded = await loadWorkspaceConfig(paths, { create: false });
      expect(loaded.created).toBe(false);
      expect(loaded.source).toBe('default');
      await expect(fs.access(paths.configFile)).rejects.toThrow();
    } finally {
      await removeDir(other);
    }
  });

  it('reports invalid YAML as CONFIG_INVALID', async () => {
    const broken = await makeTempDir('devpilot-config-broken-');
    try {
      const paths = workspacePaths(broken);
      await fs.mkdir(path.dirname(paths.configFile), { recursive: true });
      await fs.writeFile(paths.configFile, 'security: [unclosed\n', 'utf8');
      await expect(loadWorkspaceConfig(paths)).rejects.toMatchObject({ code: 'CONFIG_INVALID' });
    } finally {
      await removeDir(broken);
    }
  });
});
