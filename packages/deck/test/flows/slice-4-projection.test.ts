import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFlowProgress } from "../../app/lib/flows/importer.server.js";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import { projectFlowProgress, type FlowProjectionTarget } from "../../app/lib/flows/projection.server.js";
import { readFlowCardStream } from "../../app/lib/flows/reader.server.js";
import { approveRun, planRun, runFlow, submitHandoffReturn } from "../../app/lib/flows/runner.server.js";
import { canonicalJsonStringify, ImportedFlowReadOnlyError, openFlowsStore } from "../../app/lib/flows/store.server.js";
import type { FlowArtefactRecordedEvent } from "../../app/lib/flows/types.js";
import { action } from "../../app/routes/api.flows.js";

const flowYaml = fs.readFileSync(new URL("./fixtures/two-step-stub.yaml", import.meta.url), "utf8");
const relativeLedger = ".deck/runs/run-1/events.jsonl";

describe("Flow progress projection and import", () => {
  let root: string;
  let source: FlowProjectionTarget;
  let destination: FlowProjectionTarget;
  let ledger: string;

  function git(...args: string[]) {
    return execFileSync("git", args, { cwd: source.projectRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  }

  function planAndApprove() {
    const { flowHash } = planRun({ ...source, flowYaml });
    approveRun({ ...source, flowHash, actorId: "operator-1" });
  }

  async function post(intent: string, origin = "http://localhost", fields: Record<string, string> = {}) {
    const url = new URL("http://localhost/api/flows");
    return action({
      request: new Request(url, {
        method: "POST",
        headers: { host: "localhost", origin, "content-type": "application/json" },
        body: JSON.stringify({ intent, projectId: source.projectId, runId: source.runId, ...fields }),
      }),
      url,
      params: {},
      context: {},
      pattern: "/api/flows",
    });
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-projection-"));
    const projectRoot = path.join(root, "checkout");
    fs.mkdirSync(projectRoot);
    source = { projectRoot, projectId: "project-1", runId: "run-1", dataRoot: path.join(root, "source") };
    destination = { ...source, dataRoot: path.join(root, "destination") };
    ledger = path.join(projectRoot, relativeLedger);
    git("init", "--initial-branch=main");
    const flowDirectory = path.join(projectRoot, ".deck", "flows");
    fs.mkdirSync(flowDirectory, { recursive: true });
    fs.writeFileSync(path.join(flowDirectory, "test-two-step.yaml"), flowYaml);
    vi.stubEnv("FLOWS_PROJECT_ROOT", projectRoot);
    vi.stubEnv("FLOWS_DATA_ROOT", source.dataRoot);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("projects exact canonical lines and imports the prefix and its extension as read-only history", async () => {
    planAndApprove();
    await expect(post("project", "https://elsewhere.example")).rejects.toMatchObject({ status: 403 });
    expect(fs.existsSync(ledger)).toBe(false);
    const projected = await post("project");
    expect(await projected.json()).toEqual({ ok: true, appendedLines: 2 });
    const prefix = fs.readFileSync(ledger, "utf8");

    vi.stubEnv("FLOWS_DATA_ROOT", destination.dataRoot);
    expect(await (await post("import")).json()).toEqual({ ok: true, insertedLines: 2, rejectedLines: 0 });
    expect((await post("start")).status).toBe(409);
    const onStepDispatch = vi.fn();
    await expect(runFlow(destination.projectId, destination.runId, {
      dataRoot: destination.dataRoot, onStepDispatch,
    })).rejects.toThrow("Imported flow runs are read-only.");
    expect(onStepDispatch).not.toHaveBeenCalled();

    const live = await runFlow(source.projectId, source.runId, {
      dataRoot: source.dataRoot,
      getStubAgentBytes: () => Buffer.from("private fixture payload"),
    });
    expect(live.finalStatus).toBe("finished");
    const store = openFlowsStore(source.projectId, { dataRoot: source.dataRoot, readonly: true });
    let canonicalLines: string[];
    try {
      canonicalLines = store.exportProjectionLines(source.runId);
    } finally {
      store.close();
    }
    expect(projectFlowProgress(source)).toEqual({ appendedLines: canonicalLines.length - 2 });
    const complete = fs.readFileSync(ledger, "utf8");
    expect(complete.startsWith(prefix)).toBe(true);
    expect(complete).toBe(canonicalLines.join("\n") + "\n");
    expect(complete).not.toContain("private fixture payload");
    expect(projectFlowProgress(source)).toEqual({ appendedLines: 0 });
    expect(await (await post("import")).json()).toEqual({
      ok: true, insertedLines: canonicalLines.length - 2, rejectedLines: 0,
    });
    expect(importFlowProgress(destination)).toEqual({ insertedLines: 0, rejectedLines: 0 });
    expect(readFlowCardStream(destination.projectId, destination.runId, { dataRoot: destination.dataRoot })).toMatchObject({
      readOnly: true, eventCount: canonicalLines.length, terminalOutcome: "done",
    });
    expect(fs.readFileSync(ledger, "utf8")).toBe(complete);
    fs.writeFileSync(ledger, prefix);
    expect(importFlowProgress(destination)).toEqual({ insertedLines: 0, rejectedLines: 0 });
    expect(fs.readFileSync(ledger, "utf8")).toBe(prefix);
  });

  it("refuses to project a missing project or run without creating directories", async () => {
    const missing = await post("project");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ ok: false, error: "Flow run not found." });
    expect(fs.existsSync(source.dataRoot!)).toBe(false);

    planAndApprove();
    const flowsRoot = path.join(source.dataRoot!, "flows");
    expect((await post("project", "http://localhost", { projectId: "project-typo" })).status).toBe(404);
    expect((await post("project", "http://localhost", { runId: "run-typo" })).status).toBe(404);
    expect(fs.readdirSync(flowsRoot)).toEqual([source.projectId]);
    expect(fs.existsSync(path.dirname(ledger))).toBe(false);
  });

  it("counts and rejects malformed, foreign and illegal lines without creating a project", async () => {
    planAndApprove();
    projectFlowProgress(source);
    const [genesis, approval] = fs.readFileSync(ledger, "utf8").split("\n");
    const event = JSON.parse(approval!);
    vi.stubEnv("FLOWS_DATA_ROOT", destination.dataRoot);

    for (const [badTail, rejectedLines] of [
      ["{invalid\n", 1],
      [canonicalJsonStringify({ ...event, runId: "foreign-run" }) + "\n", 1],
      [canonicalJsonStringify({ ...event, data: { ...event.data, flowHash: "b".repeat(64) } }) + "\n", 1],
      ["{invalid\n{also-invalid\n", 2],
    ] as const) {
      fs.writeFileSync(ledger, genesis + "\n" + badTail);
      const rejected = await post("import");
      expect(rejected.status).toBe(422);
      expect(await rejected.json()).toMatchObject({ ok: false, rejectedLines });
      expect(fs.existsSync(destination.dataRoot!)).toBe(false);
    }

    fs.writeFileSync(ledger, genesis + "\n" + approval + "\n");
    fs.writeFileSync(path.join(path.dirname(ledger), "flow.yaml"), flowYaml + "\n");
    const wrongPin = await post("import");
    expect(wrongPin.status).toBe(422);
    expect(await wrongPin.json()).toMatchObject({ error: "The flow definition does not match the ledger pin." });
    expect(fs.existsSync(destination.dataRoot!)).toBe(false);
  });

  it("refuses approval of an imported planned run", async () => {
    const { flowHash } = planRun({ ...source, flowYaml });
    projectFlowProgress(source);
    importFlowProgress(destination);
    vi.stubEnv("FLOWS_DATA_ROOT", destination.dataRoot);

    const approval = await post("approve", "http://localhost", { flowHash });
    expect(approval.status).toBe(409);
    expect(await approval.json()).toEqual({ ok: false, error: "Imported flow runs are read-only." });
    expect(readFlowCardStream(destination.projectId, destination.runId, { dataRoot: destination.dataRoot })?.eventCount).toBe(1);
  });

  it("refuses to answer an open decision on an imported run", async () => {
    const decisionYaml = `flow: test-decision
version: 1
steps:
  - id: review
    type: decision
    always: decide
    title: Approve the result?
    options:
      - key: ship
        label: Ship
        end: done
      - key: stop
        label: Stop
        end: stopped
`;
    const { flowHash } = planRun({ ...source, flowYaml: decisionYaml });
    projectFlowProgress(source);
    fs.writeFileSync(path.join(path.dirname(ledger), "flow.yaml"), decisionYaml);
    importFlowProgress(destination);
    // A planned run has no attempt on which to record an unknown handoff.
    // This reaches the runner's read-only guard without attempting a write.
    expect(() => submitHandoffReturn({
      ...destination, handoffId: "unknown-handoff", choiceKey: "ship", actor: "human", actorId: "operator-1",
    })).toThrow(ImportedFlowReadOnlyError);

    approveRun({ ...source, flowHash, actorId: "operator-1" });
    const paused = await runFlow(source.projectId, source.runId, { dataRoot: source.dataRoot });
    expect(paused.finalStatus).toBe("waiting_decision");
    const { state } = loadRunState(source.projectId, source.runId, { dataRoot: source.dataRoot });
    const handoffId = state.activeHandoff!.handoffId;
    projectFlowProgress(source);
    importFlowProgress(destination);
    vi.stubEnv("FLOWS_DATA_ROOT", destination.dataRoot);

    const decision = await post("decide", "http://localhost", { handoffId, choiceKey: "ship" });
    expect(decision.status).toBe(409);
    expect(await decision.json()).toEqual({ ok: false, error: "Imported flow runs are read-only." });
    expect(readFlowCardStream(destination.projectId, destination.runId, { dataRoot: destination.dataRoot })?.eventCount)
      .toBe(paused.eventCount);
  });

  it("imports an identical repeated artefact receipt and rejects conflicting repeats", async () => {
    planAndApprove();
    await runFlow(source.projectId, source.runId, {
      dataRoot: source.dataRoot, getStubAgentBytes: () => Buffer.from("fixture payload"),
    });
    projectFlowProgress(source);
    const lines = fs.readFileSync(ledger, "utf8").trimEnd().split("\n");
    const receiptIndex = lines.findIndex((line) => JSON.parse(line).type === "artefact_recorded");
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    const receiptLine = lines[receiptIndex]!;
    const receipt: FlowArtefactRecordedEvent = JSON.parse(receiptLine);
    const prefix = lines.slice(0, receiptIndex + 1).join("\n") + "\n";
    const repeated = {
      ...receipt, eventId: "repeat-receipt", seq: receipt.seq + 1,
      prev: createHash("sha256").update(receiptLine).digest("hex"),
    };

    fs.writeFileSync(ledger, prefix + canonicalJsonStringify(repeated) + "\n");
    expect(importFlowProgress(destination)).toEqual({ insertedLines: repeated.seq, rejectedLines: 0 });

    for (const conflict of [
      { ...repeated, stepId: "verify" },
      { ...repeated, attemptId: "other-attempt" },
      { ...repeated, data: { ...receipt.data, sha256: "b".repeat(64) } },
      { ...repeated, data: { ...receipt.data, sizeBytes: receipt.data.sizeBytes + 1 } },
    ]) {
      fs.writeFileSync(ledger, prefix + canonicalJsonStringify(conflict) + "\n");
      expect(() => importFlowProgress({ ...destination, projectId: "other-project" }))
        .toThrow(/Invalid flow transition/);
    }
  });

  it("refuses a rewind even when the committed ledger is missing from the working copy", () => {
    const { flowHash } = planRun({ ...source, flowYaml });
    projectFlowProgress(source);
    importFlowProgress(destination);
    approveRun({ ...source, flowHash, actorId: "operator-1" });
    projectFlowProgress(source);
    git("add", "--", relativeLedger);
    const tree = git("write-tree");
    const head = git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid",
      "commit-tree", tree, "-m", "Fixture projection");
    git("update-ref", "HEAD", head);
    fs.unlinkSync(ledger);

    expect(() => projectFlowProgress(destination)).toThrow(/ahead of or diverges/);
    expect(fs.existsSync(ledger)).toBe(false);
  });

  it("refuses a symlink ledger for both operations", () => {
    planAndApprove();
    projectFlowProgress(source);
    const outside = path.join(root, "outside.jsonl");
    fs.renameSync(ledger, outside);
    const original = fs.readFileSync(outside);
    fs.symlinkSync(outside, ledger);

    expect(() => projectFlowProgress(source)).toThrow(/unsafe/);
    expect(() => importFlowProgress(destination)).toThrow(/unsafe/);
    expect(fs.readFileSync(outside)).toEqual(original);
  });
});
