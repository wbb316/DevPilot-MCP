import { DevPilotError } from '../errors/devpilot-error.js';
import { VERSION } from '../version.js';
import { initCommand } from './commands/init.js';
import { serveCommand } from './commands/serve.js';
import { statusCommand } from './commands/status.js';

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
  status [path]      Show the detected project profile and git snapshot
      --json              machine-readable output
  serve              Start the MCP server on stdio (used by MCP clients)
  version            Print the version
  help               Show this help

Not yet implemented (roadmap phases): scan (2), doctor (9), test (5)
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
    case 'doctor':
    case 'test': {
      const phase = command === 'scan' ? 2 : command === 'test' ? 5 : 9;
      io.stderr(
        `devpilot ${command} is not implemented yet (roadmap Phase ${phase}). Start the server with \`devpilot serve\` and call the MCP tools instead.\n`,
      );
      return 2;
    }
    default:
      io.stderr(`Unknown command: ${command}\n\n${USAGE}`);
      return 2;
  }
}
