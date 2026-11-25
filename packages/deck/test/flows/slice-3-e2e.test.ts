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
const ACP_FIXTURE_PATH = path.resolve(THIS_DIR, "../fixtures/acp-agent.mjs");

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
    "export function multiply(a, b) {\n  return a + b;\n}\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(repoDir, "test", "smoke.test.mjs"),
    "import assert from 'node:assert/strict';\nimport test from 'node:test';\ntest('smoke', () => {\n  assert.strictEqual(2 + 2, 4);\n});\n",
    "utf8",
  );

  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "initial buggy repo"]);
  return git(repoDir, ["rev-parse", "HEAD"]);
}

function writeBuilderPtyScript(scriptPath: string): void {
  const script = `
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const wt = process.env.FLOW_WORKTREE_PATH || process.cwd();
const occ = Number(process.env.FLOW_OCCURRENCE || "1");

const reproPath = "test/repro-multiply.test.mjs";
const reproCode = [
  "import assert from 'node:assert/strict';",
  "import test from 'node:test';",
  "import { multiply } from '../src/calc.mjs';",
  "test('multiply multiplies inputs', () => {",
  "  assert.strictEqual(multiply(3, 4), 12);",
  "});",
  "",
].join("\\n");

fs.mkdirSync(path.join(wt, "test"), { recursive: true });
fs.writeFileSync(path.join(wt, reproPath), reproCode, "utf8");

if (occ === 1) {
  // First attempt introduces a still-wrong fix so verify fails and rewinds cleanly
  fs.writeFileSync(
    path.join(wt, "src", "calc.mjs"),
    "export function multiply(a, b) {\\n  return a + b + 1;\\n}\\n",
    "utf8",
  );
} else if (occ === 2) {
  // Second attempt fixes multiply correctly; reviewer will request a comment polish ("changes")
  fs.writeFileSync(
    path.join(wt, "src", "calc.mjs"),
    "export function multiply(a, b) {\\n  return a * b;\\n}\\n",
    "utf8",
  );
} else {
  // Third attempt after reviewer changes: clean documented fix
  fs.writeFileSync(
    path.join(wt, "src", "calc.mjs"),
    "// Multiply two numbers\\nexport function multiply(a, b) {\\n  return a * b;\\n}\\n",
    "utf8",
  );
}

execFileSync("git", ["add", "src/calc.mjs", reproPath], { cwd: wt });
execFileSync("git", ["commit", "-m", "build attempt " + occ], { cwd: wt });
const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: wt, encoding: "utf8" }).trim();

process.stdout.write("PTY BUILDER READY\\n");
process.stdout.write(
  "FLOW_RESULT:" + JSON.stringify({
    kind: "agent",
    outputs: { head_sha: headSha, repro_test: reproPath },
    tokensUsed: 120,
  }) + "\\n",
);
process.exit(0);
`;
  fs.writeFileSync(scriptPath, script, "utf8");
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
  let builderScriptPath: string;
  let prevInboxRoot: string | undefined;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-s3-e2e-"));
    repoRoot = path.join(scratchRoot, "repo");
    worktreeBaseDir = path.join(scratchRoot, "worktrees");
    dataRoot = path.join(scratchRoot, "data");
    inboxRoot = path.join(scratchRoot, "inbox");
    builderScriptPath = path.join(scratchRoot, "pty-builder-fixture.mjs");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(path.join(inboxRoot, "deck-flow", "inbox"), { recursive: true });
    prevInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = inboxRoot;
    __resetInboxCaches();
    initBuggyTempRepo(repoRoot);
    writeBuilderPtyScript(builderScriptPath);
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

    const ptyBuilder = createPtyFixtureFlowAdapter({
      id: "pty-builder-fixture",
      args: [builderScriptPath],
    });

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
      typecheck: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      test: { command: process.execPath, args: ["--test", "test/smoke.test.mjs"] },
      lint: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      leak_scan: { command: process.execPath, args: ["-e", "process.exit(0)"] },
      build: { command: process.execPath, args: ["-e", "process.exit(0)"] },
    };

    const runOptions = {
      dataRoot,
      inbox,
      workspaceRepoRoot: repoRoot,
      worktreeRoot: worktreeBaseDir,
      stepTimeoutMs: 15_000,
      adapters: {
        builder: ptyBuilder,
        reviewer: acpReviewer,
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
    expect(atReady.state.stepStates["build"]?.outputs["repro_test"]).toBe(
      "test/repro-multiply.test.mjs",
    );
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

    const ptyBuilder = createPtyFixtureFlowAdapter({
      id: "pty-draft-builder",
      args: [builderScriptPath],
    });

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
