/**
 * reader.server.ts - Read-only SQLite reader for Deck Flows Slice 1b.
 *
 * Reuses Slice 1a confinement, pragma verification, hash-chain verification,
 * artefact verification, and replay reducer. NEVER instantiates new Database
 * directly, NEVER acquires flows.owner locks, NEVER creates files/directories,
 * and NEVER queries private detail records.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import path from "node:path";
import {
  deriveWaitingOn,
  projectFlowCardStream,
  type FlowCardStreamView,
  type FlowRunSummary,
} from "./card-stream.js";
import {
  FlowPinMismatchError,
  loadRunState,
  PathConfinementError,
  SymlinkNotAllowedError,
} from "./load-run.server.js";
import {
  assertNoSymlinkInChain,
  configuredFlowsDataRoot,
  resolveFlowsRootDir,
  resolveProjectDataDir,
  UnsafeFilesystemError,
} from "./owner.server.js";
import {
  HashChainCorruptionError,
  openFlowsStore,
  StorePragmaError,
} from "./store.server.js";
import { FlowIdRegex } from "./types.js";

export class InvalidFlowQueryError extends Error {
  constructor(message = "Invalid flow project or run id.") {
    super(message);
    this.name = "InvalidFlowQueryError";
  }
}

export class FlowRunNotFoundError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly runId: string,
  ) {
    super(`Flow run '${runId}' not found for project '${projectId}'.`);
    this.name = "FlowRunNotFoundError";
  }
}

export class FlowIntegrityError extends Error {
  constructor(message = "Flow ledger failed integrity verification.", options?: ErrorOptions) {
    super(message, options);
    this.name = "FlowIntegrityError";
  }
}

function classifyReaderError(err: unknown): unknown {
  if (err instanceof FlowIntegrityError || err instanceof InvalidFlowQueryError) {
    return err;
  }
  if (
    err instanceof HashChainCorruptionError ||
    err instanceof FlowPinMismatchError ||
    err instanceof StorePragmaError ||
    err instanceof PathConfinementError ||
    err instanceof SymlinkNotAllowedError ||
    err instanceof SyntaxError
  ) {
    return new FlowIntegrityError("Flow ledger failed integrity verification.", { cause: err });
  }
  if (err instanceof Error) {
    if (
      err.name === "ZodError" ||
      err.name === "SqliteError" ||
      /Symlink|Hard-linked|Expected regular file|inode verification|Flow YAML validation failed|Pinned flow definition bytes missing|Event line|SQLITE_CORRUPT|SQLITE_NOTADB|no such table|file is not a database|traverses outside|strict descendant/i.test(
        err.message,
      )
    ) {
      return new FlowIntegrityError("Flow ledger failed integrity verification.", { cause: err });
    }
  }
  return err;
}

function isAbsentFlowsInGitWorktree(err: unknown): boolean {
  if (!(err instanceof UnsafeFilesystemError) || err.mountType !== "git-worktree") {
    return false;
  }
  const flowsCandidate = path.join(path.resolve(err.targetPath), "flows");
  try {
    return fs.lstatSync(flowsCandidate, { throwIfNoEntry: false }) === undefined;
  } catch {
    return false;
  }
}

function checkExistingProjectDb(
  projectId: string,
  dataRoot?: string,
): "missing" | "ready" {
  if (!configuredFlowsDataRoot(dataRoot)) {
    return "missing";
  }

  let flowsRoot: string;
  try {
    flowsRoot = resolveFlowsRootDir(dataRoot);
  } catch (err) {
    if (isAbsentFlowsInGitWorktree(err)) {
      return "missing";
    }
    throw classifyReaderError(err);
  }

  const rootStat = fs.lstatSync(flowsRoot, { throwIfNoEntry: false });
  if (!rootStat) {
    return "missing";
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FlowIntegrityError("Flow ledger failed integrity verification.");
  }

  let projectDir: string;
  try {
    projectDir = resolveProjectDataDir(projectId, dataRoot);
  } catch (err) {
    throw classifyReaderError(err);
  }

  const dirStat = fs.lstatSync(projectDir, { throwIfNoEntry: false });
  if (!dirStat) {
    return "missing";
  }
  if (dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
    throw new FlowIntegrityError("Flow ledger failed integrity verification.");
  }

  let dbPath: string;
  try {
    dbPath = assertNoSymlinkInChain(path.join(projectDir, "flows.db"), projectDir, {
      mustBeStrictDescendant: true,
    });
  } catch (err) {
    throw classifyReaderError(err);
  }

  const dbStat = fs.lstatSync(dbPath, { throwIfNoEntry: false });
  if (!dbStat) {
    return "missing";
  }
  if (dbStat.isSymbolicLink() || !dbStat.isFile() || dbStat.nlink !== 1) {
    throw new FlowIntegrityError("Flow ledger failed integrity verification.");
  }

  return "ready";
}

export function listFlowProjects(options?: { dataRoot?: string }): string[] {
  if (!configuredFlowsDataRoot(options?.dataRoot)) {
    return [];
  }

  let flowsRoot: string;
  try {
    flowsRoot = resolveFlowsRootDir(options?.dataRoot);
  } catch (err) {
    if (isAbsentFlowsInGitWorktree(err)) {
      return [];
    }
    throw classifyReaderError(err);
  }

  const rootStat = fs.lstatSync(flowsRoot, { throwIfNoEntry: false });
  if (!rootStat) {
    return [];
  }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new FlowIntegrityError("Flow ledger failed integrity verification.");
  }

  const entries = fs.readdirSync(flowsRoot, { withFileTypes: true });
  const projects: string[] = [];

  for (const entry of entries) {
    if (!FlowIdRegex.test(entry.name)) {
      continue;
    }
    const projectDir = path.join(flowsRoot, entry.name);
    let confinedDir: string;
    try {
      confinedDir = assertNoSymlinkInChain(projectDir, flowsRoot, {
        mustBeStrictDescendant: true,
      });
    } catch {
      continue;
    }

    const dirStat = fs.lstatSync(confinedDir, { throwIfNoEntry: false });
    if (!dirStat || dirStat.isSymbolicLink() || !dirStat.isDirectory()) {
      continue;
    }

    const dbPath = path.join(confinedDir, "flows.db");
    let confinedDb: string;
    try {
      confinedDb = assertNoSymlinkInChain(dbPath, confinedDir, {
        mustBeStrictDescendant: true,
      });
    } catch {
      continue;
    }

    const dbStat = fs.lstatSync(confinedDb, { throwIfNoEntry: false });
    if (!dbStat || dbStat.isSymbolicLink() || !dbStat.isFile() || dbStat.nlink !== 1) {
      continue;
    }

    projects.push(entry.name);
  }

  return projects.sort();
}

export function listFlowRuns(
  projectId: string,
  options?: { dataRoot?: string },
): FlowRunSummary[] {
  if (typeof projectId !== "string" || !FlowIdRegex.test(projectId)) {
    throw new InvalidFlowQueryError("Invalid flow project id.");
  }

  if (checkExistingProjectDb(projectId, options?.dataRoot) === "missing") {
    return [];
  }

  try {
    const store = openFlowsStore(projectId, {
      dataRoot: options?.dataRoot,
      readonly: true,
    });
    try {
      return store.listRuns().map((row) => ({
        runId: row.run_id,
        status: row.status,
        waitingOn: deriveWaitingOn(row.status),
        flowHash: row.flow_hash,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    } finally {
      store.close();
    }
  } catch (err) {
    throw classifyReaderError(err);
  }
}

export function readFlowCardStream(
  projectId: string,
  runId: string,
  options?: { dataRoot?: string },
): FlowCardStreamView | null {
  if (
    typeof projectId !== "string" ||
    !FlowIdRegex.test(projectId) ||
    typeof runId !== "string" ||
    !FlowIdRegex.test(runId)
  ) {
    throw new InvalidFlowQueryError("Invalid flow project or run id.");
  }

  if (checkExistingProjectDb(projectId, options?.dataRoot) === "missing") {
    return null;
  }

  try {
    const store = openFlowsStore(projectId, {
      dataRoot: options?.dataRoot,
      readonly: true,
    });
    let hasRun = false;
    try {
      hasRun = store.getRun(runId) !== null;
    } finally {
      store.close();
    }

    if (!hasRun) {
      return null;
    }

    const loaded = loadRunState(projectId, runId, {
      dataRoot: options?.dataRoot,
    });

    const stream = projectFlowCardStream({
      projectId,
      runId,
      flowHash: loaded.run.flow_hash,
      flow: loaded.flow,
      events: loaded.events,
      state: loaded.state,
    });
    return loaded.readOnly ? { ...stream, readOnly: true } : stream;
  } catch (err) {
    throw classifyReaderError(err);
  }
}
