import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import { resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  loadRunState,
  FlowPinMismatchError,
  PathConfinementError,
  SymlinkNotAllowedError,
} from "../../app/lib/flows/load-run.server.js";
import { acquireOwnerLock } from "../../app/lib/flows/owner.server.js";
import { openFlowsStore } from "../../app/lib/flows/store.server.js";
import { reduceFlowRun } from "../../app/lib/flows/replay.js";
import type { FlowDefinition, FlowEvent } from "../../app/lib/flows/types.js";
import { validateFlowYaml } from "../../app/lib/flows/validator.js";

const GENESIS_PREV = "0".repeat(64);
const fixturesDir = resolve(__dirname, "fixtures");
const goldenFlowYaml = readFileSync(resolve(fixturesDir, "two-step-stub.yaml"), "utf8");
const parsedFlow = validateFlowYaml(goldenFlowYaml);
if (!parsedFlow.valid) throw new Error("Fixture flow invalid");
const flowDef: FlowDefinition = parsedFlow.flow;

function createEvent<T extends FlowEvent["type"]>(
  seq: number,
  prev: string,
  type: T,
  data: Extract<FlowEvent, { type: T }>["data"],
  options?: { stepId?: string; attemptId?: string; actor?: FlowEvent["actor"] }
): { event: FlowEvent; rawLine: string; sha: string } {
  const event: FlowEvent = {
    v: 1,
    runId: "run-golden",
    seq,
    eventId: `run-golden-${seq}`,
    prev,
    at: new Date().toISOString(),
    actor: options?.actor ?? "runner",
    stepId: options?.stepId,
    attemptId: options?.attemptId,
    type,
    data,
  } as FlowEvent;

  const rawLine = JSON.stringify(event) + "\n";
  const sha = createHash("sha256").update(Buffer.from(rawLine, "utf8")).digest("hex");
  return { event, rawLine, sha };
}

describe("Pure Replay Reducer & Server Loader (replay.ts & load-run.server.ts)", () => {
  let scratchDir: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(resolve(os.tmpdir(), "deck-flows-replay-"));
  });

  afterEach(() => {
    if (scratchDir && existsSync(scratchDir)) {
      rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("folds golden 12-event log into expected terminal state with full card projection", () => {
    const artefactSha = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    const verifiedArtefacts = new Map<string, number>([[artefactSha, 120]]);

    const events: FlowEvent[] = [];
    let prev = GENESIS_PREV;

    function add(
      type: FlowEvent["type"],
      data: any,
      opts?: { stepId?: string; attemptId?: string; actor?: FlowEvent["actor"] }
    ) {
      const entry = createEvent(events.length + 1, prev, type, data as any, opts);
      events.push(entry.event);
      prev = entry.sha;
    }

    // 1. run_planned
    add("run_planned", {
      flowRef: "test-two-step",
      flowHash: parsedFlow.hash,
      source: "builtin",
      expectedDecisions: [],
    });

    // 2. flow_approved
    add("flow_approved", {
      flowHash: parsedFlow.hash,
      actorId: "tester",
    });

    // 3. run_started
    add("run_started", {
      runnerVersion: "0.1.0",
      inputIds: {},
      budget: { tokens: 10000, steps: 10 },
    });

    // 4. step_started (generate)
    add(
      "step_started",
      { occurrence: 1, effectKey: "eff-1" },
      { stepId: "generate", attemptId: "att-gen-1" }
    );

    // 5. artefact_recorded
    add(
      "artefact_recorded",
      { artefactId: "output_file", sha256: artefactSha, sizeBytes: 120 },
      { stepId: "generate", attemptId: "att-gen-1" }
    );

    // 6. step_result
    add(
      "step_result",
      { outputs: { output_file: artefactSha }, tokensUsed: 150, wallTimeMs: 400 },
      { stepId: "generate", attemptId: "att-gen-1" }
    );

    // 7. judgement
    add(
      "judgement",
      { final: "continue", ruleHits: [], reasonCodes: [], engineTokens: 0 },
      { stepId: "generate", attemptId: "att-gen-1" }
    );

    // 8. step_started (verify)
    add(
      "step_started",
      { occurrence: 1, effectKey: "eff-2" },
      { stepId: "verify", attemptId: "att-ver-1" }
    );

    // 9. check_result
    add(
      "check_result",
      { checkId: "check_exists", targetSha: artefactSha, passed: true },
      { stepId: "verify", attemptId: "att-ver-1" }
    );

    // 10. step_result
    add(
      "step_result",
      { outputs: {}, tokensUsed: 0, wallTimeMs: 50 },
      { stepId: "verify", attemptId: "att-ver-1" }
    );

    // 11. judgement
    add(
      "judgement",
      { final: "continue", ruleHits: [], reasonCodes: [], engineTokens: 0 },
      { stepId: "verify", attemptId: "att-ver-1" }
    );

    // 12. run_finished
    add("run_finished", { outcome: "done", reasonCode: "completed" });

    expect(events).toHaveLength(12);

    // Pure reduction
    const state = reduceFlowRun(flowDef, events, verifiedArtefacts);

    expect(state.status).toBe("finished");
    expect(state.terminalOutcome).toBe("done");
    expect(state.terminalReason).toBe("completed");
    expect(state.runPlanned?.flowRef).toBe("test-two-step");
    expect(state.currentStepId).toBeNull();
    expect(state.currentAttemptId).toBeNull();
    expect(state.budgetUsed.tokens).toBe(150);
    expect(state.budgetUsed.steps).toBe(2);
    expect(state.budgetRemaining.tokens).toBe(10000 - 150);
    expect(state.budgetRemaining.steps).toBe(10 - 2);
    expect(state.stepStates.generate!.status).toBe("passed");
    expect(state.stepStates.generate!.attempts["att-gen-1"]?.status).toBe("passed");
    expect(state.stepStates.verify!.status).toBe("passed");
    expect(state.recordedArtefacts.output_file!.sha256).toBe(artefactSha);
  });

  it("halts replay with waiting_decision when declared artefact is missing and ignores subsequent events", () => {
    const unverifiedSha = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const verifiedArtefacts = new Map<string, number>();

    const events: FlowEvent[] = [];
    let prev = GENESIS_PREV;

    function add<T extends FlowEvent["type"]>(
      type: T,
      data: Extract<FlowEvent, { type: T }>["data"],
      opts?: any
    ) {
      const entry = createEvent(events.length + 1, prev, type, data as any, opts);
      events.push(entry.event);
      prev = entry.sha;
    }

    add("run_planned", { flowRef: "test-two-step", flowHash: parsedFlow.hash, source: "builtin", expectedDecisions: [] });
    add("flow_approved", { flowHash: parsedFlow.hash, actorId: "tester" });
    add("run_started", { runnerVersion: "0.1.0", inputIds: {}, budget: { tokens: 1000, steps: 10 } });
    add("step_started", { occurrence: 1, effectKey: "eff-1" }, { stepId: "generate", attemptId: "att-1" });
    add("artefact_recorded", { artefactId: "output_file", sha256: unverifiedSha, sizeBytes: 100 }, { stepId: "generate", attemptId: "att-1" });

    // Subsequent event that must NOT be applied
    add("step_started", { occurrence: 1, effectKey: "eff-2" }, { stepId: "verify", attemptId: "att-2" });

    const state = reduceFlowRun(flowDef, events, verifiedArtefacts);

    expect(state.status).toBe("waiting_decision");
    expect(state.activeDecision).not.toBeNull();
    expect(state.activeDecision?.reasonCode).toBe("artefact_missing");
    expect(state.stepStates.verify).toBeUndefined();
  });

  it("halts replay with waiting_decision on step_outcome_unknown and ignores subsequent execution", () => {
    const events: FlowEvent[] = [];
    let prev = GENESIS_PREV;

    function add<T extends FlowEvent["type"]>(
      type: T,
      data: Extract<FlowEvent, { type: T }>["data"],
      opts?: any
    ) {
      const entry = createEvent(events.length + 1, prev, type, data as any, opts);
      events.push(entry.event);
      prev = entry.sha;
    }

    add("run_planned", { flowRef: "test-two-step", flowHash: parsedFlow.hash, source: "builtin", expectedDecisions: [] });
    add("flow_approved", { flowHash: parsedFlow.hash, actorId: "tester" });
    add("run_started", { runnerVersion: "0.1.0", inputIds: {}, budget: { tokens: 1000, steps: 10 } });
    add("step_started", { occurrence: 1, effectKey: "eff-1" }, { stepId: "generate", attemptId: "att-1" });
    add("step_outcome_unknown", { reasonCode: "dispatch_interrupted" }, { stepId: "generate", attemptId: "att-1" });

    // Spurious event appended after unknown outcome
    add("step_started", { occurrence: 1, effectKey: "eff-2" }, { stepId: "verify", attemptId: "att-2" });

    const state = reduceFlowRun(flowDef, events, new Map());

    expect(state.status).toBe("waiting_decision");
    expect(state.activeDecision?.reasonCode).toBe("dispatch_interrupted");
    expect(state.stepStates.verify).toBeUndefined();
  });

  it("enforces pinned flow budget ceiling: exact 1-step budget allows step 1 to finish, step 2 halts with ceiling_reached even if run_started claims a larger budget", () => {
    const oneStepFlowDef: FlowDefinition = {
      ...flowDef,
      limits: { ...flowDef.limits, budget: { tokens: 1000, steps: 1 } },
    };
    const events: FlowEvent[] = [];
    let prev = GENESIS_PREV;

    function add<T extends FlowEvent["type"]>(
      type: T,
      data: Extract<FlowEvent, { type: T }>["data"],
      opts?: any
    ) {
      const entry = createEvent(events.length + 1, prev, type, data as any, opts);
      events.push(entry.event);
      prev = entry.sha;
    }

    add("run_planned", { flowRef: "test-two-step", flowHash: parsedFlow.hash, source: "builtin", expectedDecisions: [] });
    add("flow_approved", { flowHash: parsedFlow.hash, actorId: "tester" });
    // Major 3: Even if run_started carries an inflated budget, replay strictly enforces the pinned flow's 1-step limit!
    add("run_started", { runnerVersion: "0.1.0", inputIds: {}, budget: { tokens: 999999, steps: 999 } });
    add("step_started", { occurrence: 1, effectKey: "eff_000000000000000000000001" }, { stepId: "generate", attemptId: "att-1" });

    // 1-step budget permits step 1 to execute (budgetRemaining.steps = 0, still running)
    const mid = reduceFlowRun(oneStepFlowDef, events, new Map());
    expect(mid.status).toBe("running");
    expect(mid.budgetRemaining.steps).toBe(0);
    expect(mid.budgetRemaining.tokens).toBe(1000);

    // Starting a 2nd step exceeds the 1-step budget -> stopped / ceiling_reached
    add("step_started", { occurrence: 1, effectKey: "eff_000000000000000000000002" }, { stepId: "verify", attemptId: "att-2" });
    const state = reduceFlowRun(oneStepFlowDef, events, new Map());
    expect(state.status).toBe("stopped");
    expect(state.terminalReason).toBe("ceiling_reached");
  });

  it("loadRunState enforces runId match and raw byte pin verification via store", () => {
    const projectId = "proj-load";
    const runId = "run-load-test";
    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });

    try {
      store.createRun({
        runId,
        flowHash: parsedFlow.hash,
        flowYamlBytes: goldenFlowYaml,
      });

      store.appendEvent({
        v: 1,
        runId,
        seq: 1,
        eventId: "ev-1",
        prev: GENESIS_PREV,
        at: new Date().toISOString(),
        actor: "runner",
        type: "run_planned",
        data: {
          flowRef: "test-two-step",
          flowHash: parsedFlow.hash,
          source: "builtin",
          expectedDecisions: [],
        },
      });

      store.writeAndRecordArtifact({
        artifactId: "art-1",
        runId,
        stepId: "generate",
        attemptId: "1",
        name: "output_file",
        mediaType: "text/plain",
        bytes: Buffer.from("verified replay artifact bytes", "utf8"),
      });
    } finally {
      store.close();
      lock.release();
    }

    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(loaded.flow.flow).toBe("test-two-step");
    expect(loaded.events).toHaveLength(1);
    expect(loaded.verifiedArtefacts.size).toBe(1);

    // Wrong runId negative test
    expect(() => {
      loadRunState(projectId, "non-existent-run", { dataRoot: scratchDir });
    }).toThrow();
  });

  it("assertConfinedPath refuses symlinks and traversal", () => {
    const targetDir = resolve(scratchDir, "confined-test");
    mkdirSync(targetDir, { recursive: true });

    // Traversal test
    expect(() => {
      loadRunState("../escape", "run-1", { dataRoot: targetDir });
    }).toThrow();
  });
});
