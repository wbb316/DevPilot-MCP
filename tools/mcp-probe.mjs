#!/usr/bin/env node
/**
 * Probe an MCP server over stdio the way DSH does: spawn it exactly as configured,
 * complete the initialize + tools/list handshake, optionally call one tool, then
 * close and require a clean exit.
 *
 * Phase 10 uses this to prove the wiring contract before (and independently of)
 * restarting DSH, and to run the V1 acceptance script against a real workspace.
 *
 * Usage:
 *   node tools/mcp-probe.mjs                       # probe DevPilot itself, list tools
 *   node tools/mcp-probe.mjs --tool=scan_project --args={"path":"D:/Projects/devpilot-demo"}
 *   node tools/mcp-probe.mjs --tool=scan_project --args-file=args.json   (Windows-safe)
 *   node tools/mcp-probe.mjs --steps-file=steps.json   # [{ "tool": ..., "args": {...} }, ...]
 *   node tools/mcp-probe.mjs --cmd=node --arg=dist/index.js --arg=serve
 *
 * `--steps-file` exists because one server process holds one workspace: proving anything that
 * needs open_workspace *followed by* another call requires several calls in one session.
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function parseArgs(argv) {
  const options = { command: 'node', args: [], cwd: repoRoot, tool: undefined, toolArgs: undefined, steps: undefined, json: false };
  const positional = [];
  for (const raw of argv) {
    if (raw === '--') continue;
    if (raw.startsWith('--cmd=')) options.command = raw.slice(6);
    else if (raw.startsWith('--arg=')) options.args.push(raw.slice(6));
    else if (raw.startsWith('--cwd=')) options.cwd = raw.slice(6);
    else if (raw.startsWith('--tool=')) options.tool = raw.slice(7);
    else if (raw.startsWith('--args=')) options.toolArgs = JSON.parse(raw.slice(7));
    else if (raw.startsWith('--args-file=')) options.toolArgs = JSON.parse(fs.readFileSync(raw.slice(12), 'utf8'));
    else if (raw.startsWith('--steps-file=')) options.steps = JSON.parse(fs.readFileSync(raw.slice(13), 'utf8'));
    else if (raw === '--json') options.json = true;
    else positional.push(raw);
  }
  if (options.args.length === 0) options.args = ['dist/index.js', 'serve'];
  if (options.tool !== undefined && options.toolArgs === undefined) options.toolArgs = {};
  return options;
}

function textOf(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  return blocks
    .filter((block) => block?.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function envelopeOf(result) {
  if (result?.structuredContent && typeof result.structuredContent === 'object') return result.structuredContent;
  const text = textOf(result);
  try {
    return JSON.parse(text);
  } catch {
    return { success: undefined, raw: text.slice(0, 400) };
  }
}

const options = parseArgs(process.argv.slice(2));
const transport = new StdioClientTransport({
  command: options.command,
  args: options.args,
  cwd: options.cwd,
  stderr: 'pipe',
});
const client = new Client({ name: 'devpilot-probe', version: '0.1.0' });

const started = Date.now();
let serverStderr = '';
transport.stderr?.on('data', (chunk) => {
  serverStderr += chunk.toString();
});

try {
  await client.connect(transport);
  const handshakeMs = Date.now() - started;
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();

  const report = {
    ok: true,
    command: [options.command, ...options.args].join(' '),
    cwd: options.cwd,
    handshakeMs,
    toolCount: names.length,
    tools: names,
  };

  const steps = options.steps ?? (options.tool === undefined ? [] : [{ tool: options.tool, args: options.toolArgs }]);
  report.calls = [];
  for (const step of steps) {
    const callStarted = Date.now();
    const result = await client.callTool({ name: step.tool, arguments: step.args ?? {} });
    const envelope = envelopeOf(result);
    const entry = {
      tool: step.tool,
      isError: result.isError === true,
      durationMs: Date.now() - callStarted,
      success: envelope?.success,
      summary: envelope?.summary,
      error: envelope?.error,
      warnings: Array.isArray(envelope?.warnings) ? envelope.warnings : [],
      dataKeys: envelope?.data && typeof envelope.data === 'object' ? Object.keys(envelope.data) : [],
    };
    if (options.json) entry.envelope = envelope;
    report.calls.push(entry);
  }
  if (report.calls.length === 1) report.call = report.calls[0];

  await client.close();
  report.closed = true;
  report.totalMs = Date.now() - started;
  if (options.json) console.log(JSON.stringify(report, null, 2));
  else {
    console.log(`command      ${report.command}`);
    console.log(`cwd          ${report.cwd}`);
    console.log(`handshake    ${report.handshakeMs} ms`);
    console.log(`tools        ${report.toolCount}`);
    for (const call of report.calls ?? (report.call ? [report.call] : [])) {
      console.log(`call         ${call.tool} -> ${call.summary ?? call.error?.code ?? 'no summary'}`);
      console.log(`call isError ${call.isError}`);
      for (const warning of call.warnings ?? []) console.log(`  warning    ${warning}`);
    }
    console.log(`exit         clean`);
  }
} catch (error) {
  console.log(JSON.stringify({ ok: false, message: error instanceof Error ? error.message : String(error) }, null, 2));
  if (serverStderr.trim() !== '') console.log(`server stderr:\n${serverStderr.slice(-2000)}`);
  process.exitCode = 1;
}
