import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { selectPreanswer } from "../../app/lib/flows/decisions.js";
import { importFlowProgress } from "../../app/lib/flows/importer.server.js";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import { readFlowCardStream } from "../../app/lib/flows/reader.server.js";
import { approveRun, planRun, runFlow, submitHandoffReturn, type CrashPoint } from "../../app/lib/flows/runner.server.js";
import { canonicalJsonStringify, openFlowsStore } from "../../app/lib/flows/store.server.js";
import type { FlowEvent, FlowHandoffReturnedEvent, FlowStepStartedEvent } from "../../app/lib/flows/types.js";
import { saveFlowPreanswerFromUi } from "../../app/lib/flows/ui-actions.server.js";
import { __resetInboxCaches, FileInboxRepository } from "../../app/lib/inbox.server.js";

const flowYaml = `flow: preanswer-fixture
version: 1
limits:
  max_attempts: 3
  budget:
    steps: 20
    tokens: 5000
steps:
  - id: build
    type: agent
    outputs: [draft]
    rules:
      - protected_path_touched: decide
  - id: verify
    type: check
    against: draft
    run: [check_nonempty]
  - id: review
    type: decision
    title: Review draft
    options:
      - key: ship
        label: Ship draft
        end: done
      - key: rework
        label: Rework draft
        goto: build
`;

const projectId = "preanswer-project";
const runId = "preanswer-run";
const actorId = "operator-1";
const agentName = "flow-fixture";
const participantName = "operator";

function crashAt(target: CrashPoint) {
  return (point: CrashPoint) => {
    if (point === target) throw new Error(`Simulated interruption at ${point}`);
  };
}

function markedReturns(events: FlowEvent[]) {
  return events.filter((event): event is FlowHandoffReturnedEvent =>
    event.type === "handoff_returned" && event.data.preanswerSeq !== undefined,
  );
}

describe("planning pre-answers", () => {
  let scratch: string;
  let dataRoot: string;
  let inboxRoot: string;
  let repo: FileInboxRepository;
  let flowHash: string;

  beforeEach(() => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-preanswers-"));
    dataRoot = path.join(scratch, "data");
    inboxRoot = path.join(scratch, "inbox-root");
    fs.mkdirSync(path.join(inboxRoot, agentName, "inbox"), { recursive: true });
    vi.stubEnv("INBOX_ROOT", inboxRoot);
    __resetInboxCaches();
    repo = new FileInboxRepository(inboxRoot);
  });

  afterEach(() => {
    __resetInboxCaches();
    vi.unstubAllEnvs();
    fs.rmSync(scratch, { force: true, recursive: true });
  });

  function prepare(yaml = flowYaml) {
    ({ flowHash } = planRun({ projectId, runId, flowYaml: yaml, dataRoot }));
    approveRun({ projectId, runId, flowHash, actorId, dataRoot });
  }

  function save(stepId: string, choiceKey: string) {
    return saveFlowPreanswerFromUi({ projectId, runId, flowHash, stepId, choiceKey, dataRoot });
  }

  function read() {
    return loadRunState(projectId, runId, { dataRoot });
  }

  function run(onCrashPoint?: (point: CrashPoint) => void) {
    return runFlow(projectId, runId, {
      dataRoot,
      inbox: { inboxRoot, agentName, participantName, repo },
      onCrashPoint,
    });
  }

  it("recovers from both appends, applies the replacement once and asks live after the rewind", { timeout: 30_000 }, async () => {
    prepare();
    save("review", "ship");
    const replacement = save("review", "rework");

    await expect(run(crashAt("K_AFTER_HANDOFF_SENT"))).rejects.toThrow("K_AFTER_HANDOFF_SENT");
    const firstHandoff = read().state.activeHandoff!;
    expect(firstHandoff.stepId).toBe("review");
    expect(markedReturns(read().events)).toHaveLength(0);

    await expect(run(crashAt("K_AFTER_HANDOFF_RETURNED"))).rejects.toThrow("K_AFTER_HANDOFF_RETURNED");
    expect(markedReturns(read().events)).toMatchObject([{
      data: { handoffId: firstHandoff.handoffId, choiceKey: "rework", preanswerSeq: replacement.seq },
    }]);

    await expect(run()).resolves.toMatchObject({ finalStatus: "waiting_decision" });
    const repeated = read();
    expect(repeated.state.stepStates.review?.occurrence).toBe(2);
    expect(repeated.state.lastRewind).toMatchObject({ fromStepId: "review", toStepId: "build", rewindNumber: 1 });
    const secondHandoff = repeated.state.activeHandoff!;
    expect(secondHandoff.handoffId).not.toBe(firstHandoff.handoffId);
    const cards = await repo.readBlocks(agentName, participantName);
    expect(cards.flatMap((block) => block.card?.decisionId ?? [])).toEqual([secondHandoff.handoffId]);
    expect(markedReturns(repeated.events)).toHaveLength(1);

    expect(submitHandoffReturn({
      projectId, runId, dataRoot, handoffId: secondHandoff.handoffId,
      choiceKey: "ship", actor: "human", actorId,
    })).toEqual({ accepted: true });
    await expect(run()).resolves.toMatchObject({ finalStatus: "finished", terminalOutcome: "done" });
    expect(markedReturns(read().events)).toHaveLength(1);
  });

  it("asks live at the hard step ceiling even with a matching pre-answer", async () => {
    prepare(flowYaml.replace("steps: 20", "steps: 3"));
    save("review", "ship");

    await expect(run()).resolves.toMatchObject({ finalStatus: "waiting_decision" });
    const { state, events } = read();
    expect(state.budgetRemaining.steps).toBe(0);
    expect(state.activeHandoff?.stepId).toBe("review");
    expect(markedReturns(events)).toHaveLength(0);
    expect((await repo.readBlocks(agentName, participantName)).some(
      (block) => block.card?.decisionId === state.activeHandoff?.handoffId,
    )).toBe(true);
  });

  it("keeps always: decide live and rejects a candidate even when a saved choice is present", async () => {
    prepare(flowYaml.replace("type: decision", "type: decision\n    always: decide"));
    expect(() => save("review", "ship")).toThrow("Choice is not offered");
    save("build", "continue");

    await expect(run()).resolves.toMatchObject({ finalStatus: "waiting_decision" });
    const { flow, state, events } = read();
    expect(state.activeHandoff).toMatchObject({ stepId: "review", alwaysDecide: true });
    expect(markedReturns(events)).toHaveLength(0);

    // Supply a candidate directly to prove the application guard independently of the save guard.
    const candidates = events.map((event) => event.type === "preanswer_given"
      ? { ...event, data: { ...event.data, stepId: "review", choiceKey: "ship" } }
      : event);
    expect(selectPreanswer({
      step: flow.steps.find((step) => step.id === "review")!,
      handoff: state.activeHandoff!,
      events: candidates,
      budgetRemaining: state.budgetRemaining,
      rewindsRemaining: 6,
    })).toBeUndefined();
  });

  it("leaves a non-decide judgement alone even with a saved choice", async () => {
    prepare();
    save("build", "continue");
    save("review", "ship");

    await expect(run()).resolves.toMatchObject({ finalStatus: "finished", terminalOutcome: "done" });
    const { flow, state, events } = read();
    const intent = events.find((event): event is FlowStepStartedEvent =>
      event.type === "step_started" && event.stepId === "build",
    );
    expect(intent?.type).toBe("step_started");
    expect(events).toContainEqual(expect.objectContaining({
      type: "judgement", stepId: "build", data: expect.objectContaining({ final: "continue" }),
    }));
    expect(markedReturns(events).map((event) => event.stepId)).toEqual(["review"]);

    // Ordinary execution cannot open this handoff. Probe the application guard with the recorded outcome.
    expect(selectPreanswer({
      step: flow.steps[0]!,
      handoff: {
        stepId: "build", attemptId: intent!.attemptId, kind: "decision",
        optionKeys: ["continue", "retry", "stop"], alwaysDecide: false,
      },
      events,
      budgetRemaining: state.budgetRemaining,
      rewindsRemaining: 6,
    })).toBeUndefined();
  });

  it("uses a choice at a rule exit and continues to the next step", async () => {
    prepare(flowYaml.replace("version: 1", "version: 1\nprotected_paths: [guarded]"));
    const saved = save("build", "continue");

    await expect(runFlow(projectId, runId, {
      dataRoot,
      evaluateSignals: ({ step }) => step.id === "build" ? { changedFiles: ["guarded"] } : {},
    })).resolves.toMatchObject({ finalStatus: "waiting_decision" });
    const { state, events } = read();
    expect(state.activeHandoff?.stepId).toBe("review");
    expect(events).toContainEqual(expect.objectContaining({
      type: "judgement", stepId: "build",
      data: expect.objectContaining({ final: "decide", ruleHits: ["protected_path_touched"] }),
    }));
    expect(markedReturns(events)).toMatchObject([{
      stepId: "build", data: { choiceKey: "continue", preanswerSeq: saved.seq },
    }]);
  });

  it.each([
    { choiceKey: "stop", finalStatus: "stopped", applied: true },
    { choiceKey: "continue", finalStatus: "waiting_decision", applied: false },
  ])("revalidates $choiceKey against the options of a failed check at its attempt limit", { timeout: 15_000 }, async ({
    choiceKey, finalStatus, applied,
  }) => {
    prepare(flowYaml.replace("max_attempts: 3", "max_attempts: 1"));
    const saved = save("verify", choiceKey);

    await expect(runFlow(projectId, runId, {
      dataRoot,
      getStubAgentBytes: () => Buffer.alloc(0),
    })).resolves.toMatchObject({ finalStatus });
    const { state, events } = read();
    expect(events).toContainEqual(expect.objectContaining({
      type: "judgement", stepId: "verify",
      data: expect.objectContaining({ final: "decide", reasonCodes: expect.arrayContaining(["max_attempts_reached"]) }),
    }));
    if (applied) {
      expect(markedReturns(events)).toMatchObject([{ data: { choiceKey, preanswerSeq: saved.seq } }]);
      expect(state.terminalReason).toBe("operator_stopped");
    } else {
      expect(markedReturns(events)).toHaveLength(0);
      expect(state.activeHandoff).toMatchObject({ stepId: "verify", optionKeys: ["retry", "stop"] });
    }
  });

  it("imports the canonical marked return as read-only and rejects a forged sequence", async () => {
    prepare();
    const first = save("review", "rework");
    const latest = save("review", "ship");
    await expect(run()).resolves.toMatchObject({ finalStatus: "finished", terminalOutcome: "done" });

    const store = openFlowsStore(projectId, { dataRoot, readonly: true });
    let lines: string[];
    try {
      lines = store.exportProjectionLines(runId);
      expect(lines).toEqual(store.getEvents(runId).map((row) => row.line));
    } finally {
      store.close();
    }

    const projectRoot = path.join(scratch, "checkout");
    const ledgerDir = path.join(projectRoot, ".deck", "runs", runId);
    fs.mkdirSync(ledgerDir, { recursive: true });
    fs.writeFileSync(path.join(ledgerDir, "flow.yaml"), flowYaml);
    const ledger = path.join(ledgerDir, "events.jsonl");
    fs.writeFileSync(ledger, lines.join("\n") + "\n");
    const importedRoot = path.join(scratch, "imported");
    const target = { projectRoot, projectId, runId, dataRoot: importedRoot };
    expect(importFlowProgress(target)).toEqual({ insertedLines: lines.length, rejectedLines: 0 });
    expect(loadRunState(projectId, runId, { dataRoot: importedRoot }).events).toEqual(read().events);
    expect(readFlowCardStream(projectId, runId, { dataRoot: importedRoot })).toMatchObject({
      readOnly: true,
      planningDecisions: expect.arrayContaining([expect.objectContaining({
        stepId: "review", applied: { choiceKey: "ship", preanswerSeq: latest.seq },
      })]),
    });

    let prev = "0".repeat(64);
    const forged = lines.map((line) => {
      const event = JSON.parse(line) as FlowEvent;
      event.prev = prev;
      if (event.type === "handoff_returned") event.data.preanswerSeq = first.seq;
      const encoded = canonicalJsonStringify(event);
      prev = createHash("sha256").update(encoded).digest("hex");
      return encoded;
    });
    fs.writeFileSync(ledger, forged.join("\n") + "\n");
    const rejectedRoot = path.join(scratch, "rejected");
    expect(() => importFlowProgress({ ...target, dataRoot: rejectedRoot })).toThrow("Invalid flow transition at ledger line");
    expect(fs.existsSync(rejectedRoot)).toBe(false);
  });
});
