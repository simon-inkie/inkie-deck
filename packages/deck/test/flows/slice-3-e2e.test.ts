import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createAcpFixtureFlowAdapter,
  createPtyFixtureFlowAdapter,
} from "../../app/lib/flows/adapter.server.js";
import {
  loadFlowDefinition,
  saveFlowDraft,
} from "../../app/lib/flows/library.server.js";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import {
  approveRun,
  planRun,
  runFlow,
} from "../../app/lib/flows/runner.server.js";
import { __resetInboxCaches, FileInboxRepository } from "../../app/lib/inbox.server.js";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const PTY_FIXTURE_PATH = path.resolve(THIS_DIR, "../runner/fixture-agent.mjs");
const ACP_FIXTURE_PATH = path.resolve(THIS_DIR, "../fixtures/acp-agent.mjs");
const TSC_PATH = fileURLToPath(import.meta.resolve("typescript/bin/tsc"));
const LEAK_GATE_PATH = path.resolve(THIS_DIR, "../../../../scripts/leak-gate.mjs");
const REPRO_TEST_PATH = "test/repro-multiply.test.mjs";
const MULTIPLY_TYPES = "/** @param {number} a @param {number} b */\n";

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function initBuggyTempRepo(repoDir: string): string {
  fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["config", "user.name", "operator-1"]);
  git(repoDir, ["config", "user.email", "operator-1@example.invalid"]);
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.mkdirSync(path.join(repoDir, "test"), { recursive: true });

  // Buggy implementation: multiply returns a + b instead of a * b
  fs.writeFileSync(
    path.join(repoDir, "src", "calc.mjs"),
    `${MULTIPLY_TYPES}export function multiply(a, b) {\n  return a + b;\n}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "test", "smoke.test.mjs"),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\nimport { multiply } from '../src/calc.mjs';\ntest('multiply returns a number', () => {\n  assert.strictEqual(typeof multiply(2, 3), 'number');\n});\n",
    "utf8",
  );

  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "initial buggy repo"]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function createBuilderFixture(id: string) {
  return createPtyFixtureFlowAdapter({
    id,
    args: [PTY_FIXTURE_PATH, "registry"],
    input: (ctx) => `build attempt ${ctx.occurrence}\rexit\r`,
    parseResult: (output, { occurrence, worktreePath }) => {
      if (!worktreePath || !output.split("\n").includes(`INPUT build attempt ${occurrence}`)) {
        throw new Error("PTY fixture did not acknowledge the build attempt in a worktree");
      }

      const reproCode = [
        "import assert from 'node:assert/strict';",
        "import test from 'node:test';",
        "import { multiply } from '../src/calc.mjs';",
        "test('multiply multiplies inputs', () => {",
        "  assert.strictEqual(multiply(3, 4), 12);",
        "});",
        "",
      ].join("\n");
      // The first attempt fails repro. The third addresses the reviewer's comment.
      const expression = occurrence === 1 ? "a + b + 1" : "a * b";
      const comment = occurrence >= 3 ? "// Multiply two numbers\n" : "";
      fs.writeFileSync(path.join(worktreePath, REPRO_TEST_PATH), reproCode, "utf8");
      fs.writeFileSync(
        path.join(worktreePath, "src/calc.mjs"),
        `${comment}${MULTIPLY_TYPES}export function multiply(a, b) {\n  return ${expression};\n}\n`,
        "utf8",
      );
      git(worktreePath, ["add", "src/calc.mjs", REPRO_TEST_PATH]);
      git(worktreePath, ["commit", "-m", `build attempt ${occurrence}`]);

      return {
        kind: "agent",
        outputs: { head_sha: git(worktreePath, ["rev-parse", "HEAD"]), repro_test: REPRO_TEST_PATH },
        tokensUsed: 120,
      };
    },
  });
}

async function answerActiveHandoffCard(
  repo: FileInboxRepository,
  agentName: string,
  participantName: string,
  handoffId: string,
  choiceKey: string,
): Promise<void> {
  await repo.answerCard(agentName, participantName, handoffId, choiceKey);
}

describe("Deck Flows Slice 3 - End-to-End Example A (ticket-to-pr) & Drafted Flow", () => {
  let scratchRoot: string;
  let repoRoot: string;
  let worktreeBaseDir: string;
  let dataRoot: string;
  let inboxRoot: string;
  let prevInboxRoot: string | undefined;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-s3-e2e-"));
    repoRoot = path.join(scratchRoot, "repo");
    worktreeBaseDir = path.join(scratchRoot, "worktrees");
    dataRoot = path.join(scratchRoot, "data");
    inboxRoot = path.join(scratchRoot, "inbox");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(path.join(inboxRoot, "deck-flow", "inbox"), { recursive: true });
    prevInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = inboxRoot;
    __resetInboxCaches();
    initBuggyTempRepo(repoRoot);
  });

  afterEach(() => {
    if (prevInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = prevInboxRoot;
    }
    __resetInboxCaches();
    if (scratchRoot && fs.existsSync(scratchRoot)) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it("runs Example A (flows/library/ticket-to-pr.yaml) end-to-end with PTY builder, repro check rewind, ACP reviewer rewind, and always:decide ready gate", async () => {
    const projectId = "proj-e2e-ticket-to-pr";
    const runId = "run-e2e-1";
    const agentName = "deck-flow";
    const participantName = "operator-1";
    const inboxRepo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo: inboxRepo };

    const loadedDef = loadFlowDefinition("ticket-to-pr", { dataRoot });
    expect(loadedDef.source).toBe("builtin");

    // 1. Plan run -> verify unapproved refused -> approve run with exact flowHash
    const planned = planRun({
      projectId,
      runId,
      flowYaml: loadedDef.yaml,
      source: loadedDef.source,
      dataRoot,
    });
    await expect(runFlow(projectId, runId, { dataRoot })).rejects.toThrow(/not approved/i);

    approveRun({
      projectId,
      runId,
      flowHash: planned.flowHash,
      actorId: "operator-1",
      dataRoot,
    });

    const ptyBuilder = createBuilderFixture("pty-builder-fixture");

    const acpReviewer = createAcpFixtureFlowAdapter({
      id: "acp-reviewer-fixture",
      scriptPath: ACP_FIXTURE_PATH,
      cwd: repoRoot,
      script: (ctx) => {
        const verdict = ctx.occurrence === 1 ? "changes" : "approve";
        return {
          prompts: [
            [
              {
                kind: "update",
                update: {
                  sessionUpdate: "agent_message_chunk",
                  content: {
                    type: "text",
                    text: `FLOW_RESULT:${JSON.stringify({
                      kind: "handoff",
                      verdict,
                      actorId: "reviewer-1",
                      note:
                        verdict === "changes"
                          ? "Please add a short comment above multiply"
                          : "Verified clean fix and repro test",
                    })}\n`,
                  },
                },
              },
              { kind: "result", result: { stopReason: "end_turn" } },
            ],
          ],
        };
      },
    });

    const checkCommands = {
      typecheck: {
        command: process.execPath,
        args: [TSC_PATH, "--allowJs", "--checkJs", "--strict", "--noEmit", "--target", "es2022", "src/calc.mjs"],
      },
      test: { command: process.execPath, args: ["--test", "test/smoke.test.mjs"] },
      lint: { command: "git", args: ["diff", "--check", "HEAD^", "HEAD"] },
      leak_scan: {
        command: process.execPath,
        args: [LEAK_GATE_PATH, "src/calc.mjs", "test/smoke.test.mjs", REPRO_TEST_PATH],
      },
      build: {
        command: process.execPath,
        args: [TSC_PATH, "--allowJs", "--outDir", "dist", "--target", "es2022", "src/calc.mjs"],
      },
    };

    const runOptions = {
      dataRoot,
      inbox,
      workspaceRepoRoot: repoRoot,
      worktreeRoot: worktreeBaseDir,
      stepTimeoutMs: 15_000,
      adaptersByRuntime: {
        pty: ptyBuilder,
        acp: acpReviewer,
      },
      checkCommands,
    };

    // 2. Start run -> pauses at intake decision card
    const intakeRes = await runFlow(projectId, runId, runOptions);
    expect(intakeRes.finalStatus).toBe("waiting_decision");
    const afterIntake = loadRunState(projectId, runId, { dataRoot });
    expect(afterIntake.state.activeHandoff?.stepId).toBe("intake");

    // 3. Human answers intake -> start
    await answerActiveHandoffCard(
      inboxRepo,
      agentName,
      participantName,
      afterIntake.state.activeHandoff!.handoffId,
      "start",
    );

    // 4. Resume -> build(1) -> verify(1 fails repro on head -> rewind) -> build(2) -> verify(2 passes repro!)
    //    -> review(1 ACP returns changes -> rewind) -> build(3) -> verify(3 passes) -> review(2 ACP approves)
    //    -> ready (always: decide human gate, NEVER pushes or merges!)
    const readyRes = await runFlow(projectId, runId, runOptions);
    expect(readyRes.finalStatus).toBe("waiting_decision");

    const atReady = loadRunState(projectId, runId, { dataRoot });
    expect(atReady.state.activeHandoff?.stepId).toBe("ready");
    expect(atReady.state.activeHandoff?.alwaysDecide).toBe(true);
    expect(atReady.state.rewindsUsed).toBe(2);
    expect(atReady.state.stepStates["build"]?.occurrence).toBe(3);
    expect(atReady.state.stepStates["verify"]?.occurrence).toBe(3);
    expect(atReady.state.stepStates["review"]?.occurrence).toBe(2);

    // Main repository working tree MUST be completely clean with zero leaked worktrees
    expect(git(repoRoot, ["status", "--porcelain"])).toBe("");
    const worktreesAtReady = git(repoRoot, ["worktree", "list", "--porcelain"])
      .split("\n")
      .filter((l) => l.startsWith("worktree "));
    expect(worktreesAtReady).toHaveLength(1);

    // Confirm repro_test and head_sha recorded in build outputs
    expect(atReady.state.stepStates["build"]?.outputs["repro_test"]).toBe(REPRO_TEST_PATH);
    expect(atReady.state.stepStates["build"]?.outputs["head_sha"]).toMatch(/^[a-f0-9]{40}$/);

    // 5. Human answers ready gate -> open-pr-myself (ends run cleanly as done)
    await answerActiveHandoffCard(
      inboxRepo,
      agentName,
      participantName,
      atReady.state.activeHandoff!.handoffId,
      "open-pr-myself",
    );
    const doneRes = await runFlow(projectId, runId, runOptions);
    expect(doneRes.finalStatus).toBe("finished");
    expect(doneRes.terminalOutcome).toBe("done");

    // Replay verification
    const finalLoaded = loadRunState(projectId, runId, { dataRoot });
    expect(finalLoaded.state.status).toBe("finished");
    expect(finalLoaded.state.terminalOutcome).toBe("done");
    expect(finalLoaded.events.some((e) => e.type === "flow_approved")).toBe(true);
    expect(finalLoaded.events.filter((e) => e.type === "step_rewound")).toHaveLength(2);
    const verifyResults = finalLoaded.events.flatMap((e) =>
      e.type === "check_result" && e.stepId === "verify" ? [e.data] : [],
    );
    expect(verifyResults.map((result) => result.passed)).toEqual([false, true, true]);
    expect(verifyResults[0]?.checkId).toBe("repro");
  }, 45_000);

  it("drafts a custom flow from template, diffs it, plans, approves, and runs to done", async () => {
    const projectId = "proj-e2e-draft";
    const runId = "run-e2e-draft-1";

    const customDraftYaml = `flow: quick-check
version: 1
title: Quick Custom Check Flow
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
      - repro_test
  - id: verify
    type: check
    against: build.head_sha
    run:
      - test
    repro:
      test:
        from: build.repro_test
      fail_on: base
      pass_on: head
    on_fail:
      goto: build
`;

    const saved = saveFlowDraft({
      projectRoot: repoRoot,
      draftName: "quick-check",
      yaml: customDraftYaml,
      baseTemplateRef: "ticket-to-pr",
      dataRoot,
    });
    expect(saved.diffFromTemplate).toContain("--- builtin/ticket-to-pr.yaml");
    expect(saved.diffFromTemplate).toContain("+++ drafts/quick-check.yaml");
    expect(saved.diffFromTemplate).toContain("+flow: quick-check");

    const planned = planRun({
      projectId,
      runId,
      flowYaml: fs.readFileSync(saved.path, "utf8"),
      source: "project",
      dataRoot,
    });
    approveRun({
      projectId,
      runId,
      flowHash: planned.flowHash,
      actorId: "operator-1",
      dataRoot,
    });

    const ptyBuilder = createBuilderFixture("pty-draft-builder");

    const res = await runFlow(projectId, runId, {
      dataRoot,
      workspaceRepoRoot: repoRoot,
      worktreeRoot: worktreeBaseDir,
      stepTimeoutMs: 15_000,
      adapters: { builder: ptyBuilder },
      checkCommands: {
        test: { command: process.execPath, args: ["--test", "test/smoke.test.mjs"] },
      },
    });

    expect(res.finalStatus).toBe("finished");
    expect(res.terminalOutcome).toBe("done");
    const finalState = loadRunState(projectId, runId, { dataRoot });
    expect(finalState.state.status).toBe("finished");
    expect(finalState.state.rewindsUsed).toBe(1);
    expect(git(repoRoot, ["worktree", "list", "--porcelain"]).split("\n").filter((l) => l.startsWith("worktree "))).toHaveLength(1);
  }, 30_000);
});
