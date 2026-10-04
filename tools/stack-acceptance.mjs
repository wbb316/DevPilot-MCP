#!/usr/bin/env node
/**
 * Per-stack V1 acceptance (Maven / Node) — the language paths that the Python
 * acceptance on D:/Projects/devpilot-demo does not cover.
 *
 * Each stack runs a real defect through the whole loop:
 *   copy fixture -> git init -> open -> scan -> add a failing test -> checkpoint
 *   -> build -> run_tests (must fail) -> diagnose_failure -> fix the source
 *   -> run_tests (must pass) -> review_diff -> rollback -> run_tests (must fail again)
 *
 * Usage:
 *   node tools/stack-acceptance.mjs --stack=maven --out=docs/evidence/maven.json
 *   node tools/stack-acceptance.mjs --stack=node  --out=docs/evidence/node.json
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const stack = (argv.find((a) => a.startsWith('--stack=')) ?? '').slice('--stack='.length);
const outFile = (argv.find((a) => a.startsWith('--out=')) ?? '').slice('--out='.length);
const keep = argv.includes('--keep');

const checks = [];
function check(id, description, pass, detail) {
  checks.push({ id, description, pass: pass === true, detail });
  console.log(`${pass === true ? 'PASS' : 'FAIL'}  [${id}] ${description}`);
  if (pass !== true && detail !== undefined) console.log(`      detail: ${JSON.stringify(detail)}`);
}
const flat = (value) => JSON.stringify(value ?? null);

/** Per-stack injection (a test that fails for a real reason) and the real fix. */
const STACKS = {
  maven: {
    fixture: 'maven-project',
    expect: { language: 'Java', buildSystem: 'maven', testFramework: 'junit' },
    buildTarget: 'test-compile',
    inject: {
      file: path.join('src', 'test', 'java', 'com', 'example', 'TitleLengthTest.java'),
      content: `package com.example;

import static org.junit.jupiter.api.Assertions.assertThrows;

import org.junit.jupiter.api.Test;

class TitleLengthTest {

    private final UserService service = new UserService();

    @Test
    void lengthOfTitleRejectsNullInput() {
        assertThrows(IllegalArgumentException.class, () -> service.lengthOfTitle(null));
    }
}
`,
    },
    brokenFile: path.join('src', 'main', 'java', 'com', 'example', 'UserService.java'),
    fix: {
      from: `        // BUG: no null check on user, and no null check on getTitle().
        return user.getTitle().length();`,
      to: `        if (user == null || user.getTitle() == null) {
            throw new IllegalArgumentException("user and title must not be null");
        }
        return user.getTitle().length();`,
    },
    expectedCategory: 'NULL_POINTER',
  },
  node: {
    fixture: 'node-project',
    expect: { language: 'JavaScript', buildSystem: 'npm', testFramework: 'node' },
    buildTarget: 'compile',
    inject: {
      file: path.join('test', 'acceptance-injected.test.js'),
      content: `import assert from "node:assert/strict";
import test from "node:test";

import { divide } from "../src/index.js";

test("divide rejects a zero divisor with a RangeError", () => {
  assert.throws(() => divide(1, 0), RangeError);
});
`,
    },
    brokenFile: path.join('src', 'index.js'),
    fix: {
      from: '    throw new Error("division by zero");',
      to: '    throw new RangeError("division by zero");',
    },
    expectedCategory: 'ASSERTION_FAILED',
  },
};

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function prepareWorkspace(config) {
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  const workspace = path.join(os.tmpdir(), `devpilot-accept-${stack}-${stamp}`);
  fs.rmSync(workspace, { recursive: true, force: true });
  fs.cpSync(path.join(repoRoot, 'fixtures', config.fixture), workspace, { recursive: true });
  git(workspace, ['init', '-b', 'main']);
  git(workspace, ['-c', 'user.email=accept@devpilot', '-c', 'user.name=acceptance', 'add', '-A']);
  git(workspace, ['-c', 'user.email=accept@devpilot', '-c', 'user.name=acceptance', 'commit', '-m', `fixture ${stack}`]);
  return workspace;
}

function applyEdit(workspace, relativePath, from, to) {
  const file = path.join(workspace, relativePath);
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(from)) throw new Error(`fix anchor not found in ${relativePath}`);
  fs.writeFileSync(file, text.replace(from, to), 'utf8');
}

const transport = new StdioClientTransport({ command: 'node', args: ['dist/index.js', 'serve'], cwd: repoRoot, stderr: 'pipe' });
const client = new Client({ name: `devpilot-acceptance-${stack}`, version: '1.0.0' });
let serverStderr = '';
transport.stderr?.on('data', (chunk) => { serverStderr = (serverStderr + chunk.toString()).slice(-4000); });

async function call(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (Array.isArray(result.content) ? result.content : [])
    .filter((block) => block?.type === 'text').map((block) => block.text).join('\n');
  let envelope = result.structuredContent;
  if (envelope === undefined) { try { envelope = JSON.parse(text); } catch { envelope = { raw: text.slice(0, 400) }; } }
  return {
    isError: result.isError === true,
    envelope,
    data: envelope?.data,
    error: envelope?.error,
    summary: envelope?.summary,
    artifacts: envelope?.artifacts,
    ok: envelope?.success === true,
    /** Present when the call was rejected before reaching the handler (protocol error). */
    protocol: result.isError === true && envelope?.data === undefined && envelope?.error === undefined ? text.slice(0, 400) : undefined,
  };
}

async function run() {
  const config = STACKS[stack];
  if (config === undefined) throw new Error(`unknown --stack "${stack}" (expected maven, node)`);
  const workspace = prepareWorkspace(config);
  console.log(`workspace: ${workspace}`);

  const open = await call('open_workspace', { path: workspace });
  const profile = open.data?.workspace?.profile ?? open.data?.profile ?? {};
  check('open', `open_workspace accepts the ${stack} fixture and detects the stack`,
    open.ok && flat(profile.languages).includes(config.expect.language) && profile.buildSystem === config.expect.buildSystem,
    open.error ?? { languages: profile.languages, projectType: profile.projectType, buildSystem: profile.buildSystem, testFramework: profile.testFramework });

  const scan = await call('scan_project', {});
  const scanned = scan.data?.profile ?? {};
  check('scan', 'scan_project reports build/test candidates for the stack',
    scan.ok && typeof scanned.candidates?.test === 'string' && typeof scanned.candidates?.build === 'string',
    scan.error ?? { build: scanned.candidates?.build, test: scanned.candidates?.test, packageManager: scanned.packageManager, testFramework: scanned.testFramework });

  const symbol = await call('find_symbol', { name: stack === 'maven' ? 'UserService' : 'divide' });
  check('symbol', 'find_symbol resolves a definition in the {language} source'.replace('{language}', config.expect.language),
    symbol.ok && flat(symbol.data).includes(config.brokenFile.split(path.sep).pop()),
    symbol.error ?? { summary: symbol.summary, total: symbol.data?.total });

  // A real failing test, then the checkpoint that must be able to undo the real fix.
  const injected = path.join(workspace, config.inject.file);
  fs.mkdirSync(path.dirname(injected), { recursive: true });
  fs.writeFileSync(injected, config.inject.content, 'utf8');

  const checkpoint = await call('create_checkpoint', { label: `pre-fix-${stack}`, kind: 'pre_write' });
  const checkpointId = checkpoint.data?.checkpoint?.id ?? checkpoint.data?.id;
  check('checkpoint', 'create_checkpoint records the pre-fix state', checkpoint.ok && typeof checkpointId === 'string',
    checkpoint.error ?? { checkpointId, note: checkpoint.data?.note });

  const build = await call('build_project', { target: config.buildTarget });
  check('build', `build_project (${config.buildTarget}) succeeds on a real ${stack} toolchain`,
    build.ok && build.data?.status === 'success',
    build.error ?? { protocol: build.protocol, status: build.data?.status, system: build.data?.system, command: build.data?.command, durationMs: build.data?.durationMs, errors: (build.data?.errors ?? []).slice(0, 2) });

  // A failing run is an error envelope: the structured result lives in error.details.
  const failing = await call('run_tests', {});
  const fd = failing.data ?? failing.error?.details ?? {};
  check('tests-fail', 'run_tests parses the real runner output and reports the failure',
    failing.ok === false && fd.status === 'failed' && (fd.failed ?? 0) >= 1,
    { errorCode: failing.error?.code, status: fd.status, framework: fd.framework, parser: fd.parser, parsed: fd.parsed, total: fd.total, passed: fd.passed, failed: fd.failed, failures: (fd.failures ?? []).slice(0, 2) });

  const diag = await call('diagnose_failure', {});
  const dd = diag.data ?? {};
  check('diagnose', `diagnose_failure classifies the ${stack} failure and locates it`,
    diag.ok && typeof dd.category === 'string' && dd.category !== '' && typeof dd.location?.path === 'string',
    diag.error ?? { category: dd.category, confidence: dd.confidence, location: dd.location, evidence: (dd.evidence ?? []).slice(0, 2), hint: dd.hint });

  // The location has to be a file the agent can actually open: not a JUnit/JDK class and not a
  // mangled path from a percent-encoded URL.
  const located = String(dd.location?.path ?? '');
  const locatedFile = located === '' ? '' : path.join(workspace, located);
  check('diagnose-locate', 'the located file is a real workspace file, not framework internals',
    locatedFile !== '' && fs.existsSync(locatedFile) && !/AssertionFailureBuilder|AssertThrows|node_modules/.test(located),
    { location: dd.location, existsInWorkspace: locatedFile !== '' && fs.existsSync(locatedFile) });

  applyEdit(workspace, config.brokenFile, config.fix.from, config.fix.to);

  // Counts are demanded here on purpose: "passed with total 0" is the failure mode this guards.
  const passing = await call('run_tests', {});
  const pd = passing.data ?? passing.error?.details ?? {};
  check('tests-pass', 'after the real fix, run_tests reports a fully passing suite with real counts',
    passing.ok && pd.status === 'passed' && (pd.failed ?? 1) === 0 && (pd.total ?? 0) >= 2,
    { errorCode: passing.error?.code, status: pd.status, total: pd.total, passed: pd.passed, failed: pd.failed, parsed: pd.parsed, parser: pd.parser, command: pd.command });

  const review = await call('review_diff', { includePatch: true });
  const rd = review.data ?? {};
  check('review', 'review_diff reports the changed source file with a patch artifact',
    review.ok && flat(rd.files).includes(path.basename(config.brokenFile)) && typeof review.artifacts?.patch === 'string',
    review.error ?? { totals: rd.totals, riskLevel: rd.riskLevel, files: (rd.files ?? []).map((f) => `${f.path} ${f.risk}`), patch: review.artifacts?.patch });

  const rollback = await call('rollback_checkpoint', { checkpointId });
  check('rollback', 'rollback_checkpoint restores the pre-fix source',
    rollback.ok && flat(rollback.data?.restored).includes(path.basename(config.brokenFile)),
    rollback.error ?? { restored: rollback.data?.restored, skipped: rollback.data?.skipped, unchanged: rollback.data?.unchanged, protected: rollback.data?.protectedUserChanges });

  const afterRollback = await call('run_tests', {});
  const rd2 = afterRollback.data ?? afterRollback.error?.details ?? {};
  check('rollback-real', 'the restore was real: the suite fails again after rollback',
    afterRollback.ok === false && rd2.status === 'failed',
    { errorCode: afterRollback.error?.code, status: rd2.status, total: rd2.total, failed: rd2.failed, passed: rd2.passed });

  const closed = await call('close_workspace', {});
  check('close', 'close_workspace releases the workspace cleanly', closed.ok, closed.error ?? closed.summary);

  return { workspace, config };
}

let workspacePath;
try {
  await client.connect(transport);
  const result = await run();
  workspacePath = result.workspace;
  await client.close();
} catch (error) {
  check('run', `the ${stack} acceptance completed without a driver error`, false,
    error instanceof Error ? error.message : String(error));
  if (serverStderr.trim() !== '') console.log(`server stderr tail:\n${serverStderr}`);
}

const failed = checks.filter((c) => !c.pass);
const report = { stack, generatedAt: new Date().toISOString(), workspace: workspacePath ?? null, passed: checks.length - failed.length, failed: failed.length, checks };
if (outFile !== '') {
  const destination = path.isAbsolute(outFile) ? outFile : path.join(repoRoot, outFile);
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.writeFileSync(destination, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`report -> ${destination}`);
}
if (workspacePath !== undefined && failed.length === 0 && !keep) fs.rmSync(workspacePath, { recursive: true, force: true });
console.log(`${stack}: ${report.passed} passed, ${report.failed} failed`);
process.exitCode = failed.length === 0 ? 0 : 1;
