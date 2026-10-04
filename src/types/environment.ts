/**
 * Environment report types (docs/DATA-MODEL.md §7). Phase 9.
 *
 * Everything here is *diagnosis*. DevPilot reports what the machine looks like and what looks
 * inconsistent; it never installs, upgrades or reconfigures a toolchain on its own.
 */

export type CheckStatus = 'OK' | 'WARNING' | 'ERROR';

export interface ToolchainCheck {
  name: string;
  status: CheckStatus;
  version?: string;
  path?: string;
  /** What this project/environment expected, when something is known to be expected. */
  expected?: string;
  message?: string;
  fix?: string;
}

export interface OsInfo {
  platform: string;
  release: string;
  arch: string;
  cpus: number;
  memoryGb: number;
  /** Extra facts worth having without a second call (GPU, WSL, container). */
  details?: Record<string, string>;
}

export interface EnvironmentReport {
  generatedAt: string;
  os: OsInfo;
  tools: ToolchainCheck[];
  conflicts: ToolchainCheck[];
  overall: CheckStatus;
  /** Honest caveats: probes that timed out, optional tools that are absent, skipped checks. */
  notes: string[];
}
