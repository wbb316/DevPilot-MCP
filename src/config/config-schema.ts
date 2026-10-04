import { z } from 'zod';

import type { Limits } from '../types/workspace.js';
import { DEFAULT_LIMITS, mergeLimits } from '../security/limits.js';
import { PERMISSION_LEVELS } from '../types/workspace.js';
import { errors } from '../errors/devpilot-error.js';

/**
 * `.devpilot/config.yml` schema — docs/WORKSPACE-LIFECYCLE.md §4.
 * Unknown keys are rejected: a typo must never silently disable a safety limit.
 */

export const DEFAULT_EXCLUDES: readonly string[] = [
  'node_modules',
  '.git',
  'dist',
  'build',
  'target',
  'out',
  '.venv',
  'venv',
  'checkpoints',
  'data',
];

const permissionSchema = z.enum(PERMISSION_LEVELS as unknown as [string, ...string[]]);

export const workspaceConfigSchema = z
  .object({
    workspace: z
      .object({
        exclude: z.array(z.string()).default([...DEFAULT_EXCLUDES]),
        max_files: z.number().int().positive().default(20_000),
        max_file_size_bytes: z.number().int().positive().default(2_097_152),
      })
      .strict()
      .default({}),
    security: z
      .object({
        permission: permissionSchema.default('SAFE_WRITE'),
        /** Limited execute: EXECUTE-gated tools stay reachable, bounded by the rule table. */
        execute: z.boolean().default(true),
        allow_shell: z.boolean().default(false),
        allow_outside_workspace: z.boolean().default(false),
        max_files_changed: z.number().int().positive().default(20),
        max_lines_changed: z.number().int().positive().default(3000),
        max_command_seconds: z.number().int().positive().default(120),
        max_output_bytes: z.number().int().positive().default(262_144),
      })
      .strict()
      .default({}),
    project: z
      .object({
        type: z.string().nullable().default(null),
        run_command: z.string().nullable().default(null),
        build_command: z.string().nullable().default(null),
        test_command: z.string().nullable().default(null),
      })
      .strict()
      .default({}),
    index: z
      .object({
        enabled: z.boolean().default(true),
        languages: z.array(z.string()).default(['python', 'java', 'typescript', 'javascript']),
      })
      .strict()
      .default({}),
    git: z
      .object({
        checkpoint_on_write: z.boolean().default(false),
        protect_user_changes: z.boolean().default(true),
      })
      .strict()
      .default({}),
    benchmark: z
      .object({
        enabled: z.boolean().default(false),
      })
      .strict()
      .default({}),
  })
  .strict();

export type DevPilotConfig = {
  workspace: { exclude: string[]; max_files: number; max_file_size_bytes: number };
  security: {
    permission: string;
    execute: boolean;
    allow_shell: boolean;
    allow_outside_workspace: boolean;
    max_files_changed: number;
    max_lines_changed: number;
    max_command_seconds: number;
    max_output_bytes: number;
  };
  project: {
    type: string | null;
    run_command: string | null;
    build_command: string | null;
    test_command: string | null;
  };
  index: { enabled: boolean; languages: string[] };
  git: { checkpoint_on_write: boolean; protect_user_changes: boolean };
  benchmark: { enabled: boolean };
};

/** Validate an already-parsed YAML object. Throws CONFIG_INVALID with zod paths. */
export function parseConfig(raw: unknown, source: string): DevPilotConfig {
  const result = workspaceConfigSchema.safeParse(raw ?? {});
  if (!result.success) {
    const issues = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
      code: issue.code,
    }));
    throw errors.configInvalid(
      `Invalid DevPilot config in ${source}: ${issues.map((i) => `${i.path || '<root>'}: ${i.message}`).join('; ')}`,
      { source, issues },
    );
  }
  return result.data as DevPilotConfig;
}

/** Built-in defaults, materialised as a config object. */
export function defaultConfig(): DevPilotConfig {
  return parseConfig({}, '<built-in defaults>');
}

/** The file written when a workspace has no config yet. Values are explicit on purpose. */
export function renderDefaultConfigYaml(): string {
  const config = defaultConfig();
  const excludeLines = config.workspace.exclude.map((entry) => `    - ${entry}`).join('\n');
  return [
    '# DevPilot workspace configuration',
    '# Created automatically; docs/WORKSPACE-LIFECYCLE.md §4 documents every field.',
    '',
    'workspace:',
    `  max_files: ${config.workspace.max_files}`,
    `  max_file_size_bytes: ${config.workspace.max_file_size_bytes}`,
    '  exclude:',
    excludeLines,
    '',
    'security:',
    `  permission: ${config.security.permission}          # READ_ONLY | SAFE_WRITE | EXECUTE | FULL`,
    `  execute: ${config.security.execute}                    # limited EXECUTE gated by the command policy`,
    `  allow_shell: ${config.security.allow_shell}                # keep false: commands are never passed through a shell`,
    `  allow_outside_workspace: ${config.security.allow_outside_workspace}`,
    `  max_files_changed: ${config.security.max_files_changed}`,
    `  max_lines_changed: ${config.security.max_lines_changed}`,
    `  max_command_seconds: ${config.security.max_command_seconds}`,
    `  max_output_bytes: ${config.security.max_output_bytes}`,
    '',
    'project:',
    '  type: null                      # override auto-detection (e.g. PyTorch, SpringBoot)',
    '  build_command: null',
    '  test_command: null',
    '  run_command: null',
    '',
    'index:',
    `  enabled: ${config.index.enabled}`,
    '  languages:',
    ...config.index.languages.map((language) => `    - ${language}`),
    '',
    'git:',
    `  checkpoint_on_write: ${config.git.checkpoint_on_write}`,
    `  protect_user_changes: ${config.git.protect_user_changes}      # refuses destructive flows on a dirty tree`,
    '',
    'benchmark:',
    `  enabled: ${config.benchmark.enabled}`,
    '',
  ].join('\n');
}

/** Map config onto the enforced hard limits. */
export function resolveLimits(config: DevPilotConfig, override?: Partial<Limits>): Limits {
  const fromConfig: Partial<Limits> = {
    maxCommandSeconds: config.security.max_command_seconds,
    maxOutputBytes: config.security.max_output_bytes,
    maxFilesChanged: config.security.max_files_changed,
    maxLinesChanged: config.security.max_lines_changed,
    maxFilesIndexed: config.workspace.max_files,
    maxFileSizeBytes: config.workspace.max_file_size_bytes,
    walkMaxDepth: DEFAULT_LIMITS.walkMaxDepth,
  };
  return mergeLimits(mergeLimits(DEFAULT_LIMITS, fromConfig), override ?? {});
}
