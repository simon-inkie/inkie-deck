// @vitest-environment jsdom
/**
 * card-stream.test.tsx - Unit, integration, security, and UI tests for
 * Deck Flows Slice 1b (read-only card stream over live SQLite DB).
 *
 * ASCII only - no em-dashes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppShell } from "../../app/components/AppShell.js";
import { FlowCardStream } from "../../app/components/FlowCardStream.js";
import {
  deriveWaitingOn,
  projectFlowCardStream,
  type FlowCardStreamView,
} from "../../app/lib/flows/card-stream.js";
import { acquireOwnerLock, UnsafeFilesystemError } from "../../app/lib/flows/owner.server.js";
import {
  FlowIntegrityError,
  InvalidFlowQueryError,
  listFlowProjects,
  listFlowRuns,
  readFlowCardStream,
} from "../../app/lib/flows/reader.server.js";
import {
  buildBoundedAttemptId,
  buildDeterministicEffectKey,
  openFlowsStore,
} from "../../app/lib/flows/store.server.js";
import type { FlowEvent } from "../../app/lib/flows/types.js";
import { action as apiFlowsAction, loader as apiFlowsLoader } from "../../app/routes/api.flows.js";
import FlowsRoute, { loader as flowsRouteLoader } from "../../app/routes/flows.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const GENESIS_PREV = "0".repeat(64);

const THREE_STEP_YAML = [
  "flow: three-step-demo",
  "version: 1",
  "title: Three-step demo flow",
  "limits:",
  "  max_attempts: 3",
  "  budget:",
  "    tokens: 5000",
  "    steps: 10",
  "steps:",
  "  - id: draft",
  "    type: agent",
  "    role: builder",
  "    prompt: Draft output",
  "    outputs:",
  "      - output_file",
  "  - id: review",
  "    type: agent",
  "    role: reviewer",
  "    prompt: Review output",
  "  - id: verify",
  "    type: check",
  "    against: draft.output_file",
  "    run:",
  "      - check_nonempty",
  "    on_fail:",
  "      goto: draft",
].join("\n");

const THREE_STEP_HASH = crypto
  .createHash("sha256")
  .update(THREE_STEP_YAML, "utf8")
  .digest("hex");

function callApiFlows(urlStr: string, init?: RequestInit) {
  const url = new URL(urlStr);
  return apiFlowsLoader({
    request: new Request(url, init),
    url,
    params: {},
    context: {},
    pattern: "/api/flows",
  });
}

function callFlowsRoute(urlStr: string) {
  const url = new URL(urlStr);
  return flowsRouteLoader({
    request: new Request(url),
    url,
    params: {},
    context: {},
    pattern: "/flows",
  });
}

function makeIso(offsetSec: number): string {
  return new Date(Date.UTC(2026, 10, 24, 12, 0, offsetSec)).toISOString();
}

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function appendNext(
  store: ReturnType<typeof openFlowsStore>,
  state: { seq: number; prev: string },
  eventBody: DistributiveOmit<FlowEvent, "v" | "seq" | "eventId" | "prev" | "at"> & {
    runId: string;
  },
  privateDetail?: string,
): { seq: number; hash: string; privateRef?: string } {
  const nextSeq = state.seq + 1;
  const ev = {
    v: 1,
    seq: nextSeq,
    eventId: `ev_${nextSeq}`,
    prev: state.prev,
    at: makeIso(nextSeq),
    ...eventBody,
  } as FlowEvent;
  const res = store.appendEvent(
    ev,
    privateDetail !== undefined ? { privateDetail } : undefined,
  );
  state.seq = res.seq;
  state.prev = res.hash;
  return res;
}

describe("Deck Flows Slice 1b - Read-only card stream", () => {
  let scratchDir: string;
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-1b-"));
    vi.stubEnv("DATA_ROOT", scratchDir);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("1. Golden path end-to-end: planning, done with artefact evidence + tokens + wallTime, current rewind occurrence 2, pending, and zero flows.owner creation", () => {
    const projectId = "proj-golden";
    const runId = "run-golden-1";

    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    const cursor = { seq: 0, prev: GENESIS_PREV };
    let artHash = "";
    let artSize = 0;

    try {
      store.createAndApproveRun({
        runId,
        flowRef: "three-step-demo",
        flowHash: THREE_STEP_HASH,
        flowYamlBytes: THREE_STEP_YAML,
        source: "project",
        expectedDecisions: ["ship_gate"],
        actorId: "operator-1",
      });
      cursor.seq = 2;
      const evRows = store.getEvents(runId);
      cursor.prev = evRows[evRows.length - 1]!.hash;

      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "run_started",
        data: {
          runnerVersion: "0.1.0",
          inputIds: {},
          budget: { tokens: 5000, steps: 10 },
        },
      });

      // Step 1: draft (passes with artefact, tokens, wallTime)
      const draftAtt = buildBoundedAttemptId("draft", 1);
      const draftEff = buildDeterministicEffectKey(runId, "draft", 1);
      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "step_started",
        stepId: "draft",
        attemptId: draftAtt,
        data: { occurrence: 1, effectKey: draftEff },
      });

      const artBytes = Buffer.from("verified-build-bundle-v1\n", "utf8");
      const artWritten = store.writeAndRecordArtifact({
        artifactId: "art_draft_1",
        runId,
        stepId: "draft",
        attemptId: draftAtt,
        name: "output_file",
        mediaType: "text/plain",
        bytes: artBytes,
      });
      artHash = artWritten.contentHash;
      artSize = artWritten.size;

      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "artefact_recorded",
        stepId: "draft",
        attemptId: draftAtt,
        data: {
          artefactId: "art_draft_1",
          sha256: artHash,
          sizeBytes: artSize,
        },
      });

      appendNext(store, cursor, {
        runId,
        actor: "agent",
        type: "step_result",
        stepId: "draft",
        attemptId: draftAtt,
        data: {
          outputs: { status: "ok", output_file: artHash },
          tokensUsed: 320,
          wallTimeMs: 410,
        },
      });

      appendNext(store, cursor, {
        runId,
        actor: "system",
        type: "judgement",
        stepId: "draft",
        attemptId: draftAtt,
        data: {
          final: "continue",
          ruleHits: ["step_passed"],
          reasonCodes: ["ok"],
          engineTokens: 0,
        },
      });

      // Step 2: review fails once, then rewinds to occurrence 2 (current)
      const revAtt1 = buildBoundedAttemptId("review", 1);
      const revEff1 = buildDeterministicEffectKey(runId, "review", 1);
      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "step_started",
        stepId: "review",
        attemptId: revAtt1,
        data: { occurrence: 1, effectKey: revEff1 },
      });
      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "step_failed",
        stepId: "review",
        attemptId: revAtt1,
        data: { errorCode: "execution_error" },
      });
      appendNext(store, cursor, {
        runId,
        actor: "system",
        type: "judgement",
        stepId: "review",
        attemptId: revAtt1,
        data: {
          final: "notify",
          ruleHits: ["retry_step"],
          reasonCodes: ["retry"],
          engineTokens: 0,
        },
      });

      const revAtt2 = buildBoundedAttemptId("review", 2);
      const revEff2 = buildDeterministicEffectKey(runId, "review", 2);
      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "step_started",
        stepId: "review",
        attemptId: revAtt2,
        data: { occurrence: 2, effectKey: revEff2 },
      });
    } finally {
      store.close();
      lock.release();
    }

    // Remove flows.owner after lock release to prove Slice 1b reader NEVER creates it.
    const ownerFile = path.join(scratchDir, "flows", projectId, "flows.owner");
    if (fs.existsSync(ownerFile)) {
      fs.unlinkSync(ownerFile);
    }
    expect(fs.existsSync(ownerFile)).toBe(false);

    expect(listFlowProjects()).toEqual([projectId]);
    const runs = listFlowRuns(projectId);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({
      runId,
      status: "running",
      waitingOn: null,
      flowHash: THREE_STEP_HASH,
    });

    const stream = readFlowCardStream(projectId, runId);
    expect(stream).not.toBeNull();
    expect(fs.existsSync(ownerFile)).toBe(false);

    expect(stream!.flowName).toBe("three-step-demo");
    expect(stream!.runStatus).toBe("running");
    expect(stream!.waitingOn).toBeNull();
    expect(stream!.planningCard).toEqual({
      flowRef: "three-step-demo",
      flowHash: THREE_STEP_HASH,
      source: "project",
      approved: true,
      expectedDecisions: ["ship_gate"],
    });
    expect(stream!.budget).toEqual({
      tokensUsed: 320,
      tokensTotal: 5000,
      stepsUsed: 3,
      stepsTotal: 10,
    });

    expect(stream!.stepCards).toHaveLength(3);
    expect(stream!.stepCards[0]).toMatchObject({
      stepId: "draft",
      stepType: "agent",
      cardState: "done",
      stepStatus: "passed",
      occurrence: 1,
      maxAttempts: 3,
      rewindLabel: null,
      tokensUsed: 320,
      wallTimeMs: 410,
    });
    expect(stream!.stepCards[0]!.evidence.artefacts).toEqual([
      { artefactId: "art_draft_1", sha256: artHash, sizeBytes: artSize },
    ]);
    expect(stream!.stepCards[0]!.evidence.outputs).toEqual({
      status: "ok",
      output_file: artHash,
    });
    expect(stream!.stepCards[0]!.evidence.lastJudgement).toEqual({
      final: "continue",
      reasonCodes: ["ok"],
    });

    expect(stream!.stepCards[1]).toMatchObject({
      stepId: "review",
      stepType: "agent",
      cardState: "current",
      stepStatus: "running",
      occurrence: 2,
      maxAttempts: 3,
      rewindLabel: "attempt 2 of 3",
    });

    expect(stream!.stepCards[2]).toMatchObject({
      stepId: "verify",
      stepType: "check",
      cardState: "pending",
      stepStatus: "pending",
      occurrence: 0,
      rewindLabel: null,
    });

    // Render FlowCardStream and verify UI elements
    act(() => {
      root.render(<FlowCardStream stream={stream!} />);
    });

    expect(container.querySelector('[data-testid="flow-run-status"]')?.textContent).toBe("running");
    expect(container.querySelector('[data-testid="flow-waiting-on"]')).toBeNull();
    expect(container.querySelector('[data-testid="flow-budget-summary"]')?.textContent).toContain(
      "Steps: 3 / 10 | Tokens: 320 / 5000",
    );
    expect(container.querySelector('[data-testid="flow-planning-approval"]')?.textContent).toBe(
      "Approved",
    );

    const draftCard = container.querySelector('[data-testid="flow-step-card-draft"]');
    expect(draftCard?.getAttribute("data-card-state")).toBe("done");
    const draftEvidence = container.querySelector('[data-testid="flow-step-evidence-draft"]');
    expect(draftEvidence?.textContent).toContain("art_draft_1");
    expect(draftEvidence?.textContent).toContain(artHash.slice(0, 12));
    expect(draftEvidence?.textContent).toContain(`${artSize} B`);
    expect(draftCard?.textContent).toContain("320 tokens");
    expect(draftCard?.textContent).toContain("410 ms");

    const reviewCard = container.querySelector('[data-testid="flow-step-card-review"]');
    expect(reviewCard?.getAttribute("data-card-state")).toBe("current");
    expect(container.querySelector('[data-testid="flow-step-rewind-review"]')?.textContent).toBe(
      "attempt 2 of 3",
    );

    const verifyCard = container.querySelector('[data-testid="flow-step-card-verify"]');
    expect(verifyCard?.getAttribute("data-card-state")).toBe("pending");
  });

  it("2. Live concurrent writer + reader: reader reads WAL snapshots without SQLITE_BUSY while writer holds ownerLock", () => {
    const projectId = "proj-concurrent";
    const runId = "run-concurrent-1";

    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    const cursor = { seq: 0, prev: GENESIS_PREV };

    try {
      store.createAndApproveRun({
        runId,
        flowRef: "three-step-demo",
        flowHash: THREE_STEP_HASH,
        flowYamlBytes: THREE_STEP_YAML,
        source: "builtin",
        expectedDecisions: [],
        actorId: "operator-1",
      });
      cursor.seq = 2;
      const evRows = store.getEvents(runId);
      cursor.prev = evRows[evRows.length - 1]!.hash;

      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "run_started",
        data: {
          runnerVersion: "0.1.0",
          inputIds: {},
          budget: { tokens: 5000, steps: 10 },
        },
      });

      const draftAtt = buildBoundedAttemptId("draft", 1);
      const draftEff = buildDeterministicEffectKey(runId, "draft", 1);
      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "step_started",
        stepId: "draft",
        attemptId: draftAtt,
        data: { occurrence: 1, effectKey: draftEff },
      });

      // Read mid-step while writer still holds ownerLock and open DB handle
      const midStream = readFlowCardStream(projectId, runId);
      expect(midStream).not.toBeNull();
      expect(midStream!.runStatus).toBe("running");
      expect(midStream!.stepCards[0]!.cardState).toBe("current");

      // Writer advances step 1 to completion and starts step 2 while still holding lock
      appendNext(store, cursor, {
        runId,
        actor: "agent",
        type: "step_result",
        stepId: "draft",
        attemptId: draftAtt,
        data: {
          outputs: { status: "ok" },
          tokensUsed: 100,
          wallTimeMs: 55,
        },
      });
      appendNext(store, cursor, {
        runId,
        actor: "system",
        type: "judgement",
        stepId: "draft",
        attemptId: draftAtt,
        data: {
          final: "continue",
          ruleHits: ["step_passed"],
          reasonCodes: ["ok"],
          engineTokens: 0,
        },
      });

      const revAtt = buildBoundedAttemptId("review", 1);
      const revEff = buildDeterministicEffectKey(runId, "review", 1);
      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "step_started",
        stepId: "review",
        attemptId: revAtt,
        data: { occurrence: 1, effectKey: revEff },
      });

      const nextStream = readFlowCardStream(projectId, runId);
      expect(nextStream).not.toBeNull();
      expect(nextStream!.stepCards[0]!.cardState).toBe("done");
      expect(nextStream!.stepCards[1]!.cardState).toBe("current");
      expect(nextStream!.budget.stepsUsed).toBe(2);
      expect(nextStream!.budget.tokensUsed).toBe(100);
    } finally {
      store.close();
      lock.release();
    }
  });

  it("3. Privacy guard: privateDetail never leaks into JSON, API responses, or rendered HTML, and reader never queries private_details", async () => {
    const projectId = "proj-privacy";
    const runId = "run-privacy-1";
    const SECRET_TEXT = "SUPER_SECRET_PRIVATE_CUSTOMER_SSN_999_00_1111";

    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    const cursor = { seq: 0, prev: GENESIS_PREV };

    try {
      store.createAndApproveRun({
        runId,
        flowRef: "three-step-demo",
        flowHash: THREE_STEP_HASH,
        flowYamlBytes: THREE_STEP_YAML,
        source: "builtin",
        expectedDecisions: [],
        actorId: "operator-1",
      });
      cursor.seq = 2;
      const evRows = store.getEvents(runId);
      cursor.prev = evRows[evRows.length - 1]!.hash;

      appendNext(store, cursor, {
        runId,
        actor: "runner",
        type: "run_started",
        data: {
          runnerVersion: "0.1.0",
          inputIds: {},
          budget: { tokens: 5000, steps: 10 },
        },
      });

      const att1 = buildBoundedAttemptId("draft", 1);
      const eff1 = buildDeterministicEffectKey(runId, "draft", 1);
      appendNext(
        store,
        cursor,
        {
          runId,
          actor: "runner",
          type: "step_started",
          stepId: "draft",
          attemptId: att1,
          data: { occurrence: 1, effectKey: eff1 },
        },
        SECRET_TEXT,
      );

      appendNext(
        store,
        cursor,
        {
          runId,
          actor: "runner",
          type: "step_failed",
          stepId: "draft",
          attemptId: att1,
          data: { errorCode: "execution_error" },
        },
        `${SECRET_TEXT}_FAILED`,
      );
    } finally {
      store.close();
      lock.release();
    }

    const stream = readFlowCardStream(projectId, runId);
    expect(stream).not.toBeNull();
    const serialized = JSON.stringify(stream);
    expect(serialized).not.toContain(SECRET_TEXT);
    expect(serialized).not.toContain("priv_");
    expect(serialized).not.toContain("privateRef");
    expect(serialized).not.toContain("privateDetailRef");
    expect(serialized).not.toContain("privateErrorRef");

    const apiRes = await callApiFlows(
      `http://localhost/api/flows?project=${projectId}&run=${runId}`,
    );
    expect(apiRes.status).toBe(200);
    const apiBody = await apiRes.text();
    expect(apiBody).not.toContain(SECRET_TEXT);
    expect(apiBody).not.toContain("priv_");

    act(() => {
      root.render(<FlowCardStream stream={stream!} />);
    });
    expect(container.innerHTML).not.toContain(SECRET_TEXT);
    expect(container.innerHTML).not.toContain("priv_");

    // Static guard: reader.server.ts and card-stream.ts never reference private_details
    const readerSrc = fs.readFileSync(
      path.resolve("app/lib/flows/reader.server.ts"),
      "utf8",
    );
    const projectionSrc = fs.readFileSync(
      path.resolve("app/lib/flows/card-stream.ts"),
      "utf8",
    );
    expect(readerSrc).not.toContain("private_details");
    expect(readerSrc).not.toContain("getPrivateDetail");
    expect(projectionSrc).not.toContain("private_details");
  });

  it("4. Decision waiting (waiting_decision), finished terminal banner, budget calculation, and live polling lifecycle", async () => {
    expect(deriveWaitingOn("waiting_decision")).toBe("operator");
    expect(deriveWaitingOn("planned")).toBe("operator");
    expect(deriveWaitingOn("running")).toBeNull();
    expect(deriveWaitingOn("finished")).toBeNull();

    const projectId = "proj-states";
    const waitingRunId = "run-waiting";
    const finishedRunId = "run-finished";

    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });

    try {
      // Run 1: waiting_decision via judgement(final: "decide")
      store.createAndApproveRun({
        runId: waitingRunId,
        flowRef: "three-step-demo",
        flowHash: THREE_STEP_HASH,
        flowYamlBytes: THREE_STEP_YAML,
        source: "builtin",
        expectedDecisions: [],
        actorId: "operator-1",
      });
      const c1 = {
        seq: 2,
        prev: store.getEvents(waitingRunId)[1]!.hash,
      };
      appendNext(store, c1, {
        runId: waitingRunId,
        actor: "runner",
        type: "run_started",
        data: {
          runnerVersion: "0.1.0",
          inputIds: {},
          budget: { tokens: 5000, steps: 10 },
        },
      });
      const wAtt = buildBoundedAttemptId("draft", 1);
      const wEff = buildDeterministicEffectKey(waitingRunId, "draft", 1);
      appendNext(store, c1, {
        runId: waitingRunId,
        actor: "runner",
        type: "step_started",
        stepId: "draft",
        attemptId: wAtt,
        data: { occurrence: 1, effectKey: wEff },
      });
      appendNext(store, c1, {
        runId: waitingRunId,
        actor: "agent",
        type: "step_result",
        stepId: "draft",
        attemptId: wAtt,
        data: { outputs: { status: "ok" }, tokensUsed: 250, wallTimeMs: 120 },
      });
      appendNext(store, c1, {
        runId: waitingRunId,
        actor: "system",
        type: "judgement",
        stepId: "draft",
        attemptId: wAtt,
        data: {
          final: "decide",
          ruleHits: ["step_passed"],
          reasonCodes: ["ok"],
          engineTokens: 0,
        },
      });

      // Run 2: full completion with check step -> run_finished(done)
      store.createAndApproveRun({
        runId: finishedRunId,
        flowRef: "three-step-demo",
        flowHash: THREE_STEP_HASH,
        flowYamlBytes: THREE_STEP_YAML,
        source: "library",
        expectedDecisions: [],
        actorId: "operator-1",
      });
      const c2 = {
        seq: 2,
        prev: store.getEvents(finishedRunId)[1]!.hash,
      };
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "runner",
        type: "run_started",
        data: {
          runnerVersion: "0.1.0",
          inputIds: {},
          budget: { tokens: 5000, steps: 10 },
        },
      });

      // draft
      const fDraftAtt = buildBoundedAttemptId("draft", 1);
      const fDraftEff = buildDeterministicEffectKey(finishedRunId, "draft", 1);
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "runner",
        type: "step_started",
        stepId: "draft",
        attemptId: fDraftAtt,
        data: { occurrence: 1, effectKey: fDraftEff },
      });
      const art = store.writeAndRecordArtifact({
        artifactId: "art_fin_1",
        runId: finishedRunId,
        stepId: "draft",
        attemptId: fDraftAtt,
        name: "output_file",
        mediaType: "text/plain",
        bytes: Buffer.from("done-payload", "utf8"),
      });
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "runner",
        type: "artefact_recorded",
        stepId: "draft",
        attemptId: fDraftAtt,
        data: {
          artefactId: "art_fin_1",
          sha256: art.contentHash,
          sizeBytes: art.size,
        },
      });
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "agent",
        type: "step_result",
        stepId: "draft",
        attemptId: fDraftAtt,
        data: {
          outputs: { status: "ok", output_file: art.contentHash },
          tokensUsed: 400,
          wallTimeMs: 200,
        },
      });
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "system",
        type: "judgement",
        stepId: "draft",
        attemptId: fDraftAtt,
        data: {
          final: "continue",
          ruleHits: ["step_passed"],
          reasonCodes: ["ok"],
          engineTokens: 0,
        },
      });

      // review
      const fRevAtt = buildBoundedAttemptId("review", 1);
      const fRevEff = buildDeterministicEffectKey(finishedRunId, "review", 1);
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "runner",
        type: "step_started",
        stepId: "review",
        attemptId: fRevAtt,
        data: { occurrence: 1, effectKey: fRevEff },
      });
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "agent",
        type: "step_result",
        stepId: "review",
        attemptId: fRevAtt,
        data: {
          outputs: { verdict: "approve" },
          tokensUsed: 150,
          wallTimeMs: 80,
        },
      });
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "system",
        type: "judgement",
        stepId: "review",
        attemptId: fRevAtt,
        data: {
          final: "continue",
          ruleHits: ["step_passed"],
          reasonCodes: ["ok"],
          engineTokens: 0,
        },
      });

      // verify (check step)
      const fChkAtt = buildBoundedAttemptId("verify", 1);
      const fChkEff = buildDeterministicEffectKey(finishedRunId, "verify", 1);
      appendNext(store, c2, {
        runId: finishedRunId,
        actor: "runner",
        type: "step_started",
        stepId: "verify",
        attemptId: fChkAtt,
        data: { occurrence: 1, effectKey: fChkEff },
      });

      store.appendChainedBatch(finishedRunId, [
        (seq, prev) => ({
          event: {
            v: 1,
            runId: finishedRunId,
            seq,
            eventId: `ev_${seq}`,
            prev,
            at: makeIso(seq),
            actor: "runner",
            stepId: "verify",
            attemptId: fChkAtt,
            type: "check_result",
            data: {
              checkId: "check_nonempty",
              targetSha: art.contentHash,
              passed: true,
            },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1,
            runId: finishedRunId,
            seq,
            eventId: `ev_${seq}`,
            prev,
            at: makeIso(seq),
            actor: "runner",
            stepId: "verify",
            attemptId: fChkAtt,
            type: "step_result",
            data: {
              outputs: { check: "passed" },
              tokensUsed: 0,
              wallTimeMs: 12,
            },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1,
            runId: finishedRunId,
            seq,
            eventId: `ev_${seq}`,
            prev,
            at: makeIso(seq),
            actor: "system",
            stepId: "verify",
            attemptId: fChkAtt,
            type: "judgement",
            data: {
              final: "continue",
              ruleHits: ["check_passed"],
              reasonCodes: ["ok"],
              engineTokens: 0,
            },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1,
            runId: finishedRunId,
            seq,
            eventId: `ev_${seq}`,
            prev,
            at: makeIso(seq),
            actor: "system",
            type: "run_finished",
            data: {
              outcome: "done",
              reasonCode: "completed",
            },
          },
        }),
      ]);
    } finally {
      store.close();
      lock.release();
    }

    const runs = listFlowRuns(projectId);
    const waitingSummary = runs.find((r) => r.runId === waitingRunId);
    const finishedSummary = runs.find((r) => r.runId === finishedRunId);
    expect(waitingSummary?.waitingOn).toBe("operator");
    expect(finishedSummary?.waitingOn).toBeNull();

    const waitingStream = readFlowCardStream(projectId, waitingRunId)!;
    expect(waitingStream.runStatus).toBe("waiting_decision");
    expect(waitingStream.waitingOn).toBe("operator");
    expect(waitingStream.activeDecision).toEqual({
      stepId: "draft",
      reasonCode: "ok",
      options: [
        { key: "continue", label: "Continue" },
        { key: "stop", label: "Stop" },
      ],
    });

    const finishedStream = readFlowCardStream(projectId, finishedRunId)!;
    expect(finishedStream.runStatus).toBe("finished");
    expect(finishedStream.waitingOn).toBeNull();
    expect(finishedStream.terminalOutcome).toBe("done");
    expect(finishedStream.terminalReason).toBe("completed");
    expect(finishedStream.budget).toEqual({
      tokensUsed: 550,
      tokensTotal: 5000,
      stepsUsed: 3,
      stepsTotal: 10,
    });

    // Live polling test: start with waitingStream, poll updates to finishedStream, then stops
    vi.useFakeTimers();
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, stream: finishedStream }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    act(() => {
      root.render(<FlowCardStream stream={waitingStream} />);
    });

    expect(container.querySelector('[data-testid="flow-waiting-on"]')?.textContent).toContain(
      "operator",
    );
    expect(container.querySelector('[data-testid="flow-card-decision"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="flow-terminal-banner"]')).toBeNull();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(container.querySelector('[data-testid="flow-run-status"]')?.textContent).toBe("finished");
    expect(container.querySelector('[data-testid="flow-terminal-banner"]')?.textContent).toContain(
      "done",
    );
    expect(container.querySelector('[data-testid="flow-terminal-banner"]')?.textContent).toContain(
      "completed",
    );

    // Advance more time: polling MUST have stopped on terminal status
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4500);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("5. Invalid/traversal IDs fail closed (400), symlinked project dir / flows.db refused, missing DATA_ROOT / absent DB returns empty/null gracefully", async () => {
    // Missing DATA_ROOT
    vi.stubEnv("DATA_ROOT", "");
    expect(listFlowProjects()).toEqual([]);
    expect(listFlowRuns("proj-missing")).toEqual([]);
    expect(readFlowCardStream("proj-missing", "run-1")).toBeNull();

    // Traversal IDs fail closed even without DATA_ROOT
    expect(() => listFlowRuns("../etc")).toThrow(InvalidFlowQueryError);
    expect(() => readFlowCardStream("proj", "../secret")).toThrow(InvalidFlowQueryError);

    vi.stubEnv("DATA_ROOT", scratchDir);

    // Absent DB returns empty/null gracefully
    expect(listFlowProjects()).toEqual([]);
    expect(listFlowRuns("nonexistent-proj")).toEqual([]);
    expect(readFlowCardStream("nonexistent-proj", "nonexistent-run")).toBeNull();

    const missingRunRes = await callApiFlows(
      "http://localhost/api/flows?project=nonexistent-proj&run=nonexistent-run",
    );
    expect(missingRunRes.status).toBe(404);

    const badProjRes = await callApiFlows(
      "http://localhost/api/flows?project=../bad",
    );
    expect(badProjRes.status).toBe(400);

    const badRunRes = await callApiFlows(
      "http://localhost/api/flows?project=valid&run=BAD/RUN",
    );
    expect(badRunRes.status).toBe(400);

    const runWithoutProjRes = await callApiFlows(
      "http://localhost/api/flows?run=only-run",
    );
    expect(runWithoutProjRes.status).toBe(400);

    // Symlinked project directory and symlinked flows.db refused
    const flowsDir = path.join(scratchDir, "flows");
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-outside-"));
    try {
      fs.mkdirSync(flowsDir, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(flowsDir, "sym-proj"));

      const symDbProj = path.join(flowsDir, "sym-db-proj");
      fs.mkdirSync(symDbProj, { recursive: true });
      const outsideDb = path.join(outsideDir, "outside.db");
      fs.writeFileSync(outsideDb, "not-a-db");
      fs.symlinkSync(outsideDb, path.join(symDbProj, "flows.db"));

      expect(listFlowProjects()).toEqual([]);
      expect(() => listFlowRuns("sym-proj")).toThrow(FlowIntegrityError);
      expect(() => readFlowCardStream("sym-proj", "run-1")).toThrow(FlowIntegrityError);
      expect(() => listFlowRuns("sym-db-proj")).toThrow(FlowIntegrityError);
      expect(() => readFlowCardStream("sym-db-proj", "run-1")).toThrow(FlowIntegrityError);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }

    // Empty state renders cleanly in /flows route
    const emptyLoaderRes = (await callFlowsRoute("http://localhost/flows")) as {
      projects: string[];
      selectedProject: string | null;
      runs: unknown[];
      selectedRunId: string | null;
      stream: FlowCardStreamView | null;
      error: string | null;
    };
    const Stub = createRoutesStub([
      {
        path: "/flows",
        Component: () => (
          <FlowsRoute
            loaderData={emptyLoaderRes as never}
            params={{}}
            matches={[] as never}
          />
        ),
      },
    ]);
    act(() => {
      root.render(<Stub initialEntries={["/flows"]} />);
    });
    expect(container.querySelector('[data-testid="flows-empty"]')).not.toBeNull();
  });

  it("6. Tampered ledger / hash-chain corruption raises FlowIntegrityError and returns HTTP 422 without leaking host paths", async () => {
    const projectId = "proj-corrupt";
    const runId = "run-corrupt-1";

    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    const dbPath = store.dbPath;
    try {
      store.createAndApproveRun({
        runId,
        flowRef: "three-step-demo",
        flowHash: THREE_STEP_HASH,
        flowYamlBytes: THREE_STEP_YAML,
        source: "builtin",
        expectedDecisions: [],
        actorId: "operator-1",
      });
    } finally {
      store.close();
      lock.release();
    }

    const rawDb = new Database(dbPath);
    try {
      rawDb
        .prepare(`UPDATE flow_events SET line = '{"tampered":true}' WHERE run_id = ? AND seq = 1`)
        .run(runId);
    } finally {
      rawDb.close();
    }

    expect(() => listFlowRuns(projectId)).toThrow(FlowIntegrityError);
    expect(() => readFlowCardStream(projectId, runId)).toThrow(FlowIntegrityError);

    const apiRunsRes = await callApiFlows(
      `http://localhost/api/flows?project=${projectId}`,
    );
    expect(apiRunsRes.status).toBe(422);
    const apiRunsText = await apiRunsRes.text();
    expect(apiRunsText).not.toContain(scratchDir);
    expect(JSON.parse(apiRunsText)).toEqual({
      ok: false,
      error: "Flow ledger failed integrity verification.",
    });

    const apiStreamRes = await callApiFlows(
      `http://localhost/api/flows?project=${projectId}&run=${runId}`,
    );
    expect(apiStreamRes.status).toBe(422);
    const apiStreamText = await apiStreamRes.text();
    expect(apiStreamText).not.toContain(scratchDir);

    // /flows route returns 422 data response with error banner inside shell
    const routeResult = (await callFlowsRoute(
      `http://localhost/flows?project=${projectId}&run=${runId}`,
    )) as { init: { status: number } | null; data: { error: string | null } };
    expect(routeResult.init?.status).toBe(422);
    expect(routeResult.data.error).toBe("Flow ledger failed integrity verification.");

    const Stub = createRoutesStub([
      {
        path: "/flows",
        Component: () => (
          <FlowsRoute
            loaderData={routeResult.data as never}
            params={{}}
            matches={[] as never}
          />
        ),
      },
    ]);
    act(() => {
      root.render(<Stub initialEntries={[`/flows?project=${projectId}&run=${runId}`]} />);
    });
    const errorEl = container.querySelector('[data-testid="flows-error"]');
    expect(errorEl).not.toBeNull();
    expect(errorEl?.textContent).toContain("Flow ledger failed integrity verification.");
    expect(errorEl?.textContent).not.toContain(scratchDir);
  });

  it("7. DELETE /api/flows returns 405 with Allow: GET, POST and cross-origin POST returns 403", async () => {
    const deleteActionRes = await apiFlowsAction({
      request: new Request("http://localhost/api/flows", { method: "DELETE" }),
      url: new URL("http://localhost/api/flows"),
      params: {},
      context: {},
      pattern: "/api/flows",
    });
    expect(deleteActionRes.status).toBe(405);
    expect(deleteActionRes.headers.get("Allow")).toBe("GET, POST");
    expect(await deleteActionRes.json()).toEqual({
      ok: false,
      error: "Method not allowed.",
    });

    const deleteLoaderRes = await callApiFlows("http://localhost/api/flows", {
      method: "DELETE",
    });
    expect(deleteLoaderRes.status).toBe(405);
    expect(deleteLoaderRes.headers.get("Allow")).toBe("GET, POST");

    try {
      await apiFlowsAction({
        request: new Request("http://localhost/api/flows", {
          method: "POST",
          headers: {
            host: "localhost",
            origin: "https://evil.example",
            "sec-fetch-site": "cross-site",
          },
        }),
        url: new URL("http://localhost/api/flows"),
        params: {},
        context: {},
        pattern: "/api/flows",
      });
      expect.unreachable("Expected 403 Response for cross-origin POST");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      expect((thrown as Response).status).toBe(403);
    }
  });

  it("pure projectFlowCardStream tolerates unstarted planned run cleanly", () => {
    const view = projectFlowCardStream({
      projectId: "p1",
      runId: "r1",
      flowHash: THREE_STEP_HASH,
      flow: {
        flow: "three-step-demo",
        version: 1,
        steps: [{ id: "draft", type: "agent" }],
      },
      events: [],
      state: {
        runId: "r1",
        status: "planned",
        currentStepId: null,
        currentAttemptId: null,
        activeDecision: null,
        stepStates: {},
        budgetUsed: { tokens: 0, steps: 0 },
        budgetRemaining: { tokens: 1000000, steps: 100 },
        recordedArtefacts: {},
        runPlanned: null,
        terminalOutcome: null,
        terminalReason: null,
        activeHandoff: null,
        closedHandoffIds: [],
        rewindsUsed: 0,
        lastRewind: null,
        nextStepId: null,
      },
    });
    expect(view.waitingOn).toBe("operator");
    expect(view.planningCard.approved).toBe(false);
    expect(view.stepCards[0]?.cardState).toBe("pending");
  });

  it("R1-1: transient HTTP 500 JSON poll error surfaces flows-poll-error and recovers on next poll", async () => {
    const activeView = projectFlowCardStream({
      projectId: "p-poll",
      runId: "r-poll",
      flowHash: THREE_STEP_HASH,
      flow: {
        flow: "three-step-demo",
        version: 1,
        steps: [{ id: "draft", type: "agent" }],
      },
      events: [],
      state: {
        runId: "r-poll",
        status: "running",
        currentStepId: "draft",
        currentAttemptId: "att-1",
        activeDecision: null,
        stepStates: {},
        budgetUsed: { tokens: 0, steps: 0 },
        budgetRemaining: { tokens: 5000, steps: 10 },
        recordedArtefacts: {},
        runPlanned: null,
        terminalOutcome: null,
        terminalReason: null,
        activeHandoff: null,
        closedHandoffIds: [],
        rewindsUsed: 0,
        lastRewind: null,
        nextStepId: null,
      },
    });
    const finishedView: FlowCardStreamView = {
      ...activeView,
      runStatus: "finished",
      waitingOn: null,
      terminalOutcome: "done",
      terminalReason: "completed",
    };

    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ ok: false, error: "Could not read flow stream." }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ ok: true, stream: finishedView }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    act(() => {
      root.render(<FlowCardStream stream={activeView} />);
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
    });

    const errBanner = container.querySelector('[data-testid="flows-poll-error"]');
    expect(errBanner).not.toBeNull();
    expect(errBanner?.textContent).toBe("Could not read flow stream.");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1550);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(container.querySelector('[data-testid="flows-poll-error"]')).toBeNull();
    expect(container.querySelector('[data-testid="flow-run-status"]')?.textContent).toBe(
      "finished",
    );
  });

  it("R1-4: AppShell renders /flows navigation link in both desktop top bar and mobile strip", () => {
    const Stub = createRoutesStub([
      {
        path: "/",
        Component: () => (
          <AppShell agents={[]} needsItems={[]} needsCount={0} workCards={[]} />
        ),
      },
    ]);
    act(() => {
      root.render(<Stub initialEntries={["/"]} />);
    });

    const flowLinks = Array.from(
      container.querySelectorAll<HTMLAnchorElement>('a[href="/flows"]'),
    );
    expect(flowLinks).toHaveLength(2);
    const mobileStripLink = container.querySelector<HTMLAnchorElement>(
      '[data-testid="agent-strip-flows"]',
    );
    expect(mobileStripLink).not.toBeNull();
    expect(mobileStripLink?.getAttribute("href")).toBe("/flows");
    expect(mobileStripLink?.getAttribute("aria-label")).toBe("Flows");
  });

  it("D1: DATA_ROOT inside a git worktree without flows/ returns empty state, while creating flows/ inside that git worktree still refuses", async () => {
    const gitWorktree = path.join(scratchDir, "sandbox-repo");
    const devDataRoot = path.join(gitWorktree, ".runtime", "data");
    fs.mkdirSync(path.join(gitWorktree, ".git"), { recursive: true });
    fs.writeFileSync(path.join(gitWorktree, ".git", "HEAD"), "ref: refs/heads/main\n");
    fs.mkdirSync(devDataRoot, { recursive: true });
    vi.stubEnv("DATA_ROOT", devDataRoot);

    // Without <devDataRoot>/flows, read-only queries return the clean empty state
    expect(listFlowProjects()).toEqual([]);
    expect(listFlowRuns("proj-dev")).toEqual([]);
    expect(readFlowCardStream("proj-dev", "run-dev")).toBeNull();

    const apiEmptyRes = await callApiFlows("http://localhost/api/flows");
    expect(apiEmptyRes.status).toBe(200);
    expect(await apiEmptyRes.json()).toEqual({ ok: true, projects: [] });

    const routeEmptyData = (await callFlowsRoute("http://localhost/flows")) as {
      projects: string[];
      selectedProject: string | null;
      runs: unknown[];
      selectedRunId: string | null;
      stream: FlowCardStreamView | null;
      catalog: { flows: Array<{ flowRef: string; source: string }>; drafts: unknown[] };
      error: string | null;
    };
    expect(routeEmptyData).toMatchObject({
      projects: [],
      selectedProject: null,
      runs: [],
      selectedRunId: null,
      stream: null,
      error: null,
    });
    expect(routeEmptyData.catalog.flows.some((f) => f.flowRef === "ticket-to-pr")).toBe(true);

    const Stub = createRoutesStub([
      {
        path: "/flows",
        Component: () => (
          <FlowsRoute
            loaderData={routeEmptyData as never}
            params={{}}
            matches={[] as never}
          />
        ),
      },
    ]);
    act(() => {
      root.render(<Stub initialEntries={["/flows"]} />);
    });
    expect(container.querySelector('[data-testid="flows-empty"]')).not.toBeNull();

    // Once <devDataRoot>/flows exists inside the git worktree, fail closed and refuse
    fs.mkdirSync(path.join(devDataRoot, "flows"), { recursive: true });
    expect(() => listFlowProjects()).toThrow(UnsafeFilesystemError);
    expect(() => listFlowRuns("proj-dev")).toThrow(UnsafeFilesystemError);
    expect(() => readFlowCardStream("proj-dev", "run-dev")).toThrow(UnsafeFilesystemError);

    const apiRefusedRes = await callApiFlows("http://localhost/api/flows");
    expect(apiRefusedRes.status).toBe(500);

    const routeRefusedRes = (await callFlowsRoute("http://localhost/flows")) as {
      init: { status: number } | null;
      data: { error: string | null };
    };
    expect(routeRefusedRes.init?.status).toBe(500);
  });
});
