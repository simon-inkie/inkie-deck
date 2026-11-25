/**
 * checks.server.ts - Deterministic check runner, repro verifier, and git-diff signal extractor
 * for Deck Flows Slice 3.
 *
 * Enforces:
 * - Explicit allowlisted command map for typecheck | test | lint | leak_scan | build
 *   (NEVER sh -c, NEVER arbitrary command strings from YAML).
 * - Bounded process-group execution via runBoundedProcessGroup (zero leaked children).
 * - Real fail-on-base / pass-on-head reproduction test verification in ephemeral detached worktrees.
 * - Real git-diff signal extraction feeding evaluateStepJudgement in engine.ts.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import path from "node:path";
import type { StepSignals } from "./engine.js";
import { assertConfinedPath } from "./load-run.server.js";
import { runBoundedProcessGroup } from "./runner.server.js";
import {
  FlowGitShaRegex,
  FlowSafePathSchema,
  type FlowDefinition,
} from "./types.js";
import {
  createDetachedCommitWorktree,
  rollbackWorktree,
  type WorktreeHandle,
} from "./worktree.server.js";

export type FlowCommandCheckId = "typecheck" | "test" | "lint" | "leak_scan" | "build";

export const ALLOWED_COMMAND_CHECK_IDS: ReadonlySet<FlowCommandCheckId> = new Set([
  "typecheck",
  "test",
  "lint",
  "leak_scan",
  "build",
]);

const FORBIDDEN_SHELL_BINARIES = new Set([
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "csh",
  "fish",
  "cmd",
  "cmd.exe",
  "powershell",
  "pwsh",
]);

const LOCKFILE_BASENAMES = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "poetry.lock",
  "go.sum",
]);

export interface AllowlistedCheckCommand {
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export type CheckCommandMap = Partial<Record<FlowCommandCheckId, AllowlistedCheckCommand>>;

export const DEFAULT_CHECK_COMMANDS: Readonly<Record<FlowCommandCheckId, AllowlistedCheckCommand>> = {
  typecheck: { command: "pnpm", args: ["typecheck"] },
  test: { command: "pnpm", args: ["test"] },
  lint: { command: "pnpm", args: ["lint"] },
  leak_scan: { command: "pnpm", args: ["check:leaks"] },
  build: { command: "pnpm", args: ["build"] },
};

export interface SingleCheckRunResult {
  checkId: FlowCommandCheckId;
  passed: boolean;
  code: number | null;
  timedOut: boolean;
  stdout: string;
  stderr: string;
}

export interface CheckSuiteRunResult {
  passed: boolean;
  results: SingleCheckRunResult[];
  failedCheckId?: FlowCommandCheckId;
  errorClass?: string;
}

export interface ReproTestRunnerContext {
  cwd: string;
  reproTestPath: string;
  phase: "base" | "head";
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ReproTestRunnerResult {
  passed: boolean;
  code: number | null;
  stdout?: string;
  stderr?: string;
}

export type ReproTestCommand =
  | AllowlistedCheckCommand
  | ((ctx: ReproTestRunnerContext) => Promise<ReproTestRunnerResult> | ReproTestRunnerResult)
  | { buildCommand: (reproTestPath: string) => AllowlistedCheckCommand };

export interface ReproCheckResult {
  passed: boolean;
  failedOnBase: boolean;
  passedOnHead: boolean;
  reason?: string;
}

export function isFlowCommandCheckId(value: string): value is FlowCommandCheckId {
  return ALLOWED_COMMAND_CHECK_IDS.has(value as FlowCommandCheckId);
}

export function isSupportedSuiteCheckId(value: string): boolean {
  return value === "repro" || isFlowCommandCheckId(value);
}

function assertNonShellCommand(spec: AllowlistedCheckCommand): void {
  const base = path.basename(spec.command).toLowerCase();
  if (!base || FORBIDDEN_SHELL_BINARIES.has(base)) {
    throw new Error(`Shell command '${spec.command}' is forbidden in allowlisted flow checks`);
  }
}

/**
 * Execute a single allowlisted check command in a bounded POSIX process group.
 */
export async function runAllowlistedCheck(params: {
  checkId: FlowCommandCheckId;
  cwd: string;
  checkCommands?: CheckCommandMap;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<SingleCheckRunResult> {
  if (!isFlowCommandCheckId(params.checkId)) {
    throw new Error(`Unallowlisted check ID '${String(params.checkId)}'`);
  }
  const spec = params.checkCommands?.[params.checkId] ?? DEFAULT_CHECK_COMMANDS[params.checkId];
  assertNonShellCommand(spec);

  const mergedEnv: NodeJS.ProcessEnv = {
    ...process.env,
    ...(params.env ?? {}),
    ...(spec.env ?? {}),
  };

  const res = await runBoundedProcessGroup(spec.command, spec.args, {
    cwd: params.cwd,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
    env: mergedEnv,
  });

  return {
    checkId: params.checkId,
    passed: !res.timedOut && res.code === 0,
    code: res.code,
    timedOut: res.timedOut,
    stdout: res.stdout,
    stderr: res.stderr,
  };
}

/**
 * Execute a list of allowlisted check commands sequentially in the target working tree.
 * Stops on first timeout or continues through the declared checks so signals (e.g. leak_scan)
 * are accurately observed.
 */
export async function runAllowlistedCheckSuite(params: {
  checkIds: readonly FlowCommandCheckId[];
  cwd: string;
  checkCommands?: CheckCommandMap;
  timeoutMs: number;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
}): Promise<CheckSuiteRunResult> {
  const results: SingleCheckRunResult[] = [];
  let failedCheckId: FlowCommandCheckId | undefined;
  let errorClass: string | undefined;

  for (const checkId of params.checkIds) {
    if (params.signal?.aborted) {
      return {
        passed: false,
        results,
        failedCheckId: failedCheckId ?? checkId,
        errorClass: errorClass ?? `${checkId}:aborted`,
      };
    }
    const single = await runAllowlistedCheck({
      checkId,
      cwd: params.cwd,
      checkCommands: params.checkCommands,
      timeoutMs: params.timeoutMs,
      signal: params.signal,
      env: params.env,
    });
    results.push(single);
    if (!single.passed && !failedCheckId) {
      failedCheckId = checkId;
      errorClass = single.timedOut
        ? `${checkId}:timeout`
        : `${checkId}:exit_${String(single.code ?? "null")}`;
    }
    if (single.timedOut) {
      break;
    }
  }

  return {
    passed: failedCheckId === undefined,
    results,
    ...(failedCheckId ? { failedCheckId } : {}),
    ...(errorClass ? { errorClass } : {}),
  };
}

async function executeReproTestCommand(
  runTestCommand: ReproTestCommand | undefined,
  ctx: ReproTestRunnerContext,
): Promise<{ passed: boolean; code: number | null }> {
  if (typeof runTestCommand === "function") {
    const callbackRes = await runTestCommand(ctx);
    return { passed: Boolean(callbackRes.passed), code: callbackRes.code };
  }

  const spec: AllowlistedCheckCommand =
    runTestCommand && "buildCommand" in runTestCommand
      ? runTestCommand.buildCommand(ctx.reproTestPath)
      : (runTestCommand ?? {
          command: process.execPath,
          args: ["--test", ctx.reproTestPath],
        });
  assertNonShellCommand(spec);
  const res = await runBoundedProcessGroup(spec.command, spec.args, {
    cwd: ctx.cwd,
    timeoutMs: ctx.timeoutMs,
    signal: ctx.signal,
    env: { ...process.env, ...(spec.env ?? {}) },
  });
  return { passed: !res.timedOut && res.code === 0, code: res.code };
}

/**
 * Run a deterministic fail-on-base / pass-on-head reproduction check:
 * 1. Validates reproTestPath against FlowSafePathSchema.
 * 2. Checks out headSha in a temporary detached worktree and verifies reproTestPath is a confined regular file.
 * 3. Checks out baseSha in a temporary detached worktree, copies reproTestPath into it, runs test command,
 *    and asserts it FAILS on baseSha.
 * 4. Runs the same test command on headSha and asserts it PASSES.
 * 5. Always cleans up both temporary detached worktrees in finally.
 */
export async function runReproCheck(params: {
  repoRoot: string;
  worktreeBaseDir: string;
  baseSha: string;
  headSha: string;
  reproTestPath: string;
  runTestCommand?: ReproTestCommand;
  timeoutMs: number;
  signal?: AbortSignal;
}): Promise<ReproCheckResult> {
  const pathCheck = FlowSafePathSchema.safeParse(params.reproTestPath);
  if (!pathCheck.success) {
    return {
      passed: false,
      failedOnBase: false,
      passedOnHead: false,
      reason: "invalid_repro_path",
    };
  }
  if (!FlowGitShaRegex.test(params.baseSha) || !FlowGitShaRegex.test(params.headSha)) {
    return {
      passed: false,
      failedOnBase: false,
      passedOnHead: false,
      reason: "invalid_commit_sha",
    };
  }

  let headHandle: WorktreeHandle | undefined;
  let baseHandle: WorktreeHandle | undefined;

  try {
    headHandle = await createDetachedCommitWorktree({
      repoRoot: params.repoRoot,
      commitSha: params.headSha,
      worktreeBaseDir: params.worktreeBaseDir,
      label: "repro_head",
      timeoutMs: params.timeoutMs,
    });

    const headTestFile = path.join(headHandle.worktreePath, params.reproTestPath);
    assertConfinedPath(headTestFile, headHandle.worktreePath);
    const headStat = fs.lstatSync(headTestFile, { throwIfNoEntry: false });
    if (!headStat || headStat.isSymbolicLink() || !headStat.isFile()) {
      return {
        passed: false,
        failedOnBase: false,
        passedOnHead: false,
        reason: "repro_test_missing_on_head",
      };
    }
    const reproBytes = fs.readFileSync(headTestFile);

    // Phase 1: baseSha must FAIL with the repro test applied
    let failedOnBase = false;
    try {
      baseHandle = await createDetachedCommitWorktree({
        repoRoot: params.repoRoot,
        commitSha: params.baseSha,
        worktreeBaseDir: params.worktreeBaseDir,
        label: "repro_base",
        timeoutMs: params.timeoutMs,
      });

      const baseTestFile = path.join(baseHandle.worktreePath, params.reproTestPath);
      assertConfinedPath(baseTestFile, baseHandle.worktreePath);
      fs.mkdirSync(path.dirname(baseTestFile), { recursive: true });
      fs.writeFileSync(baseTestFile, reproBytes);

      const baseRes = await executeReproTestCommand(params.runTestCommand, {
        cwd: baseHandle.worktreePath,
        reproTestPath: params.reproTestPath,
        phase: "base",
        timeoutMs: params.timeoutMs,
        signal: params.signal,
      });
      failedOnBase = !baseRes.passed;
    } finally {
      if (baseHandle) {
        await rollbackWorktree(baseHandle);
      }
    }

    // Phase 2: headSha must PASS with the fix + repro test
    const headRes = await executeReproTestCommand(params.runTestCommand, {
      cwd: headHandle.worktreePath,
      reproTestPath: params.reproTestPath,
      phase: "head",
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
    const passedOnHead = headRes.passed;

    return {
      passed: failedOnBase && passedOnHead,
      failedOnBase,
      passedOnHead,
      ...(!failedOnBase
        ? { reason: "repro_did_not_fail_on_base" }
        : !passedOnHead
          ? { reason: "repro_failed_on_head" }
          : {}),
    };
  } finally {
    if (headHandle) {
      await rollbackWorktree(headHandle);
    }
  }
}

// High-confidence leak detection regexes assembled dynamically to avoid tripping static secret scanners
const LEAK_MARKER_PATTERNS: readonly RegExp[] = [
  new RegExp(["-----BEGIN", "(?:RSA |EC |DSA |OPENSSH )?PRIVATE", "KEY-----"].join(" ")),
  new RegExp(
    "\\b(?:" +
      ["gh" + "p_", "gh" + "o_", "gh" + "s_", "github_" + "pat_", "sk_" + "live_", "AK" + "IA"].join("|") +
      ")[A-Za-z0-9_]{12,}",
  ),
  new RegExp(
    "(?:API_" + "SECRET|SECRET_" + "TOKEN|PRIVATE_" + "TOKEN)\\s*[:=]\\s*[\"']?[A-Za-z0-9_\\-]{16,}",
  ),
];

function isTestFilePath(filePath: string): boolean {
  const norm = filePath.replace(/\\/g, "/").toLowerCase();
  return (
    norm.startsWith("test/") ||
    norm.startsWith("tests/") ||
    norm.includes("/test/") ||
    norm.includes("/tests/") ||
    norm.includes("/__tests__/") ||
    /\.(?:test|spec)\.[a-z0-9]+$/.test(norm)
  );
}

function isAssertionLine(content: string): boolean {
  return /\b(?:expect|assert|strictEqual|deepStrictEqual|ok)\s*\(/.test(content);
}

function introducesTestSkip(content: string): boolean {
  return (
    /\b(?:it|test|describe)\.skip\s*\(/.test(content) ||
    /\b(?:xit|xtest|xdescribe)\s*\(/.test(content) ||
    /\.skip\s*\(/.test(content)
  );
}

function detectSignalsFromUnifiedDiff(
  changedFiles: readonly string[],
  diffText: string,
): { dependencyChanged: boolean; secretFound: boolean; testWeakened: boolean } {
  let dependencyChanged = changedFiles.some((f) =>
    LOCKFILE_BASENAMES.has(path.basename(f).toLowerCase()),
  );
  let secretFound = false;
  let testWeakened = false;

  const fileSections = diffText.split(/^diff --git /m).slice(1);
  for (const section of fileSections) {
    const lines = section.split("\n");
    const header = lines[0] ?? "";
    const matchPath = /^a\/(.+?)\s+b\/(.+)$/.exec(header.trim());
    const filePath = matchPath ? matchPath[2]! : "";
    const isTestFile = isTestFilePath(filePath);
    const isPackageJson = path.basename(filePath).toLowerCase() === "package.json";

    let removedAssertions = 0;
    let addedAssertions = 0;

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i]!;
      if (isTestFile && line.startsWith("deleted file mode")) {
        testWeakened = true;
      }

      if (line.startsWith("+") && !line.startsWith("+++ ")) {
        const content = line.slice(1);
        for (const pattern of LEAK_MARKER_PATTERNS) {
          if (pattern.test(content)) {
            secretFound = true;
            break;
          }
        }
        if (isTestFile) {
          if (introducesTestSkip(content)) {
            testWeakened = true;
          }
          if (isAssertionLine(content)) {
            addedAssertions += 1;
          }
        }
        if (
          isPackageJson &&
          /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"/.test(content)
        ) {
          dependencyChanged = true;
        }
      } else if (line.startsWith("-") && !line.startsWith("--- ")) {
        const content = line.slice(1);
        if (isTestFile && isAssertionLine(content)) {
          removedAssertions += 1;
        }
        if (
          isPackageJson &&
          /"(?:dependencies|devDependencies|peerDependencies|optionalDependencies)"/.test(content)
        ) {
          dependencyChanged = true;
        }
      }
    }

    // If package.json modified any version-like entry (e.g. `"foo": "^1.2.3"`), also flag dependencyChanged
    if (isPackageJson && !dependencyChanged) {
      for (const line of lines) {
        if (
          (line.startsWith("+") && !line.startsWith("+++ ")) ||
          (line.startsWith("-") && !line.startsWith("--- "))
        ) {
          const content = line.slice(1);
          if (/"[a-z0-9@/_.-]+"\s*:\s*"[\^~>=<*0-9]/.test(content)) {
            dependencyChanged = true;
            break;
          }
        }
      }
    }

    if (isTestFile && removedAssertions > addedAssertions) {
      testWeakened = true;
    }
  }

  return { dependencyChanged, secretFound, testWeakened };
}

/**
 * Extract deterministic StepSignals from git diff between baseSha and headSha
 * and check execution results, feeding evaluateStepJudgement in engine.ts.
 */
export async function extractGitDiffSignals(params: {
  repoRoot: string;
  baseSha: string;
  headSha: string;
  expectedHeadSha?: string;
  flow: FlowDefinition;
  checkResults?: readonly SingleCheckRunResult[];
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<StepSignals> {
  const timeoutMs = params.timeoutMs ?? 15_000;
  const resolvedRepo = path.resolve(params.repoRoot);

  let staleSha = false;
  if (params.expectedHeadSha && params.expectedHeadSha !== params.headSha) {
    staleSha = true;
  }

  const headExists = FlowGitShaRegex.test(params.headSha)
    ? await runBoundedProcessGroup("git", ["cat-file", "-e", `${params.headSha}^{commit}`], {
        cwd: resolvedRepo,
        timeoutMs,
        signal: params.signal,
      })
    : { code: 1, stdout: "", stderr: "", timedOut: false };

  if (headExists.code !== 0) {
    staleSha = true;
  }

  const leakScanFailed = Boolean(
    params.checkResults?.some((r) => r.checkId === "leak_scan" && !r.passed),
  );

  if (staleSha && headExists.code !== 0) {
    return {
      staleSha: true,
      ...(leakScanFailed ? { secretFound: true } : {}),
    };
  }

  const nameOnlyRes = await runBoundedProcessGroup(
    "git",
    ["diff", "--name-only", `${params.baseSha}..${params.headSha}`],
    { cwd: resolvedRepo, timeoutMs, signal: params.signal },
  );
  const changedFiles =
    nameOnlyRes.code === 0
      ? nameOnlyRes.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
      : [];

  const diffRes = await runBoundedProcessGroup(
    "git",
    ["diff", "-U0", `${params.baseSha}..${params.headSha}`],
    { cwd: resolvedRepo, timeoutMs, signal: params.signal },
  );
  const diffText = diffRes.code === 0 ? diffRes.stdout : "";

  const parsed = detectSignalsFromUnifiedDiff(changedFiles, diffText);

  void params.flow;

  return {
    changedFiles,
    filesChangedCount: changedFiles.length,
    ...(parsed.dependencyChanged ? { dependencyChanged: true } : {}),
    ...(staleSha ? { staleSha: true } : {}),
    ...(leakScanFailed || parsed.secretFound ? { secretFound: true } : {}),
    ...(parsed.testWeakened ? { testWeakened: true } : {}),
  };
}
