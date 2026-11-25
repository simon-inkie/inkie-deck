/**
 * worktree.server.ts - Ephemeral git worktree isolation and clean rollback for Deck Flows Slice 3.
 *
 * Enforces:
 * - Strict confinement of ephemeral worktrees under worktreeBaseDir, NEVER inside repoRoot.
 * - Validated FlowIdRegex run/step/attempt identifiers and safe git ref names (never shell-interpolated).
 * - Bounded process-group git invocations via runBoundedProcessGroup (zero shell, zero leaked children).
 * - Deterministic commit capture (baseSha ancestry check, cleanliness check, changed file list).
 * - Idempotent rollback (git worktree remove --force, temp branch cleanup, fs rm fallback, git worktree prune)
 *   so failed, timed-out, crashed, or rewound attempts never dirty repoRoot or leak worktree entries.
 *
 * ASCII only - no em-dashes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { assertConfinedPath } from "./load-run.server.js";
import { runBoundedProcessGroup } from "./runner.server.js";
import { FlowGitShaRegex, FlowIdRegex, FlowSafeValueRegex } from "./types.js";

const GIT_REF_REGEX = /^[A-Za-z0-9._/-]{1,128}$/;
const DEFAULT_GIT_TIMEOUT_MS = 15_000;

export interface WorktreeHandle {
  repoRoot: string;
  worktreeBaseDir: string;
  worktreePath: string;
  baseRef: string;
  baseSha: string;
  branch?: string;
  intentEventId?: string;
  detached: boolean;
  runId: string;
  stepId: string;
  attemptId: string;
}

export interface WorktreeOutcome {
  baseSha: string;
  headSha: string;
  branch?: string;
  isClean: boolean;
  hasNewCommit: boolean;
  changedFiles: string[];
}

export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

function assertSafeGitRef(ref: string): void {
  if (
    !ref ||
    ref.startsWith("-") ||
    ref.includes("..") ||
    ref.includes("@{") ||
    !GIT_REF_REGEX.test(ref)
  ) {
    throw new WorktreeError(`Unsafe git ref '${ref}'`);
  }
}

function assertDisjointFromRepo(worktreeBaseDir: string, repoRoot: string): void {
  const realRepo = fs.realpathSync(path.resolve(repoRoot));
  const resolvedBase = path.resolve(worktreeBaseDir);

  let realBase = resolvedBase;
  let probe = resolvedBase;
  const tail: string[] = [];
  while (!fs.existsSync(probe)) {
    const parent = path.dirname(probe);
    if (parent === probe) break;
    tail.unshift(path.basename(probe));
    probe = parent;
  }
  if (fs.existsSync(probe)) {
    realBase = tail.length > 0 ? path.join(fs.realpathSync(probe), ...tail) : fs.realpathSync(probe);
  }

  for (const baseCandidate of [resolvedBase, realBase]) {
    if (
      baseCandidate === realRepo ||
      baseCandidate.startsWith(realRepo + path.sep)
    ) {
      throw new WorktreeError(
        `Worktree base directory '${worktreeBaseDir}' must be outside git repository '${repoRoot}'`,
      );
    }
  }
}

export function buildEphemeralBranchName(runId: string, attemptId: string): string {
  const candidate = `flow-${runId}-${attemptId}`.toLowerCase();
  if (candidate.length <= 64 && FlowSafeValueRegex.test(candidate)) {
    return candidate;
  }
  const digest = crypto
    .createHash("sha256")
    .update(`${runId}:${attemptId}`)
    .digest("hex")
    .slice(0, 24);
  return `flow-${digest}`;
}

function worktreeLockReason(intentEventId: string): string {
  return `Deck flow attempt ${intentEventId}`;
}

async function execGit(
  cwd: string,
  args: string[],
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }> {
  const res = await runBoundedProcessGroup("git", args, {
    cwd,
    timeoutMs,
    signal,
  });
  return {
    code: res.code,
    stdout: res.stdout,
    stderr: res.stderr,
    timedOut: res.timedOut,
  };
}

/**
 * Verify repoRoot is a valid git working tree and resolve baseRef to a 40-hex commit SHA.
 */
export async function resolveBaseCommitSha(
  repoRoot: string,
  baseRef: string,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<string> {
  assertSafeGitRef(baseRef);
  const resolvedRepo = path.resolve(repoRoot);
  if (!fs.existsSync(resolvedRepo) || !fs.statSync(resolvedRepo).isDirectory()) {
    throw new WorktreeError(`Repository root does not exist: ${repoRoot}`);
  }

  const checkRepo = await execGit(resolvedRepo, ["rev-parse", "--is-inside-work-tree"], timeoutMs);
  if (checkRepo.code !== 0 || checkRepo.stdout.trim() !== "true") {
    throw new WorktreeError(`Not a valid git repository: ${repoRoot}`);
  }

  const resolved = await execGit(
    resolvedRepo,
    ["rev-parse", "--verify", `${baseRef}^{commit}`],
    timeoutMs,
  );
  if (resolved.code !== 0) {
    throw new WorktreeError(
      `Failed to resolve git baseRef '${baseRef}' in '${repoRoot}': ${resolved.stderr.trim()}`,
    );
  }
  const sha = resolved.stdout.trim();
  if (!FlowGitShaRegex.test(sha)) {
    throw new WorktreeError(`Resolved git SHA '${sha}' is not a valid 40-hex commit hash`);
  }
  return sha;
}

/**
 * Allocate an isolated ephemeral git worktree confined inside worktreeBaseDir
 * (strictly outside repoRoot).
 */
export async function createEphemeralWorktree(params: {
  repoRoot: string;
  baseRef: string;
  worktreeBaseDir: string;
  runId: string;
  stepId: string;
  attemptId: string;
  intentEventId?: string;
  detached?: boolean;
  timeoutMs?: number;
}): Promise<WorktreeHandle> {
  if (!FlowIdRegex.test(params.runId)) {
    throw new WorktreeError(`Invalid runId '${params.runId}'`);
  }
  if (!FlowIdRegex.test(params.stepId)) {
    throw new WorktreeError(`Invalid stepId '${params.stepId}'`);
  }
  if (!FlowIdRegex.test(params.attemptId)) {
    throw new WorktreeError(`Invalid attemptId '${params.attemptId}'`);
  }

  const resolvedRepo = path.resolve(params.repoRoot);
  const resolvedBaseDir = path.resolve(params.worktreeBaseDir);
  const timeoutMs = params.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;

  const baseSha = await resolveBaseCommitSha(resolvedRepo, params.baseRef, timeoutMs);
  assertDisjointFromRepo(resolvedBaseDir, resolvedRepo);

  fs.mkdirSync(resolvedBaseDir, { recursive: true, mode: 0o700 });
  const runDir = path.join(resolvedBaseDir, params.runId);
  assertConfinedPath(runDir, resolvedBaseDir);
  fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });

  const worktreePath = path.join(runDir, params.attemptId);
  assertConfinedPath(worktreePath, resolvedBaseDir);

  // Clean up any stale leftover path from a prior crashed process before adding
  if (fs.existsSync(worktreePath)) {
    await execGit(resolvedRepo, ["worktree", "remove", "--force", worktreePath], timeoutMs);
    if (fs.existsSync(worktreePath)) {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    await execGit(resolvedRepo, ["worktree", "prune"], timeoutMs);
  }

  const detached = params.detached ?? false;
  let branch: string | undefined;
  const addArgs = ["worktree", "add"];
  if (params.intentEventId) {
    // Git writes the ownership marker as part of creating the worktree.
    addArgs.push("--lock", "--reason", worktreeLockReason(params.intentEventId));
  }
  if (detached) {
    addArgs.push("--detach");
  } else {
    branch = buildEphemeralBranchName(params.runId, params.attemptId);
    // Remove stale temp branch if left behind by a prior crash
    await execGit(resolvedRepo, ["branch", "-D", branch], timeoutMs);
    addArgs.push("-b", branch);
  }

  const added = await execGit(resolvedRepo, [...addArgs, worktreePath, baseSha], timeoutMs);
  if (added.code !== 0) {
    throw new WorktreeError(
      `git worktree add failed for '${worktreePath}': ${added.stderr.trim() || added.stdout.trim()}`,
    );
  }

  return {
    repoRoot: resolvedRepo,
    worktreeBaseDir: resolvedBaseDir,
    worktreePath,
    baseRef: params.baseRef,
    baseSha,
    ...(branch ? { branch } : {}),
    intentEventId: params.intentEventId,
    detached,
    runId: params.runId,
    stepId: params.stepId,
    attemptId: params.attemptId,
  };
}

/** Remove the registered worktree owned by an interrupted step intent, if it still exists. */
export async function recoverEphemeralWorktree(params: {
  repoRoot: string;
  worktreeBaseDir: string;
  runId: string;
  attemptId: string;
  intentEventId: string;
}): Promise<void> {
  const worktreePath = path.resolve(params.worktreeBaseDir, params.runId, params.attemptId);
  const listed = await execGit(params.repoRoot, ["worktree", "list", "--porcelain", "-z"]);
  if (listed.code !== 0 || !listed.stdout.endsWith("\0\0")) {
    throw new WorktreeError("Could not list git worktrees during flow recovery");
  }
  const reason = `locked ${worktreeLockReason(params.intentEventId)}`;
  const owned = listed.stdout.split("\0\0").some((record) => {
    const [entry, ...fields] = record.split("\0");
    return entry === `worktree ${worktreePath}` && fields.includes(reason);
  });
  if (!owned) return;

  assertConfinedPath(worktreePath, params.worktreeBaseDir);
  const removed = await execGit(params.repoRoot, ["worktree", "remove", "--force", "--force", "--", worktreePath]);
  if (removed.code !== 0) {
    throw new WorktreeError(`Could not remove interrupted flow worktree: ${removed.stderr.trim()}`);
  }
  await execGit(params.repoRoot, ["branch", "-D", buildEphemeralBranchName(params.runId, params.attemptId)]);
}

/**
 * Inspect an active ephemeral worktree and capture its commit outcome, ancestry,
 * working-tree cleanliness, and changed file list relative to baseSha.
 */
export async function captureWorktreeOutcome(
  handle: WorktreeHandle,
  timeoutMs = DEFAULT_GIT_TIMEOUT_MS,
): Promise<WorktreeOutcome> {
  assertConfinedPath(handle.worktreePath, handle.worktreeBaseDir);

  const headRes = await execGit(handle.worktreePath, ["rev-parse", "HEAD"], timeoutMs);
  if (headRes.code !== 0) {
    throw new WorktreeError(`Failed to read HEAD in worktree '${handle.worktreePath}': ${headRes.stderr.trim()}`);
  }
  const headSha = headRes.stdout.trim();
  if (!FlowGitShaRegex.test(headSha)) {
    throw new WorktreeError(`Invalid worktree HEAD sha '${headSha}'`);
  }

  const ancestorRes = await execGit(
    handle.repoRoot,
    ["merge-base", "--is-ancestor", handle.baseSha, headSha],
    timeoutMs,
  );
  if (ancestorRes.code !== 0) {
    throw new WorktreeError(
      `Worktree HEAD '${headSha}' does not descend from base commit '${handle.baseSha}'`,
    );
  }

  const statusRes = await execGit(handle.worktreePath, ["status", "--porcelain"], timeoutMs);
  if (statusRes.code !== 0) {
    throw new WorktreeError(`Failed to inspect git status in '${handle.worktreePath}': ${statusRes.stderr.trim()}`);
  }
  const isClean = statusRes.stdout.trim().length === 0;

  const diffRes = await execGit(
    handle.repoRoot,
    ["diff", "--name-only", `${handle.baseSha}..${headSha}`],
    timeoutMs,
  );
  if (diffRes.code !== 0) {
    throw new WorktreeError(`Failed to list changed files between ${handle.baseSha}..${headSha}`);
  }
  const changedFiles = diffRes.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);

  return {
    baseSha: handle.baseSha,
    headSha,
    ...(handle.branch ? { branch: handle.branch } : {}),
    isClean,
    hasNewCommit: headSha !== handle.baseSha,
    changedFiles,
  };
}

/**
 * Remove an ephemeral worktree cleanly and prune git metadata.
 * Idempotent even if the worktree was already partially removed after a crash.
 * By default deletes the temporary branch too; pass { keepBranch: true } when retaining
 * a committed branch ref after a passing step.
 */
export async function rollbackWorktree(
  handle: WorktreeHandle,
  options?: { keepBranch?: boolean; timeoutMs?: number },
): Promise<void> {
  const timeoutMs = options?.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS;
  assertConfinedPath(handle.worktreePath, handle.worktreeBaseDir);

  if (fs.existsSync(handle.worktreePath)) {
    const rmRes = await execGit(
      handle.repoRoot,
      ["worktree", "remove", "--force", ...(handle.intentEventId ? ["--force"] : []), handle.worktreePath],
      timeoutMs,
    );
    if (rmRes.code !== 0 && fs.existsSync(handle.worktreePath)) {
      fs.rmSync(handle.worktreePath, { recursive: true, force: true });
    }
  }

  await execGit(handle.repoRoot, ["worktree", "prune"], timeoutMs);

  if (handle.branch && !options?.keepBranch) {
    await execGit(handle.repoRoot, ["branch", "-D", handle.branch], timeoutMs);
  }
}

/**
 * Allocate a short-lived detached worktree pinned to an exact 40-hex commit SHA
 * (used by deterministic checks and repro fail-on-base/pass-on-head verification).
 */
export async function createDetachedCommitWorktree(params: {
  repoRoot: string;
  commitSha: string;
  worktreeBaseDir: string;
  label: string;
  timeoutMs?: number;
}): Promise<WorktreeHandle> {
  if (!FlowGitShaRegex.test(params.commitSha)) {
    throw new WorktreeError(`Invalid commit SHA '${params.commitSha}'`);
  }
  const safeLabel = FlowIdRegex.test(params.label)
    ? params.label
    : `chk_${crypto.createHash("sha256").update(params.label).digest("hex").slice(0, 12)}`;
  const uniqueSuffix = crypto.randomBytes(4).toString("hex");
  const attemptId = `${safeLabel.slice(0, 48)}_${uniqueSuffix}`;
  return createEphemeralWorktree({
    repoRoot: params.repoRoot,
    baseRef: params.commitSha,
    worktreeBaseDir: params.worktreeBaseDir,
    runId: "check_wt",
    stepId: "check",
    attemptId,
    detached: true,
    timeoutMs: params.timeoutMs,
  });
}
