#!/usr/bin/env node
/**
 * DevPilot MCP V1 acceptance driver — docs/ROADMAP.md Phase 10, the 13 frozen items.
 *
 * It talks to DevPilot over stdio exactly the way DSH does (`node dist/index.js serve`
 * in the DevPilot checkout), against a real Git workspace, and records one check per
 * acceptance item. Stages split the run where a human/agent edit has to happen in between:
 *
 *   --stage=recon      items 1-6   handshake, open, scan, run command, symbols, impact + checkpoint
 *   --stage=verify     items 7-8   the failing test run and the structured diagnosis
 *   --stage=post       items 9-12  the fixed test run, the auditable diff review
 *   --stage=rollback   item 13     user's own uncommitted work survives; rollback is real
 *
 * Usage:
 *   node tools/v1-acceptance.mjs --stage=recon --out=docs/evidence/recon.json
 *   DEVPILOT_ACCEPTANCE_TARGET=D:/Projects/other node tools/v1-acceptance.mjs --stage=recon
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = process.env.DEVPILOT_ACCEPTANCE_TARGET ?? 'D:/Projects/devpilot-demo';
const argv = process.argv.slice(2);
const stage = (argv.find((a) => a.startsWith('--stage=')) ?? '--stage=recon').slice('--stage='.length);
const outFile = (argv.find((a) => a.startsWith('--out=')) ?? '').slice('--out='.length);
const stateFile = path.join(repoRoot, '.devpilot', 'acceptance-state.json');

const EXPECTED_TOOLS = [
  'build_project', 'close_workspace', 'create_checkpoint', 'dependency_audit', 'diagnose_failure',
  'doctor', 'find_references', 'find_symbol', 'get_git_status', 'get_project_map',
  'get_workspace_status', 'impact_analysis', 'open_workspace', 'review_diff',
  'rollback_checkpoint', 'run_project', 'run_test', 'run_tests', 'scan_project',
];

const checks = [];
const log = (line) => console.log(line);
function check(item, description, pass, detail) {
  checks.push({ item, description, pass: pass === true, detail });
  log(`${pass === true ? 'PASS' : 'FAIL'}  [item ${item}] ${description}`);
  if (detail !== undefined && pass !== true) log(`      detail: ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`);
}
function readState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}
function writeState(patch) {
  const next = { ...readState(), ...patch };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}
const flat = (value) => JSON.stringify(value ?? null);

const transport = new StdioClientTransport({
  command: 'node',
  args: ['dist/index.js', 'serve'],
  cwd: repoRoot,
  stderr: 'pipe',
});
const client = new Client({ name: 'devpilot-v1-acceptance', version: '1.0.0' });
let serverStderr = '';
transport.stderr?.on('data', (chunk) => { serverStderr = (serverStderr + chunk.toString()).slice(-4000); });

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
  let envelope = result.structuredContent;
  if (envelope === undefined) { try { envelope = JSON.parse(text); } catch { envelope = { raw: text.slice(0, 500) }; } }
  return {
    isError: result.isError === true,
    envelope,
    data: envelope?.data,
    // A failed run/test is an error envelope whose structured result lives in error.details.
    details: envelope?.error?.details ?? envelope?.data,
    error: envelope?.error,
    summary: envelope?.summary,
    artifacts: envelope?.artifacts,
    warnings: envelope?.warnings,
    ok: envelope?.success === true,
  };
}

/**
 * Every stage runs in its own server process, so each one must open the workspace first —
 * `open_workspace` is the session-level prerequisite of every other tool (WORKSPACE_NOT_OPEN).
 */
async function openTarget() {
  const opened = await call('open_workspace', { path: target });
  if (!opened.ok) {
    check('pre', `open_workspace(${target}) succeeded`, false, opened.error ?? opened.summary);
    throw new Error('cannot run this stage without an open workspace');
  }
  log(`      (workspace ready: ${opened.data?.workspace?.id ?? 'unknown id'})`);
}

async function stageRecon() {
  const listed = await client.listTools();
  const names = listed.tools.map((tool) => tool.name).sort();
  const missing = EXPECTED_TOOLS.filter((name) => !names.includes(name));
  check(1, `tools/list exposes the V1 tool set over stdio (${names.length} tools)`, missing.length === 0, { missing, names });

  const open = await call('open_workspace', { path: target });
  check(2, `open_workspace opens the real Git project ${target}`, open.ok && flat(open.data).includes(path.basename(target)), open.error ?? Object.keys(open.data ?? {}));

  const scan = await call('scan_project', {});
  const profile = scan.data?.profile;
  const stats = scan.data?.stats;
  check(3, 'scan_project identifies languages, markers and statistics', scan.ok && Array.isArray(profile?.languages) && (stats?.files ?? 0) > 5,
    scan.error ?? { languages: profile?.languages, files: stats?.files, topLevel: scan.data?.topLevel?.length });

  const runCommand = profile?.candidates?.run ?? '';
  check(4, 'the project answers "how do I run this?" from the scan alone', runCommand.length > 0,
    { run: runCommand, test: profile?.candidates?.test, buildSystem: profile?.buildSystem, testFramework: profile?.testFramework });

  const symbol = await call('find_symbol', { name: 'CatalogService' });
  check(5, 'find_symbol locates CatalogService in its defining file', symbol.ok && flat(symbol.data).includes('service.py'), symbol.error ?? symbol.summary);

  const refs = await call('find_references', { name: 'average_price' });
  const refJson = flat(refs.data);
  check(5.1, 'find_references finds call sites across files (definition + tests + cli)',
    refs.ok && refJson.includes('service.py') && refJson.includes('test_service.py') && refJson.includes('cli.py'),
    refs.error ?? { summary: refs.summary, engine: refs.data?.engine, total: refs.data?.total });

  const impact = await call('impact_analysis', { target: 'CatalogService.average_price' });
  check(6, 'impact_analysis reports affected files, tests and a risk level',
    impact.ok && flat(impact.data).includes('service.py') && impact.data?.riskLevel !== undefined,
    impact.error ?? { riskLevel: impact.data?.riskLevel, confidence: impact.data?.confidence, method: impact.data?.method, notes: impact.data?.notes });

  const checkpoint = await call('create_checkpoint', { label: 'pre-fix', kind: 'pre_write' });
  const checkpointId = checkpoint.data?.checkpoint?.id ?? checkpoint.data?.id;
  check(6.1, 'create_checkpoint records a reversible checkpoint before any edit',
    checkpoint.ok && typeof checkpointId === 'string', checkpoint.error ?? { checkpointId, note: checkpoint.data?.note });
  writeState({ target, checkpointId, createdAt: new Date().toISOString() });
}

async function stageVerify() {
  await openTarget();
  const tests = await call('run_tests', {});
  const d = tests.details ?? {};
  check(7, 'run_tests returns structured counts for the failing suite',
    tests.ok === false && d.status === 'failed' && (d.failed ?? 0) >= 1 && (d.total ?? 0) >= 5,
    { status: d.status, total: d.total, passed: d.passed, failed: d.failed, framework: d.framework, command: d.command, failures: d.failures });

  const diag = await call('diagnose_failure', {});
  const dd = diag.data ?? {};
  check(8, 'diagnose_failure turns the raw log into a category, a location and evidence',
    diag.ok && typeof dd.category === 'string' && dd.category !== '' && typeof dd.location?.path === 'string',
    diag.error ?? { category: dd.category, confidence: dd.confidence, location: dd.location, evidence: (dd.evidence ?? []).slice(0, 3), suspectFiles: dd.suspectFiles, hint: dd.hint });
}

async function stagePost() {
  await openTarget();
  const tests = await call('run_tests', {});
  const d = tests.details ?? {};
  check(9, 'after the fix, run_tests reports a fully passing suite',
    tests.ok && d.status === 'passed' && (d.failed ?? 1) === 0 && (d.passed ?? 0) >= 5,
    { status: d.status, total: d.total, passed: d.passed, failed: d.failed });

  const run = await call('run_project', { timeoutSeconds: 60 });
  const runDetails = run.data ?? run.error?.details ?? {};
  const runOutput = [...(runDetails.stdoutTail ?? []), ...(runDetails.stderrTail ?? [])].join('\n');
  check(4.1, 'run_project really starts it (module form + PYTHONPATH from the profile)', run.ok && runOutput.includes('products: 4'),
    run.error ?? { status: runDetails.status, exitCode: runDetails.exitCode, output: runOutput.split('\n').filter(Boolean).slice(-4) });

  const review = await call('review_diff', { includePatch: true });
  const rd = review.data ?? {};
  const fileJson = flat(rd.files);
  check(10, 'review_diff reports which files changed, with line counts',
    review.ok && fileJson.includes('service.py') && (rd.totals?.files ?? 0) >= 1,
    review.error ?? { totals: rd.totals, files: (rd.files ?? []).map((f) => `${f.path} ${f.risk}`) });

  check(11, 'the diff is classified and auditable (risk, reasons, patch artifact)',
    Array.isArray(rd.highRisk) && typeof rd.riskLevel === 'string' && typeof review.artifacts?.patch === 'string',
    { riskLevel: rd.riskLevel, highRisk: rd.highRisk, patch: review.artifacts?.patch });

  check(12, "the user's pre-existing uncommitted change is identified, not mixed in",
    Array.isArray(rd.preExistingChanges) && rd.preExistingChanges.some((p) => String(p).includes('README.md')),
    { preExistingChanges: rd.preExistingChanges, unrelatedFiles: rd.unrelatedFiles });
}

async function stageRollback() {
  await openTarget();
  const state = readState();
  const checkpointId = state.checkpointId;

  const status = await call('get_git_status', {});
  check(13.1, 'get_git_status shows the dirty tree (fix + the user\'s own change)',
    status.ok && status.data?.dirty === true,
    status.error ?? { branch: status.data?.branch, changedFiles: status.data?.changedFiles, preExisting: status.data?.preExisting, checkpoints: status.data?.devpilotCheckpoints });

  const dry = await call('rollback_checkpoint', { checkpointId, dryRun: true });
  check(13.2, 'rollback_checkpoint --dry-run names exactly what it would restore',
    dry.ok && dry.data?.dryRun === true && flat(dry.data?.restored).includes('service.py'),
    dry.error ?? { restored: dry.data?.restored, skipped: dry.data?.skipped, protected: dry.data?.protectedUserChanges });

  const real = await call('rollback_checkpoint', { checkpointId });
  check(13.3, 'rollback restores DevPilot\'s own edits',
    real.ok && flat(real.data?.restored).includes('service.py'),
    real.error ?? { restored: real.data?.restored, skipped: real.data?.skipped, protected: real.data?.protectedUserChanges, notes: real.data?.notes });

  check(13.7, "the user's own pre-existing edit is reported as left alone, never as a restore",
    flat(real.data?.unchanged).includes('README.md'),
    { restored: real.data?.restored, unchanged: real.data?.unchanged, skipped: real.data?.skipped, notes: real.data?.notes });

  const after = await call('run_tests', {});
  const afterData = after.details ?? {};
  check(13.4, 'the restore was real: the suite fails again after rollback',
    after.ok === false && afterData.status === 'failed',
    { status: afterData.status, total: afterData.total, failed: afterData.failed, passed: afterData.passed });

  const readme = path.join(target, 'README.md');
  const readmeText = fs.existsSync(readme) ? fs.readFileSync(readme, 'utf8') : '';
  check(13.5, "the user's uncommitted README note survived every operation",
    readmeText.includes('local note: my own uncommitted work'),
    { readmeBytes: readmeText.length, tail: readmeText.trim().split('\n').slice(-2) });

  const status2 = await call('get_git_status', {});
  check(13.6, 'the git index was never touched by DevPilot (still only README modified)',
    status2.ok && flat(status2.data?.changedFiles).includes('README.md'),
    status2.data?.changedFiles);
}

const STAGES = { recon: stageRecon, verify: stageVerify, post: stagePost, rollback: stageRollback };

try {
  if (STAGES[stage] === undefined) throw new Error(`unknown stage "${stage}" (expected ${Object.keys(STAGES).join(', ')})`);
  await client.connect(transport);
  await STAGES[stage]();
  await client.close();
} catch (error) {
  check('run', `stage ${stage} completed without a driver error`, false, error instanceof Error ? `${error.message}\n${error.stack?.split('\n')[1] ?? ''}` : String(error));
  if (serverStderr.trim() !== '') log(`server stderr:\n${serverStderr}`);
}

const failed = checks.filter((c) => !c.pass);
const report = {
  stage,
  target,
  generatedAt: new Date().toISOString(),
  serverCommand: 'node dist/index.js serve',
  passed: checks.length - failed.length,
  failed: failed.length,
  checks,
};
if (outFile !== '') {
  const destination = path.isAbsolute(outFile) ? outFile : path.join(repoRoot, outFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  log(`report -> ${destination}`);
}
log(`${stage}: ${report.passed} passed, ${report.failed} failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
