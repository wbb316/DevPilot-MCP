import { existsSync, promises as fs } from 'node:fs';
import path from 'node:path';

import { errors } from '../errors/devpilot-error.js';
import { isInside, isSensitiveFile, toPosix } from '../security/path-policy.js';
import { GitManager } from '../git/git-manager.js';
import { JobStore } from '../runner/job-store.js';
import { acquireSymbolIndex, cachedSymbolIndex } from '../code/index-registry.js';
import type { SymbolIndex } from '../code/symbol-index.js';
import type { DevPilotConfig } from '../config/config-schema.js';
import type { Logger } from '../log/logger.js';
import type { WorkspacePaths } from '../types/workspace.js';
import type { DiagnosisLocation, DiagnosisResult } from '../types/diagnosis.js';
import type { JobRecord } from '../types/execution.js';
import { DEFAULT_MAX_EVIDENCE, analyzeFailure, buildDiagnosis } from './diagnose.js';
import type { AnalyzeOptions } from './diagnose.js';
import type { LocationScanOptions } from './location.js';

/**
 * The diagnosis use case, shared by the `diagnose_failure` MCP tool and `devpilot diagnose`.
 * The tool is a thin adapter: everything that decides *what* to read and *how* to classify
 * lives here so both entry points can never drift apart (docs/ARCHITECTURE.md §7).
 */

/** Only the tail of a log is analysed; failure summaries live at the end of the output. */
export const MAX_LOG_BYTES = 2 * 1024 * 1024;
export const MAX_CHANGED_FILES = 20;

export interface DiagnoseJobRequest {
  root: string;
  paths: WorkspacePaths;
  /** Used to reuse an in-memory symbol index for `import_related` suspects, when one exists. */
  workspaceId?: string;
  /** Needed to build the index on demand when bare JVM file names have to be resolved. */
  config?: DevPilotConfig;
  logger?: Logger;
  jobId?: string;
  command?: string;
  logFile?: string;
  maxEvidence?: number;
}

export async function diagnoseJob(request: DiagnoseJobRequest): Promise<DiagnosisResult> {
  const { root } = request;
  const store = new JobStore(request.paths);
  const recent = await store.recent({ limit: 200 });

  const job = await selectJob(recent, request);
  if (job === undefined && request.logFile === undefined) {
    throw errors.fileNotFound(
      request.jobId !== undefined
        ? `no job with id ${request.jobId} in this workspace ledger`
        : request.command === undefined
          ? 'no failed job found in this workspace ledger'
          : `no job whose command contains "${request.command}"`,
      undefined,
      'Run build_project / run_project / run_tests first so the transcript is recorded, or pass logFile with a workspace-relative path.',
    );
  }

  const logTarget = await resolveLogTarget(root, job, request.logFile);
  const transcript = await readLogTail(logTarget);
  // A secret-bearing log is never analysed: DevPilot reports that it exists, nothing more.
  const sensitiveLog = isSensitiveFile(logTarget);
  const subject = sensitiveLog ? '' : transcript.text;

  let index = request.workspaceId === undefined ? undefined : cachedSymbolIndex(request.workspaceId);
  let analysis = analyzeFailure(subject, root, analyzeOptions(request, root, index));

  // A JVM stack trace prints bare file names (`UserService.java`), which cannot be verified
  // without the workspace file list. Building the index on demand is what keeps the primary
  // location on the project's own file instead of JUnit's internals; it is paid for only when a
  // frame actually failed to resolve, and the index then serves `import_related` suspects too.
  if (
    analysis.unresolvedFrames > 0 &&
    index === undefined &&
    request.workspaceId !== undefined &&
    request.config !== undefined
  ) {
    try {
      index = await acquireSymbolIndex({
        id: request.workspaceId,
        root,
        paths: request.paths,
        config: request.config,
        ...(request.logger === undefined ? {} : { logger: request.logger }),
      });
      analysis = analyzeFailure(subject, root, analyzeOptions(request, root, index));
    } catch {
      /* best effort: unresolvable frames stay listed after the workspace locations */
    }
  }

  const extraEvidence: string[] = [];
  const extraNotes: string[] = [];
  if (sensitiveLog) {
    extraNotes.push(
      `${toPosix(path.relative(root, logTarget))} is a sensitive file: its contents were not analysed`,
    );
  }
  const primary = analysis.locations[0];
  if (primary !== undefined) {
    if (isSensitiveFile(path.join(root, primary.path))) {
      extraNotes.push(
        `source line withheld: ${primary.path} looks secret-bearing (existence is reported, contents are not)`,
      );
    } else {
      const line = await sourceLine(root, primary);
      if (line !== undefined) extraEvidence.push(line);
    }
  }

  if (transcript.truncated) {
    extraNotes.push(
      `only the last ${Math.round(transcript.bytes / 1024)} KiB of the log were analysed (${Math.round(transcript.totalBytes / 1024)} KiB on disk)`,
    );
  }

  const changedFiles = await recentChanges(root, request.logger);
  const importersOf =
    index === undefined
      ? undefined
      : (relativePath: string): string[] =>
          index
            .importEdges()
            .filter((edge) => edge.toPath === relativePath)
            .map((edge) => edge.fromPath);

  if (importersOf === undefined) {
    extraNotes.push(
      'no in-memory symbol index for this workspace: import_related suspects were skipped (call find_symbol or find_references first to build the index)',
    );
  }

  return buildDiagnosis({
    analysis,
    text: subject,
    ...(job === undefined ? {} : { job }),
    logFile: toPosix(path.relative(root, logTarget)),
    changedFiles,
    ...(importersOf === undefined ? {} : { importersOf }),
    ...(extraEvidence.length === 0 ? {} : { extraEvidence }),
    ...(extraNotes.length === 0 ? {} : { extraNotes }),
  });
}

/** One-line, log-free description of a diagnosis — shared by the tool envelope and the CLI. */
export function describeDiagnosis(result: DiagnosisResult): string {
  const where =
    result.location === undefined
      ? 'no workspace location extracted'
      : `${result.location.path}${result.location.line === undefined ? '' : `:${result.location.line}`}`;
  return `${result.category} (${result.confidence}) — ${where}; ${result.evidence.length} evidence line(s), ${result.suspectFiles.length} suspect file(s)`;
}

interface SelectArgs {
  jobId?: string | undefined;
  command?: string | undefined;
  logFile?: string | undefined;
}

async function selectJob(
  recent: readonly JobRecord[],
  args: SelectArgs,
): Promise<JobRecord | undefined> {
  if (args.jobId !== undefined) return recent.find((job) => job.jobId === args.jobId);
  if (args.logFile !== undefined) {
    // A log without a ledger entry is fine; still attach the job that produced it, if known.
    return recent.find((job) => job.logFile.endsWith(path.basename(args.logFile ?? '')));
  }
  if (args.command !== undefined) {
    const needle = args.command.toLowerCase();
    return recent.find((job) => job.command.toLowerCase().includes(needle));
  }
  const failed = recent.find((job) => job.exitCode !== 0 || job.exitCode === null || job.timedOut);
  if (failed !== undefined) return failed;
  // Nothing failed: report on the newest job so the answer is honest rather than empty.
  return recent[0];
}

/**
 * A lexical `isInside` check is not enough: a junction or symlink inside the workspace can point at
 * a directory outside it, so the *real* path of the log has to be inside the *real* workspace root
 * too (Phase 9 attack fixtures). Both roots are realpath'd, which also handles a workspace reached
 * through a mapped drive or a symlinked checkout.
 */
async function resolveLogTarget(
  root: string,
  job: JobRecord | undefined,
  logFile?: string,
): Promise<string> {
  const candidate =
    logFile !== undefined ? path.resolve(root, logFile) : resolveStoredLog(root, job);
  const label = toPosix(logFile ?? candidate);
  if (!isInside(root, candidate)) throw errors.pathOutsideWorkspace(label, toPosix(root));

  const [real, realRoot] = await Promise.all([realpathOrUndefined(candidate), realpathOrUndefined(root)]);
  if (real !== undefined && realRoot !== undefined && !isInside(realRoot, real)) {
    throw errors.pathOutsideWorkspace(label, toPosix(root));
  }
  return candidate;
}

function resolveStoredLog(root: string, job: JobRecord | undefined): string {
  const stored = job?.logFile;
  if (stored === undefined || stored === '') {
    throw errors.fileNotFound(
      'no log file is recorded for this job',
      undefined,
      'Pass logFile with a workspace-relative path.',
    );
  }
  return path.isAbsolute(stored) ? stored : path.resolve(root, stored);
}

async function realpathOrUndefined(target: string): Promise<string | undefined> {
  try {
    return await fs.realpath(target);
  } catch {
    return undefined;
  }
}

interface LogTail {
  text: string;
  truncated: boolean;
  bytes: number;
  totalBytes: number;
}

async function readLogTail(target: string): Promise<LogTail> {
  let size: number;
  try {
    size = (await fs.stat(target)).size;
  } catch {
    throw errors.fileNotFound(
      toPosix(target),
      'the transcript is gone',
      'Re-run the command to produce a fresh log.',
    );
  }

  const length = Math.min(size, MAX_LOG_BYTES);
  const start = Math.max(0, size - length);
  const handle = await fs.open(target, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, start);
    const text = buffer.subarray(0, bytesRead).toString('utf8');
    // Dropping the first partial line keeps the evidence lines readable.
    const cleaned = start > 0 ? text.slice(text.indexOf('\n') + 1 || 0) : text;
    return { text: cleaned, truncated: start > 0, bytes: bytesRead, totalBytes: size };
  } finally {
    await handle.close();
  }
}

async function sourceLine(root: string, location: DiagnosisLocation): Promise<string | undefined> {
  if (location.line === undefined) return undefined;
  const target = path.resolve(root, location.path);
  if (!isInside(root, target)) return undefined;
  // Same reasoning as resolveLogTarget: a junction inside the workspace must not let a stack frame
  // point DevPilot at a file outside it.
  const [real, realRoot] = await Promise.all([realpathOrUndefined(target), realpathOrUndefined(root)]);
  if (real === undefined || realRoot === undefined || !isInside(realRoot, real)) return undefined;
  try {
    const text = await fs.readFile(target, 'utf8');
    const line = text.split(/\r?\n/)[location.line - 1];
    if (line === undefined) return undefined;
    const trimmed = line.trim();
    if (trimmed === '') return undefined;
    const clipped = trimmed.length > 200 ? `${trimmed.slice(0, 200)}…` : trimmed;
    return `${location.path}:${location.line} | ${clipped}`;
  } catch {
    return undefined;
  }
}

/** Paths with uncommitted changes (tracked edits and new untracked files), capped. */
export async function recentChanges(
  root: string,
  logger: Logger | undefined,
): Promise<string[]> {
  try {
    const git = new GitManager({ cwd: root, ...(logger === undefined ? {} : { logger }) });
    if (!(await git.isRepo())) return [];
    const repoRoot = (await git.repositoryRoot()) ?? root;
    const lines = await git.statusPorcelain();
    const out: string[] = [];
    for (const line of lines) {
      const trimmed = line.replace(/\s+$/, '');
      if (trimmed.length < 4) continue;
      const status = trimmed.slice(0, 2);
      if (status.includes('D')) continue; // a deleted file is not a suspect to edit
      let rest = trimmed.slice(3).trim();
      if (rest.startsWith('"') && rest.endsWith('"')) rest = rest.slice(1, -1);
      const arrow = rest.lastIndexOf(' -> ');
      if (arrow !== -1) rest = rest.slice(arrow + 4);
      if (rest === '') continue;
      const absolute = path.resolve(repoRoot, rest);
      if (!isInside(root, absolute)) continue;
      const relative = toPosix(path.relative(root, absolute));
      if (relative.startsWith('.devpilot/')) continue;
      if (!out.includes(relative)) out.push(relative);
      if (out.length >= MAX_CHANGED_FILES) break;
    }
    return out;
  } catch {
    return [];
  }
}

export { DEFAULT_MAX_EVIDENCE };

function analyzeOptions(
  request: DiagnoseJobRequest,
  root: string,
  index: SymbolIndex | undefined,
): AnalyzeOptions {
  return {
    ...(request.maxEvidence === undefined ? {} : { maxEvidence: request.maxEvidence }),
    maxLocations: 5,
    locationOptions: locationOptionsFor(root, index),
  };
}

/**
 * Frame verification for the location scanner: existence on disk for relative frames, and a
 * basename lookup so a JVM frame's bare file name becomes the workspace path it belongs to.
 * The basename map is built lazily and only when a bare name is actually seen.
 */
function locationOptionsFor(root: string, index: SymbolIndex | undefined): LocationScanOptions {
  let basenames: Map<string, string> | undefined;
  return {
    resolveBareName: (fileName) => {
      if (index === undefined) return undefined;
      if (basenames === undefined) {
        basenames = new Map();
        for (const filePath of index.filePaths()) {
          const slash = filePath.lastIndexOf('/');
          const base = (slash === -1 ? filePath : filePath.slice(slash + 1)).toLowerCase();
          if (!basenames.has(base)) basenames.set(base, filePath);
        }
      }
      return basenames.get(fileName.toLowerCase());
    },
    fileExists: (relativePath) => existsSync(path.join(root, relativePath)),
  };
}
