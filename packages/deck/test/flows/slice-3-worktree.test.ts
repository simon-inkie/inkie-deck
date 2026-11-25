import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FlowStepAdapter } from "../../app/lib/flows/adapter.server.js";
import { approveRun, planRun, runFlow } from "../../app/lib/flows/runner.server.js";
import {
  captureWorktreeOutcome,
  createEphemeralWorktree,
  rollbackWorktree,
  WorktreeError,
} from "../../app/lib/flows/worktree.server.js";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initTempGitRepo(repoDir: string): string {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "operator-1"]);
  git(repoDir, ["config", "user.email", "operator-1@example.invalid"]);
  fs.writeFileSync(path.join(repoDir, "README.md"), "base repo\n", "utf8");
  git(repoDir, ["add", "README.md"]);
  git(repoDir, ["commit", "-m", "initial commit"]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function listWorktrees(repoDir: string): string[] {
  const out = git(repoDir, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice("worktree ".length).trim());
}

const WORKTREE_FLOW_YAML = `flow: wt-test
version: 1
title: Worktree Isolation Test
workspace:
  kind: git-worktree
  base: main
roles:
  builder:
    runtime: pty
steps:
  - id: build
    type: agent
    role: builder
    outputs:
      - branch
      - head_sha
  - id: verify
    type: check
    against: build.head_sha
    run:
      - test
    on_fail:
      goto: build
`;

describe("Deck Flows Slice 3 - Ephemeral Git Worktree Isolation & Rollback", () => {
  let scratchRoot: string;
  let repoRoot: string;
  let worktreeBaseDir: string;
  let dataRoot: string;
  let baseSha: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-s3-wt-"));
    repoRoot = path.join(scratchRoot, "repo");
    worktreeBaseDir = path.join(scratchRoot, "worktrees");
    dataRoot = path.join(scratchRoot, "data");
    fs.mkdirSync(dataRoot, { recursive: true });
    baseSha = initTempGitRepo(repoRoot);
  });

  afterEach(() => {
    if (scratchRoot && fs.existsSync(scratchRoot)) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it("refuses worktreeBaseDir inside repoRoot", async () => {
    await expect(
      createEphemeralWorktree({
        repoRoot,
        baseRef: "main",
        worktreeBaseDir: path.join(repoRoot, ".worktrees"),
        runId: "run-wt-bad",
        stepId: "build",
        attemptId: "att-1",
      }),
    ).rejects.toThrow(WorktreeError);
  });

  it("creates isolated worktree, captures commit outcome, and rolls back idempotently", async () => {
    const handle = await createEphemeralWorktree({
      repoRoot,
      baseRef: "main",
      worktreeBaseDir,
      runId: "run-wt-1",
      stepId: "build",
      attemptId: "build_1",
    });

    expect(handle.baseSha).toBe(baseSha);
    expect(handle.branch).toBeDefined();
    expect(fs.existsSync(handle.worktreePath)).toBe(true);
    expect(listWorktrees(repoRoot)).toHaveLength(2);

    // Commit a change strictly inside the ephemeral worktree
    fs.writeFileSync(path.join(handle.worktreePath, "feature.txt"), "hello feature\n", "utf8");
    git(handle.worktreePath, ["add", "feature.txt"]);
    git(handle.worktreePath, ["commit", "-m", "add feature"]);

    // Main repo working tree MUST stay completely untouched
    expect(fs.existsSync(path.join(repoRoot, "feature.txt"))).toBe(false);
    expect(git(repoRoot, ["status", "--porcelain"])).toBe("");

    const outcome = await captureWorktreeOutcome(handle);
    expect(outcome.baseSha).toBe(baseSha);
    expect(outcome.headSha).not.toBe(baseSha);
    expect(outcome.isClean).toBe(true);
    expect(outcome.hasNewCommit).toBe(true);
    expect(outcome.changedFiles).toEqual(["feature.txt"]);

    // Roll back cleanly and verify idempotence even after partial/repeated deletion
    await rollbackWorktree(handle);
    expect(fs.existsSync(handle.worktreePath)).toBe(false);
    expect(listWorktrees(repoRoot)).toHaveLength(1);
    expect(git(repoRoot, ["status", "--porcelain"])).toBe("");
    const branches = git(repoRoot, ["branch", "--list", handle.branch!]);
    expect(branches).toBe("");

    // Second rollback call is cleanly idempotent
    await expect(rollbackWorktree(handle)).resolves.toBeUndefined();
  }, 15_000);

  it("rolls back dirty worktree cleanly on step timeout without dirtying repoRoot", async () => {
    const projectId = "proj-wt-timeout";
    const runId = "run-wt-timeout";
    const planned = planRun({ projectId, runId, flowYaml: WORKTREE_FLOW_YAML, dataRoot });
    approveRun({ projectId, runId, flowHash: planned.flowHash, actorId: "operator-1", dataRoot });

    const slowDirtyAdapter: FlowStepAdapter = {
      id: "slow-dirty-builder",
      runtimeKind: "stub",
      async dispatch(ctx) {
        fs.writeFileSync(path.join(ctx.worktreePath!, "dirty-uncommitted.txt"), "partial\n", "utf8");
        await new Promise((resolve) => setTimeout(resolve, 1500));
        return { kind: "agent", outputs: { status: "ok" } };
      },
    };

    const res = await runFlow(projectId, runId, {
      dataRoot,
      workspaceRepoRoot: repoRoot,
      worktreeRoot: worktreeBaseDir,
      stepTimeoutMs: 250,
      adapters: { builder: slowDirtyAdapter },
    });

    expect(res.finalStatus).toBe("stopped");
    expect(git(repoRoot, ["status", "--porcelain"])).toBe("");
    expect(listWorktrees(repoRoot)).toHaveLength(1);
    expect(fs.existsSync(path.join(repoRoot, "dirty-uncommitted.txt"))).toBe(false);
  }, 15_000);

  it("rewinds cleanly to a fresh base worktree without dirty compounding across attempts", async () => {
    const projectId = "proj-wt-rewind";
    const runId = "run-wt-rewind";
    const planned = planRun({ projectId, runId, flowYaml: WORKTREE_FLOW_YAML, dataRoot });
    approveRun({ projectId, runId, flowHash: planned.flowHash, actorId: "operator-1", dataRoot });

    const observedFilesByAttempt: string[][] = [];

    const builderAdapter: FlowStepAdapter = {
      id: "rewind-builder",
      runtimeKind: "stub",
      async dispatch(ctx) {
        const wt = ctx.worktreePath!;
        const existingFiles = fs.readdirSync(wt).filter((f) => f !== ".git").sort();
        observedFilesByAttempt.push(existingFiles);

        const filename = ctx.occurrence === 1 ? "attempt1.txt" : "attempt2.txt";
        fs.writeFileSync(path.join(wt, filename), `attempt ${ctx.occurrence}\n`, "utf8");
        git(wt, ["add", filename]);
        git(wt, ["commit", "-m", `attempt ${ctx.occurrence}`]);
        const headSha = git(wt, ["rev-parse", "HEAD"]);
        return { kind: "agent", outputs: { head_sha: headSha } };
      },
    };

    let checkCalls = 0;
    const res = await runFlow(projectId, runId, {
      dataRoot,
      workspaceRepoRoot: repoRoot,
      worktreeRoot: worktreeBaseDir,
      adapters: { builder: builderAdapter },
      checkCommands: {
        test: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      },
      onCheckRun: () => {
        checkCalls += 1;
        return { passed: checkCalls >= 2, errorClass: checkCalls === 1 ? "first_try_fail" : undefined };
      },
    });

    expect(res.finalStatus).toBe("finished");
    expect(res.terminalOutcome).toBe("done");
    // Attempt 2 started cleanly from baseSha (ONLY README.md, NO attempt1.txt!)
    expect(observedFilesByAttempt).toEqual([["README.md"], ["README.md"]]);
    expect(git(repoRoot, ["status", "--porcelain"])).toBe("");
    expect(listWorktrees(repoRoot)).toHaveLength(1);
  }, 20_000);
});
