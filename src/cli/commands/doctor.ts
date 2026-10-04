import path from 'node:path';

import type { EnvironmentReport, ToolchainCheck } from '../../types/environment.js';
import { runDoctor } from '../../environment/doctor.js';
import type { CliIo } from '../cli.js';

/**
 * `devpilot doctor [path]` — the CLI twin of the `doctor` MCP tool. Same report, same code path, so a
 * human and an agent never see different answers. Exit codes: 0 = OK/WARNING, 1 = ERROR, 2 = usage.
 */

export interface DoctorCommandOptions {
  target: string;
  verbose?: boolean;
  json?: boolean;
}

function lineFor(check: ToolchainCheck): string {
  const version = check.version === undefined ? '' : ` ${check.version}`;
  const path_ = check.path === undefined ? '' : `  ${check.path}`;
  const message = check.message === undefined ? '' : `  ${check.message}`;
  return `  ${check.status.padEnd(7)} ${check.name.padEnd(10)}${version}${message}${path_}`;
}

export async function doctorCommand(io: CliIo, options: DoctorCommandOptions): Promise<number> {
  const target = path.resolve(io.cwd, options.target);
  const report = await runDoctor({ cwd: target, verbose: options.verbose === true });

  if (options.json === true) {
    io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    return report.overall === 'ERROR' ? 1 : 0;
  }

  io.stdout(renderReport(report));
  return report.overall === 'ERROR' ? 1 : 0;
}

export function renderReport(report: EnvironmentReport): string {
  const lines: string[] = [];
  lines.push(
    `Environment ${report.overall} — ${report.os.platform} ${report.os.release} ${report.os.arch}, ` +
      `${report.os.cpus} cpu, ${report.os.memoryGb} GB RAM`,
  );
  for (const [key, value] of Object.entries(report.os.details ?? {})) {
    lines.push(`  ${key}: ${value}`);
  }
  lines.push('', 'Toolchains:');
  for (const tool of report.tools) lines.push(lineFor(tool));
  if (report.conflicts.length > 0) {
    lines.push('', 'Conflicts:');
    for (const conflict of report.conflicts) lines.push(lineFor(conflict));
  }
  if (report.notes.length > 0) {
    lines.push('', 'Notes:');
    for (const note of report.notes) lines.push(`  - ${note}`);
  }
  lines.push('', `Overall: ${report.overall}`, '');
  return lines.join('\n');
}
