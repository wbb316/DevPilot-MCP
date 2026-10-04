import { promises as fs } from 'node:fs';
import YAML from 'yaml';

import type { WorkspacePaths } from '../types/workspace.js';
import { errors } from '../errors/devpilot-error.js';
import { writeTextAtomic } from '../storage/json-store.js';
import type { DevPilotConfig } from './config-schema.js';
import { defaultConfig, parseConfig, renderDefaultConfigYaml } from './config-schema.js';

/**
 * Config precedence (docs/WORKSPACE-LIFECYCLE.md §4):
 *   tool-call argument > <workspace>\.devpilot\config.yml > %DEVPILOT_HOME%\config.json > defaults
 * Phase 1 implements the workspace file and the built-in defaults; the global
 * config.json layer is read when present.
 */

export interface LoadedConfig {
  config: DevPilotConfig;
  /** Path the config came from, or the path that would be used. */
  path: string;
  /** 'workspace' | 'global' | 'default' */
  source: 'workspace' | 'global' | 'default';
  /** true when the workspace config file was written by this call. */
  created: boolean;
}

export interface LoadConfigOptions {
  /** Create `<workspace>\.devpilot\config.yml` when missing (default true). */
  create?: boolean;
  /** Global config file (DevPilot home). Read only when the workspace file is absent. */
  globalConfigPath?: string;
}

export async function loadWorkspaceConfig(
  paths: WorkspacePaths,
  options: LoadConfigOptions = {},
): Promise<LoadedConfig> {
  const create = options.create ?? true;

  let raw: string | undefined;
  try {
    raw = await fs.readFile(paths.configFile, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') {
      throw errors.configInvalid(
        `Cannot read ${paths.configFile}: ${error instanceof Error ? error.message : String(error)}`,
        { path: paths.configFile },
      );
    }
  }

  if (raw === undefined) {
    if (create) {
      const text = renderDefaultConfigYaml();
      await writeTextAtomic(paths.configFile, text);
      return {
        config: parseConfig(YAML.parse(text), paths.configFile),
        path: paths.configFile,
        source: 'workspace',
        created: true,
      };
    }
    const globalConfig = options.globalConfigPath;
    if (globalConfig) {
      try {
        const globalRaw = await fs.readFile(globalConfig, 'utf8');
        return {
          config: parseConfig(YAML.parse(globalRaw), globalConfig),
          path: globalConfig,
          source: 'global',
          created: false,
        };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    return { config: defaultConfig(), path: paths.configFile, source: 'default', created: false };
  }

  let parsed: unknown;
  try {
    parsed = YAML.parse(raw);
  } catch (error) {
    throw errors.configInvalid(
      `Invalid YAML in ${paths.configFile}: ${error instanceof Error ? error.message : String(error)}`,
      { path: paths.configFile },
    );
  }
  return {
    config: parseConfig(parsed, paths.configFile),
    path: paths.configFile,
    source: 'workspace',
    created: false,
  };
}

export interface ParseConfigTextResult {
  config: DevPilotConfig;
  error?: string;
}

/** Used by tests and by the CLI to validate a config file without throwing. */
export function parseConfigText(text: string, source = '<text>'): ParseConfigTextResult {
  try {
    return { config: parseConfig(YAML.parse(text), source) };
  } catch (error) {
    return { config: defaultConfig(), error: error instanceof Error ? error.message : String(error) };
  }
}
