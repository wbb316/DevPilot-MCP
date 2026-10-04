import { DevPilotError } from '../errors/devpilot-error.js';
import { VERSION } from '../version.js';
import { initCommand } from './commands/init.js';
import { scanCommand } from './commands/scan.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';
import { testCommand } from './commands/test.js';
import { diagnoseCommand } from './commands/diagnose.js';
import { doctorCommand } from './commands/doctor.js';

/**
 * Human-facing CLI (docs/ARCHITECTURE.md §3). The MCP server is the product; this keeps
 * an operator able to init a workspace, inspect it and start the server by hand.
 */
export interface CliIo {
  stdout(text: string): void;
  stderr(text: string): void;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export const USAGE = `DevPilot MCP — a local software engineering runtime for AI coding agents.

Usage: devpilot <command> [options]

Commands:
  init [path]        Create <path>/.devpilot/ (config.yml, cache, logs, checkpoints)
      --write-gitignore   also add ".devpilot/" to .gitignore
  scan [path]        Scan the project into .devpilot/cache/project.json
      --force             ignore the cache and rescan the whole tree
      --json              machine-readable output
  status [path]      Show the detected project profile and git snapshot
      --json              machine-readable output
  test [path]        Run the detected test framework and print the parsed result
      --filter=<expr>     framework-level filter (pytest -k, mvn -Dtest, gradle --tests)
      --file=<path>       run a single test file
      --fail-fast         stop at the first failure
      --json              machine-readable output
  diagnose [path]    Classify the last failed job: category, location, evidence, suspects
      --job=<id>          diagnose a specific job from .devpilot/logs/jobs.jsonl
      --log=<path>        diagnose a workspace-relative log file instead
      --max-evidence=<n>  how many key lines to print (default 8)
      --json              machine-readable output
  serve              Start the MCP server on stdio (used by MCP clients)
  doctor [path]      Diagnose the local toolchain (git, node, python, java, maven, CUDA, ...)
      --verbose           include the probe inventory
      --json              machine-readable output
  version            Print the version
  help               Show this help
`;

interface ParsedArgv {
  command?: string;
  positionals: string[];
  flags: Map<string, string | boolean>;
}

export function parseArgv(argv: readonly string[]): ParsedArgv {
  const positionals: string[] = [];
  const flags = new Map<string, string | boolean>();
  let command: string | undefined;

  for (const token of argv) {
    if (token.startsWith('--')) {
      const body = token.slice(2);
      const eq = body.indexOf('=');
      if (eq >= 0) flags.set(body.slice(0, eq), body.slice(eq + 1));
      else flags.set(body, true);
      continue;
    }
    if (token.startsWith('-') && token.length > 1) {
      flags.set(token.replace(/^-+/, ''), true);
      continue;
    }
    if (command === undefined) command = token;
    else positionals.push(token);
  }
  return { command, positionals, flags };
}

export async function runCli(argv: readonly string[], io: CliIo): Promise<number> {
  try {
    return await dispatch(argv, io);
  } catch (error) {
    // A CLI failure is a typed, printable message — never a raw stack trace.
    const failure = DevPilotError.from(error);
    io.stderr(`devpilot ${failure.code}: ${failure.message}\n`);
    if (failure.hint !== undefined) io.stderr(`  hint: ${failure.hint}\n`);
    return 2;
  }
}

async function dispatch(argv: readonly string[], io: CliIo): Promise<number> {
  const parsed = parseArgv(argv);
  const command = parsed.command;

  if (command === undefined || command === 'help' || parsed.flags.has('help') || parsed.flags.has('h')) {
    io.stdout(USAGE);
    return 0;
  }

  if (command === 'version' || parsed.flags.has('version')) {
    io.stdout(`${VERSION}\n`);
    return 0;
  }

  const json = parsed.flags.has('json');

  switch (command) {
    case 'serve':
      return serveCommand(io);
    case 'init':
      return initCommand(io, {
        target: parsed.positionals[0] ?? io.cwd,
        writeGitignore: parsed.flags.has('write-gitignore'),
        json,
      });
    case 'status':
      return statusCommand(io, { target: parsed.positionals[0] ?? io.cwd, json });
    case 'scan':
      return scanCommand(io, {
        target: parsed.positionals[0] ?? io.cwd,
        force: parsed.flags.has('force'),
        json,
      });
    case 'test':
      return testCommand(io, {
        target: parsed.positionals[0] ?? io.cwd,
        ...(typeof parsed.flags.get('filter') === 'string'
          ? { filter: parsed.flags.get('filter') as string }
          : {}),
        ...(typeof parsed.flags.get('file') === 'string' ? { file: parsed.flags.get('file') as string } : {}),
        failFast: parsed.flags.has('fail-fast'),
        json,
      });
    case 'diagnose': {
      const maxEvidence = parsed.flags.get('max-evidence');
      const parsedMax =
        typeof maxEvidence === 'string' && Number.isFinite(Number.parseInt(maxEvidence, 10))
          ? Number.parseInt(maxEvidence, 10)
          : undefined;
      return diagnoseCommand(io, {
        target: parsed.positionals[0] ?? io.cwd,
        ...(typeof parsed.flags.get('job') === 'string'
          ? { jobId: parsed.flags.get('job') as string }
          : {}),
        ...(typeof parsed.flags.get('log') === 'string'
          ? { logFile: parsed.flags.get('log') as string }
          : {}),
        ...(parsedMax === undefined ? {} : { maxEvidence: parsedMax }),
        json,
      });
    }
    case 'doctor':
      return doctorCommand(io, {
        target: parsed.positionals[0] ?? io.cwd,
        verbose: parsed.flags.has('verbose'),
        json,
      });
    default:
      io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}
