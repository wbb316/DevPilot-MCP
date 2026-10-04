/**
 * End-to-end smoke test against the *built* server, over a real MCP stdio session.
 *
 *   npm run smoke -- [workspace]
 *
 * Opens the target workspace (default: this repository), scans it, indexes it and exercises
 * the code-intelligence tools, printing the evidence a phase gate needs. Kept dependency-free
 * on purpose (only the MCP SDK client, which is already a runtime dependency).
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.resolve(process.argv[2] ?? root);

function line(title) {
  console.log(`\n=== ${title} ===`);
}

function envelope(result) {
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent;
  }
  const text = (result.content ?? []).find((item) => item.type === 'text')?.text ?? '{}';
  return JSON.parse(text);
}

async function call(client, name, args) {
  const started = Date.now();
  const result = await client.callTool({ name, arguments: args });
  const elapsed = Date.now() - started;
  const body = envelope(result);
  const status = body.success === false ? `ERROR ${body.error?.code}` : 'ok';
  console.log(`- ${name}(${JSON.stringify(args)}) -> ${status} in ${elapsed}ms`);
  if (body.success === false) console.log(`    ${body.error?.message}`);
  return { body, elapsed };
}

const home = await fs.mkdtemp(path.join(os.tmpdir(), 'devpilot-smoke-home-'));
const client = new Client({ name: 'devpilot-smoke', version: '0.1.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, 'dist', 'index.js'), 'serve'],
  env: { ...process.env, DEVPILOT_HOME: home },
  stderr: 'inherit',
});

try {
  await client.connect(transport);
  line('handshake');
  const server = client.getServerVersion();
  console.log(`server: ${server?.name} ${server?.version}`);
  const tools = await client.listTools();
  console.log(`tools (${tools.tools.length}): ${tools.tools.map((tool) => tool.name).join(', ')}`);

  line(`workspace: ${target}`);
  const opened = await call(client, 'open_workspace', { path: target });
  console.log(`    ${opened.body.summary}`);

  const scanned = await call(client, 'scan_project', {});
  const profile = scanned.body.data?.profile ?? {};
  const stats = scanned.body.data?.stats ?? {};
  console.log(
    `    ${profile.projectType} / ${(profile.languages ?? []).join('+')} · ${stats.files} files · ${stats.bytes} bytes · ${stats.fromCache ? 'cache hit' : 'cold'}`,
  );

  line('code intelligence');
  const found = await call(client, 'find_symbol', { name: 'SymbolIndex' });
  const symbolData = found.body.data ?? {};
  console.log(
    `    engine=${symbolData.engine} extractor=${symbolData.extractor} confidence=${symbolData.confidence} store=${symbolData.index?.store} files=${symbolData.index?.files} symbols=${symbolData.index?.symbols} refs=${symbolData.index?.refs}`,
  );
  for (const hit of (symbolData.definitions ?? []).slice(0, 3)) {
    console.log(`    ${hit.kind} ${hit.name} @ ${hit.path}:${hit.startLine}-${hit.endLine}`);
  }

  const refs = await call(client, 'find_references', { name: 'DevPilotError', limit: 5 });
  const refData = refs.body.data ?? {};
  console.log(`    total=${refData.total} in ${refData.grouped?.length ?? 0} file(s)`);
  for (const hit of (refData.references ?? []).slice(0, 3)) {
    console.log(`    ${hit.kind} ${hit.path}:${hit.line}  ${hit.snippet.slice(0, 70)}`);
  }

  // Warm vs cold: a second identical call must not re-parse anything.
  const again = await call(client, 'find_symbol', { name: 'SymbolIndex' });
  console.log(`    incremental: parsed=${again.body.data?.index?.parsed} reused=${again.body.data?.index?.reused}`);

  line('result');
  const ok =
    opened.body.success !== false &&
    scanned.body.success !== false &&
    found.body.success !== false &&
    refs.body.success !== false;
  console.log(ok ? 'SMOKE PASS' : 'SMOKE FAIL');
  process.exitCode = ok ? 0 : 1;
} finally {
  await client.close().catch(() => {});
  await fs.rm(home, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
