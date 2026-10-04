#!/usr/bin/env node
import { runCli } from './cli/cli.js';

/**
 * bin entry — `devpilot <command>`. Nothing but the JSON-RPC transport may write to
 * stdout while `serve` is running, so the CLI writes human output through `io.stdout`
 * only for non-serve commands.
 */
const code = await runCli(process.argv.slice(2), {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
  cwd: process.cwd(),
  env: process.env,
});

if (code !== 0) process.exitCode = code;
