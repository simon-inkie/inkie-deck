import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAcpFixtureFlowAdapter,
  createPtyFixtureFlowAdapter,
  FlowRoleConflictError,
  resolveRoleAdapters,
  type FlowStepAdapter,
} from "../../app/lib/flows/adapter.server.js";
import {
  extractGitDiffSignals,
  runAllowlistedCheck,
  runReproCheck,
} from "../../app/lib/flows/checks.server.js";
import { evaluateStepJudgement } from "../../app/lib/flows/engine.js";
import { loadFlowDefinition } from "../../app/lib/flows/library.server.js";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import { approveRun, planRun, runFlow } from "../../app/lib/flows/runner.server.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PTY_FIXTURE_PATH = path.resolve(THIS_DIR, "../runner/fixture-agent.mjs");
const ACP_FIXTURE_PATH = path.resolve(THIS_DIR, "../fixtures/acp-agent.mjs");

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initTempGitRepo(repoDir: string): string {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "operator-1"]);
  git(repoDir, ["config", "user.email", "operator-1@example.invalid"]);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "test"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify({ name: "sample-app", version: "1.0.0", dependencies: { lodash: "^4.17.21" } }, null, 2) + "\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "src", "math.mjs"),
    "export function add(a, b) {\n  return a - b;\n}\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "test", "existing.test.mjs"),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('existing', () => {\n  assert.strictEqual(1 + 1, 2);\n  assert.strictEqual(2 + 2, 4);\n});\n",
    "utf8",
  );
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "initial commit"]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

describe("Deck Flows Slice 3 - PTY/ACP Fixture Adapters, Differs-From, Repro & Git-Diff Signals", () => {
  let scratchRoot: string;
  let repoRoot: string;
  let worktreeBaseDir: string;
  let dataRoot: string;
  let baseSha: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-s3-ac-"));
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

  it("dispatches 153 PTY fixture via PtyRunner and 154 ACP fixture via AcpSession", async () => {
    const ptyAdapter = createPtyFixtureFlowAdapter({
      id: "pty-builder-1",
      args: [PTY_FIXTURE_PATH, "registry"],
      cwd: repoRoot,
      input: "hello-flow\rexit\r",
      parseResult: (output) => ({
        kind: "agent",
        outputs: { status: "ok" },
        artifactBytes: Buffer.from(output, "utf8"),
        tokensUsed: 42,
      }),
    });

    const acpAdapter = createAcpFixtureFlowAdapter({
      id: "acp-reviewer-1",
      scriptPath: ACP_FIXTURE_PATH,
      cwd: repoRoot,
      script: {
        prompts: [
          [
            {
              kind: "update",
              update: {
                sessionUpdate: "agent_message_chunk",
                content: {
                  type: "text",
                  text: 'FLOW_RESULT:{"kind":"handoff","verdict":"approve","actorId":"reviewer-1","note":"Looks good"}\n',
                },
              },
            },
            { kind: "result", result: { stopReason: "end_turn" } },
          ],
        ],
      },
    });

    const controller = new AbortController();
    const ptyRes = await ptyAdapter.dispatch({
      runId: "run-pty-1",
      step: { id: "build", type: "agent", role: "builder" },
      attemptId: "build_1",
      occurrence: 1,
      roleName: "builder",
      runtime: "pty",
      previousOutputs: {},
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    expect(ptyRes.kind).toBe("agent");
    if (ptyRes.kind === "agent") {
      expect(ptyRes.artifactBytes?.toString("utf8")).toContain("INPUT hello-flow");
      expect(ptyRes.tokensUsed).toBe(42);
    }

    const acpRes = await acpAdapter.dispatch({
      runId: "run-acp-1",
      step: { id: "review", type: "handoff", to: "reviewer", returns: { verdict: ["approve", "changes", "comment"] } },
      attemptId: "review_1",
      occurrence: 1,
      roleName: "reviewer",
      runtime: "acp",
      previousOutputs: {},
      signal: controller.signal,
      timeoutMs: 10_000,
    });
    expect(acpRes.kind).toBe("handoff");
    if (acpRes.kind === "handoff") {
      expect(acpRes.verdict).toBe("approve");
      expect(acpRes.actorId).toBe("reviewer-1");
    }
  }, 20_000);

  it("enforces roles.<name>.differs_from and rejects shared adapter identities", async () => {
    const ticketFlow = loadFlowDefinition("ticket-to-pr", { dataRoot });
    const sharedAdapter: FlowStepAdapter = {
      id: "shared-agent",
      identity: "same-runtime-id",
      runtimeKind: "pty",
      async dispatch() {
        return { kind: "agent", outputs: { status: "ok" } };
      },
    };
    const aliasAdapter: FlowStepAdapter = {
      id: "reviewer-wrapper",
      identity: "same-runtime-id",
      runtimeKind: "acp",
      async dispatch() {
        return { kind: "handoff", verdict: "approve" };
      },
    };

    expect(() =>
      resolveRoleAdapters(ticketFlow.flow, {
        builder: sharedAdapter,
        reviewer: sharedAdapter,
      }),
    ).toThrow(FlowRoleConflictError);

    expect(() =>
      resolveRoleAdapters(ticketFlow.flow, {
        builder: sharedAdapter,
        reviewer: aliasAdapter,
      }),
    ).toThrow(FlowRoleConflictError);

    // Also enforced up front inside runFlow before dispatching any step
    const projectId = "proj-differs";
    const runId = "run-differs-1";
    const planned = planRun({ projectId, runId, flowYaml: ticketFlow.yaml, dataRoot });
    approveRun({ projectId, runId, flowHash: planned.flowHash, actorId: "operator-1", dataRoot });

    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        adapters: { builder: sharedAdapter, reviewer: aliasAdapter },
      }),
    ).rejects.toThrow(FlowRoleConflictError);
  }, 15_000);

  it("kills PTY child and SIGTERM-ignoring descendant PIDs cleanly on timeout (zero orphan PIDs)", async () => {
    let spawnedPtyPid: number | undefined;
    let descendantPid: number | undefined;

    const ptyDescendantAdapter = createPtyFixtureFlowAdapter({
      id: "pty-descendant-timeout",
      args: [PTY_FIXTURE_PATH, "registry"],
      cwd: scratchRoot,
      input: "descendant\r",
      onSpawn: (pid) => {
        spawnedPtyPid = pid;
      },
      parseResult: (output) => ({
        kind: "agent",
        outputs: { status: "ok" },
        artifactBytes: Buffer.from(output, "utf8"),
      }),
    });

    const controller = new AbortController();
    const dispatchPromise = ptyDescendantAdapter.dispatch({
      runId: "run-orphan-check",
      step: { id: "build", type: "agent" },
      attemptId: "build_1",
      occurrence: 1,
      previousOutputs: {},
      signal: controller.signal,
      timeoutMs: 5_000,
    });

    // Wait for fixture-agent.mjs to create descendant-<pid> marker file in scratchRoot
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline && descendantPid === undefined) {
      const files = fs.readdirSync(scratchRoot);
      const marker = files.find((f) => f.startsWith("descendant-"));
      if (marker) {
        descendantPid = Number(marker.slice("descendant-".length));
        break;
      }
      await new Promise((r) => setTimeout(r, 30));
    }

    expect(spawnedPtyPid).toBeTypeOf("number");
    expect(descendantPid).toBeTypeOf("number");
    expect(isPidAlive(descendantPid!)).toBe(true);

    // Abort (simulating step timeout) and assert both PTY child and descendant are killed
    controller.abort();
    await expect(dispatchPromise).rejects.toThrow(/aborted/i);

    await new Promise((r) => setTimeout(r, 200));
    expect(isPidAlive(spawnedPtyPid!)).toBe(false);
    expect(isPidAlive(descendantPid!)).toBe(false);
  }, 15_000);

  it("verifies repro fail-on-base / pass-on-head and refuses non-failing-on-base or failing-on-head tests", async () => {
    // 1. Valid fix + repro test: fails on base (a - b), passes on head (a + b)
    fs.writeFileSync(
      path.join(repoRoot, "src", "math.mjs"),
      "export function add(a, b) {\n  return a + b;\n}\n",
      "utf8",
    );
    fs.writeFileSync(
      path.join(repoRoot, "test", "repro-add.test.mjs"),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { add } from '../src/math.mjs';\ntest('add sums inputs', () => {\n  assert.strictEqual(add(2, 3), 5);\n});\n",
      "utf8",
    );
    git(repoRoot, ["add", "src/math.mjs", "test/repro-add.test.mjs"]);
    git(repoRoot, ["commit", "-m", "fix add with repro test"]);
    const goodHeadSha = git(repoRoot, ["rev-parse", "HEAD"]);

    const goodRepro = await runReproCheck({
      repoRoot,
      worktreeBaseDir,
      baseSha,
      headSha: goodHeadSha,
      reproTestPath: "test/repro-add.test.mjs",
      timeoutMs: 10_000,
    });
    expect(goodRepro.passed).toBe(true);
    expect(goodRepro.failedOnBase).toBe(true);
    expect(goodRepro.passedOnHead).toBe(true);

    // 2. Tautological repro test that passes even on baseSha MUST fail repro verification
    fs.writeFileSync(
      path.join(repoRoot, "test", "repro-always-pass.test.mjs"),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('always passes', () => {\n  assert.strictEqual(1, 1);\n});\n",
      "utf8",
    );
    git(repoRoot, ["add", "test/repro-always-pass.test.mjs"]);
    git(repoRoot, ["commit", "-m", "add weak repro"]);
    const weakHeadSha = git(repoRoot, ["rev-parse", "HEAD"]);

    const badBaseRepro = await runReproCheck({
      repoRoot,
      worktreeBaseDir,
      baseSha,
      headSha: weakHeadSha,
      reproTestPath: "test/repro-always-pass.test.mjs",
      timeoutMs: 10_000,
    });
    expect(badBaseRepro.passed).toBe(false);
    expect(badBaseRepro.failedOnBase).toBe(false);
    expect(badBaseRepro.reason).toBe("repro_did_not_fail_on_base");

    // Verify shell commands are forbidden in allowlisted check runner
    await expect(
      runAllowlistedCheck({
        checkId: "test",
        cwd: repoRoot,
        checkCommands: { test: { command: "sh", args: ["-c", "echo nope"] } },
        timeoutMs: 5_000,
      }),
    ).rejects.toThrow(/Shell command.*forbidden/i);

    // Verify zero worktrees leaked
    const wtList = git(repoRoot, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "));
    expect(wtList).toHaveLength(1);
  }, 20_000);

  it("extracts real git-diff signals driving engine judgements: protected_path_touched, secret_found, test_weakened, stale_sha", async () => {
    const ticketFlow = loadFlowDefinition("ticket-to-pr", { dataRoot }).flow;
    const buildStep = ticketFlow.steps.find((s) => s.id === "build")!;
    const verifyStep = ticketFlow.steps.find((s) => s.id === "verify")!;

    // 1. protected_path_touched -> decide
    fs.mkdirSync(path.join(repoRoot, ".github", "workflows"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, ".github", "workflows", "ci.yml"), "name: ci\n", "utf8");
    git(repoRoot, ["add", ".github/workflows/ci.yml"]);
    git(repoRoot, ["commit", "-m", "touch workflow"]);
    const protectedSha = git(repoRoot, ["rev-parse", "HEAD"]);

    const protectedSignals = await extractGitDiffSignals({
      repoRoot,
      baseSha,
      headSha: protectedSha,
      flow: ticketFlow,
    });
    expect(protectedSignals.changedFiles).toContain(".github/workflows/ci.yml");
    const protectedDecision = evaluateStepJudgement({
      flow: ticketFlow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: protectedSignals,
    });
    expect(protectedDecision.final).toBe("decide");
    expect(protectedDecision.ruleHits).toContain("protected_path_touched");

    // 2. secret_found -> stop (assembled dynamically so static scanners never flag test source)
    git(repoRoot, ["reset", "--hard", baseSha]);
    const syntheticLeakHeader = ["-----BEGIN", "PRIVATE", "KEY-----"].join(" ");
    fs.writeFileSync(path.join(repoRoot, "src", "leak.txt"), `${syntheticLeakHeader}\n`, "utf8");
    git(repoRoot, ["add", "src/leak.txt"]);
    git(repoRoot, ["commit", "-m", "add synthetic leak marker"]);
    const leakSha = git(repoRoot, ["rev-parse", "HEAD"]);

    const leakSignals = await extractGitDiffSignals({
      repoRoot,
      baseSha,
      headSha: leakSha,
      flow: ticketFlow,
    });
    expect(leakSignals.secretFound).toBe(true);
    const leakDecision = evaluateStepJudgement({
      flow: ticketFlow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 2 },
      signals: leakSignals,
    });
    expect(leakDecision.final).toBe("stop");
    expect(leakDecision.ruleHits).toContain("secret_found");

    // 3. test_weakened -> stop
    git(repoRoot, ["reset", "--hard", baseSha]);
    fs.writeFileSync(
      path.join(repoRoot, "test", "existing.test.mjs"),
      "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest.skip('existing', () => {\n  assert.strictEqual(1 + 1, 2);\n});\n",
      "utf8",
    );
    git(repoRoot, ["add", "test/existing.test.mjs"]);
    git(repoRoot, ["commit", "-m", "weaken existing test"]);
    const weakenedSha = git(repoRoot, ["rev-parse", "HEAD"]);

    const weakSignals = await extractGitDiffSignals({
      repoRoot,
      baseSha,
      headSha: weakenedSha,
      flow: ticketFlow,
    });
    expect(weakSignals.testWeakened).toBe(true);
    const weakDecision = evaluateStepJudgement({
      flow: ticketFlow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 2 },
      signals: weakSignals,
    });
    expect(weakDecision.final).toBe("stop");
    expect(weakDecision.ruleHits).toContain("test_weakened");

    // 4. stale_sha -> notify (with verify rule `stale_sha: notify`)
    git(repoRoot, ["reset", "--hard", baseSha]);
    fs.writeFileSync(path.join(repoRoot, "src", "clean.txt"), "clean\n", "utf8");
    git(repoRoot, ["add", "src/clean.txt"]);
    git(repoRoot, ["commit", "-m", "clean change"]);
    const cleanSha = git(repoRoot, ["rev-parse", "HEAD"]);

    const staleSignals = await extractGitDiffSignals({
      repoRoot,
      baseSha,
      headSha: cleanSha,
      expectedHeadSha: "0".repeat(40),
      flow: ticketFlow,
    });
    expect(staleSignals.staleSha).toBe(true);
    const staleDecision = evaluateStepJudgement({
      flow: ticketFlow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 2 },
      signals: staleSignals,
    });
    expect(staleDecision.final).toBe("notify");
    expect(staleDecision.ruleHits).toContain("stale_sha");
    expect(staleDecision.shouldRerunCheck).toBe(true);

    // 5. Verify protected_path_touched triggers waiting_decision inside full runFlow too
    const projectId = "proj-sig-run";
    const runId = "run-sig-1";
    const miniYaml = `flow: sig-check
version: 1
workspace:
  kind: git-worktree
  base: main
protected_paths:
  - ".github/**"
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
    rules:
      - protected_path_touched: decide
`;
    const planned = planRun({ projectId, runId, flowYaml: miniYaml, dataRoot });
    approveRun({ projectId, runId, flowHash: planned.flowHash, actorId: "operator-1", dataRoot });

    const touchingBuilder: FlowStepAdapter = {
      id: "builder-touch-protected",
      runtimeKind: "stub",
      async dispatch(ctx) {
        const wt = ctx.worktreePath!;
        fs.mkdirSync(path.join(wt, ".github", "workflows"), { recursive: true });
        fs.writeFileSync(path.join(wt, ".github", "workflows", "release.yml"), "name: rel\n", "utf8");
        git(wt, ["add", ".github/workflows/release.yml"]);
        git(wt, ["commit", "-m", "touch protected workflow"]);
        const sha = git(wt, ["rev-parse", "HEAD"]);
        return { kind: "agent", outputs: { head_sha: sha } };
      },
    };

    const runRes = await runFlow(projectId, runId, {
      dataRoot,
      workspaceRepoRoot: repoRoot,
      worktreeRoot: worktreeBaseDir,
      adapters: { builder: touchingBuilder },
    });
    expect(runRes.finalStatus).toBe("waiting_decision");
    const loaded = loadRunState(projectId, runId, { dataRoot });
    expect(loaded.state.activeDecision?.reasonCode).toBe("protected_path_touched");
  }, 20_000);
});
