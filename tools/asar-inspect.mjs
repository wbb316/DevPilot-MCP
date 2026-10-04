/**
 * Minimal, dependency-free Electron asar reader.
 *
 * DevPilot's Phase 10 job is to wire itself into DeepSeek Harness as an MCP server. The DSH
 * implementation ships inside `app.asar` (a single ~121 MB archive), and the contract we must match
 * — how a server is declared, which transport fields exist — lives in that archive's own source.
 * Rather than unpacking the whole thing, this tool reads the archive's directory and pulls out
 * exactly the files needed, so the mapping can be re-verified any time.
 *
 * Layout of an asar file:
 *   [0..4)   UInt32LE  size of the pickle header (8 + padded JSON size)
 *   [4..8)   UInt32LE  size of the JSON directory
 *   [8..)    UTF-8 JSON directory
 *   [data)   file contents; each entry's `offset` is relative to the data start
 *
 * Usage (from the DevPilot-MCP root):
 *   node tools/asar-inspect.mjs list  <asar> <regex> [--limit=N]
 *   node tools/asar-inspect.mjs grep  <asar> <regex> [--ext=js,mjs,cjs] [--limit=N] [--context=N]
 *   node tools/asar-inspect.mjs read  <asar> <inner-path> [--head=N]
 */

import { readFileSync } from 'node:fs';

function loadAsar(archivePath) {
  const buffer = readFileSync(archivePath);
  // Chromium pickle: [u32 payload size][payload]. Here the payload holds the header pickle, which
  // holds [u32 length][json]; the data section begins right after the JSON, padded to 4 bytes.
  // The JSON start is located rather than assumed, because the number of nested size fields varies
  // between packers — assuming it silently returns content from the wrong file.
  const scanLimit = Math.min(buffer.length, 64 * 1024 * 1024);
  const jsonStart = buffer.subarray(0, scanLimit).indexOf(Buffer.from('{"files"'));
  if (jsonStart < 8) throw new Error('not an asar archive: no {"files"} directory header found');

  const jsonSize = buffer.readUInt32LE(jsonStart - 4);
  const directory = JSON.parse(buffer.subarray(jsonStart, jsonStart + jsonSize).toString('utf8'));
  if (directory.files === undefined) throw new Error('asar directory header has no files map');

  return { buffer, directory, dataStart: jsonStart + jsonSize, probe: jsonStart };
}

function* entries(node, prefix = '') {
  for (const [name, value] of Object.entries(node.files ?? {})) {
    const inner = prefix === '' ? name : `${prefix}/${name}`;
    if (value.files !== undefined) {
      yield* entries(value, inner);
      continue;
    }
    yield { path: inner, size: value.size ?? 0, offset: value.offset, unpacked: value.unpacked === true };
  }
}

function readEntry(archive, entry) {
  if (entry.unpacked || entry.offset === undefined) return undefined;
  const start = archive.dataStart + Number(entry.offset);
  return archive.buffer.subarray(start, start + entry.size);
}

function arg(name, fallback) {
  const prefix = `--${name}=`;
  const found = process.argv.find((value) => value.startsWith(prefix));
  return found === undefined ? fallback : found.slice(prefix.length);
}

const [command, archivePath, pattern] = process.argv.slice(2);
if (command === undefined || archivePath === undefined) {
  console.error('usage: asar-inspect.mjs <list|grep|read> <archive> <pattern|inner-path> [--limit=N]');
  process.exit(2);
}

const archive = loadAsar(archivePath);
const limit = Number(arg('limit', '40'));
const extensions = arg('ext', 'js,mjs,cjs,ts,json').split(',').map((value) => value.trim());
const lines = [];

if (command === 'list') {
  const regex = new RegExp(pattern, 'i');
  for (const entry of entries(archive.directory)) {
    if (!regex.test(entry.path)) continue;
    lines.push(`${entry.size}\t${entry.path}${entry.unpacked ? '\t(unpacked)' : ''}`);
    if (lines.length >= limit) break;
  }
} else if (command === 'grep') {
  const regex = new RegExp(pattern, 'i');
  const pathFilter = arg('path', '');
  const pathRegex = pathFilter === '' ? undefined : new RegExp(pathFilter, 'i');
  for (const entry of entries(archive.directory)) {
    if (lines.length >= limit) break;
    if (pathRegex !== undefined && !pathRegex.test(entry.path)) continue;
    const extension = entry.path.split('.').pop() ?? '';
    if (!extensions.includes(extension)) continue;
    const content = readEntry(archive, entry);
    if (content === undefined) continue;
    const text = content.toString('utf8');
    if (!regex.test(text)) continue;
    const all = text.split('\n');
    for (let index = 0; index < all.length; index += 1) {
      if (!regex.test(all[index])) continue;
      lines.push(`${entry.path}:${index + 1}: ${all[index].trim().slice(0, 240)}`);
      if (lines.length >= limit) break;
    }
  }
} else if (command === 'debug') {
  lines.push(`bytes 0..24: ${archive.buffer.subarray(0, 24).toString('hex')}`);
  lines.push(`u32@0=${archive.buffer.readUInt32LE(0)} u32@4=${archive.buffer.readUInt32LE(4)}`);
  lines.push(`directory-json found at index ${archive.probe}`);
  lines.push(`dataStart=${archive.dataStart}`);
  lines.push(`top-level entries: ${Object.keys(archive.directory.files ?? {}).join(', ')}`);
} else if (command === 'read') {
  const wanted = entries(archive.directory).find((entry) => entry.path === pattern);
  if (wanted === undefined) {
    console.error(`not found in archive: ${pattern}`);
    process.exit(1);
  }
  const content = readEntry(archive, wanted);
  const text = (content ?? Buffer.from('')).toString('utf8');
  const head = Number(arg('head', '0'));
  const body = head > 0 ? text.split('\n').slice(0, head).join('\n') : text;
  lines.push(body);
} else {
  console.error(`unknown command: ${command}`);
  process.exit(2);
}

console.log(lines.join('\n'));
