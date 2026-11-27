import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { importFlowProgress } from "../../app/lib/flows/importer.server.js";
import { projectFlowProgress, type FlowProjectionTarget } from "../../app/lib/flows/projection.server.js";
import { readFlowCardStream } from "../../app/lib/flows/reader.server.js";
import { approveRun, planRun, runFlow } from "../../app/lib/flows/runner.server.js";
import { canonicalJsonStringify, openFlowsStore } from "../../app/lib/flows/store.server.js";
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

  async function post(intent: string, origin = "http://localhost") {
    const url = new URL("http://localhost/api/flows");
    return action({
      request: new Request(url, {
        method: "POST",
        headers: { host: "localhost", origin, "content-type": "application/json" },
        body: JSON.stringify({ intent, projectId: source.projectId, runId: source.runId }),
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

  it("counts and rejects malformed, foreign and illegal lines with no partial import", async () => {
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
      const store = openFlowsStore(destination.projectId, { dataRoot: destination.dataRoot, readonly: true });
      try {
        expect(store.getRun(destination.runId)).toBeNull();
        expect(store.getPinnedFlow(event.data.flowHash)).toBeNull();
      } finally {
        store.close();
      }
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
