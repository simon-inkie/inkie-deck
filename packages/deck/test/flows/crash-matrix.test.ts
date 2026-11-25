import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import { acquireOwnerLock, isOwnerLocked } from "../../app/lib/flows/owner.server.js";
import {
  buildCollisionFreeArtifactId,
  planAndApproveRun,
  runFlow,
  type CrashPoint,
} from "../../app/lib/flows/runner.server.js";
import {
  buildBoundedAttemptId,
  buildDeterministicEffectKey,
  HashChainCorruptionError,
  IllegalFlowTransitionError,
  openFlowsStore,
} from "../../app/lib/flows/store.server.js";

const CHECKED_IN_STUB_YAML = fs.readFileSync(
  path.resolve(__dirname, "fixtures/two-step-stub.yaml"),
  "utf8",
);

const DECK_PKG_DIR = path.resolve(__dirname, "../..");
const CHILD_SCRIPT = path.resolve(__dirname, "fixtures/run-flow-child.ts");

function runChildRunner(
  projectId: string,
  runId: string,
  dataRoot: string,
  options?: { crashPoint?: CrashPoint; extraEnv?: Record<string, string> },
): { status: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string } {
  const res = spawnSync(process.execPath, ["--import", "tsx", CHILD_SCRIPT, projectId, runId, dataRoot], {
    cwd: DECK_PKG_DIR,
    encoding: "utf8",
    timeout: 15_000,
    env: {
      ...process.env,
      ...(options?.crashPoint ? { FLOW_CRASH_POINT: options.crashPoint } : {}),
      ...(options?.extraEnv ?? {}),
    },
  });
  return {
    status: res.status,
    signal: res.signal,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

describe("Real-Process Runner Crash Matrix (K1 through K10)", { timeout: 30_000 }, () => {
  let scratchDir: string;
  const projectId = "crash-matrix-proj";

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-crash-"));
  });

  afterEach(() => {
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("Golden End-to-End (real subprocess): checked-in two-step-stub.yaml finishes cleanly with linked artefact and check", () => {
    const runId = "run-golden-child";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    const child = runChildRunner(projectId, runId, scratchDir);
    expect(child.status).toBe(0);
    expect(child.signal).toBeNull();
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);

    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(loaded.state.status).toBe("finished");
    expect(loaded.state.terminalOutcome).toBe("done");
    expect(loaded.state.terminalReason).toBe("completed");
    expect(loaded.verifiedArtefacts.size).toBe(1);
    expect(loaded.state.stepStates["generate"]?.status).toBe("passed");
    expect(loaded.state.stepStates["verify"]?.status).toBe("passed");

    const artEv = loaded.events.find((e) => e.type === "artefact_recorded");
    const chkEv = loaded.events.find((e) => e.type === "check_result");
    expect(artEv?.type === "artefact_recorded" && chkEv?.type === "check_result").toBe(true);
    if (artEv?.type === "artefact_recorded" && chkEv?.type === "check_result") {
      expect(chkEv.data.checkId).toBe("check_exists");
      expect(chkEv.data.passed).toBe(true);
      expect(chkEv.data.targetSha).toBe(artEv.data.sha256);
    }
  });

  it("K1: real SIGKILL right after durable step_started intent -> restart records step_outcome_unknown with ZERO redispatch", async () => {
    const runId = "run-k1";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    const killed = runChildRunner(projectId, runId, scratchDir, { crashPoint: "K1_AFTER_INTENT" });
    expect(killed.signal).toBe("SIGKILL");
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);

    let dispatchesOnRecovery = 0;
    const recovered = await runFlow(projectId, runId, {
      dataRoot: scratchDir,
      onStepDispatch: () => {
        dispatchesOnRecovery += 1;
      },
    });
    expect(recovered.dispatchedSteps).toHaveLength(0);
    expect(recovered.finalStatus).toBe("stopped");
    expect(dispatchesOnRecovery).toBe(0);

    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(loaded.events.some((e) => e.type === "step_outcome_unknown")).toBe(true);
    expect(loaded.events.filter((e) => e.type === "step_started")).toHaveLength(1);
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);
  });

  it("K2: real SIGKILL after durable artefact file rename before SQL receipt -> orphan file on disk ignored by loader and runner", async () => {
    const runId = "run-k2-real";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    // Real runner child killed inside writeAndRecordArtifact right after atomic rename, BEFORE recordArtifact SQL insert
    const killed = runChildRunner(projectId, runId, scratchDir, {
      extraEnv: { FLOW_K2_KILL_AFTER_FILE_BEFORE_RECEIPT: "1" },
    });
    expect(killed.signal).toBe("SIGKILL");

    const artDir = path.join(scratchDir, "flows", projectId, "artifacts", runId);
    const filesOnDisk = fs.readdirSync(artDir);
    expect(filesOnDisk.length).toBeGreaterThanOrEqual(1);

    // Zero SQL receipts exist; loader MUST NOT treat the unreceipted orphan file as verified
    const mid = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(mid.verifiedArtefacts.size).toBe(0);
    expect(mid.events.some((e) => e.type === "artefact_recorded")).toBe(false);

    // Recovery records step_outcome_unknown cleanly with zero redispatch
    const recovered = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(recovered.dispatchedSteps).toHaveLength(0);
    expect(recovered.finalStatus).toBe("stopped");
  });

  it("K3: real SIGKILL after artefact_recorded before step_result -> restart records step_outcome_unknown, preserves verified artefact bytes", async () => {
    const runId = "run-k3";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    const killed = runChildRunner(projectId, runId, scratchDir, { crashPoint: "K3_AFTER_ARTEFACT" });
    expect(killed.signal).toBe("SIGKILL");

    const midState = loadRunState(projectId, runId, { dataRoot: scratchDir });
    const artEv = midState.events.find((e) => e.type === "artefact_recorded");
    expect(artEv).toBeDefined();
    expect(midState.events.some((e) => e.type === "step_result")).toBe(false);

    if (artEv?.type === "artefact_recorded") {
      const artPath = path.join(scratchDir, "flows", projectId, "artifacts", runId, artEv.data.sha256);
      const actualBytes = fs.readFileSync(artPath);
      expect(crypto.createHash("sha256").update(actualBytes).digest("hex")).toBe(artEv.data.sha256);
      expect(actualBytes.length).toBe(artEv.data.sizeBytes);
    }

    const recovered = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(recovered.dispatchedSteps).toHaveLength(0);
    expect(recovered.finalStatus).toBe("stopped");

    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(loaded.events.some((e) => e.type === "step_outcome_unknown")).toBe(true);
    expect(loaded.events.filter((e) => e.type === "step_started")).toHaveLength(1);
  });

  it("K4: real SIGKILL after step_result before judgement -> restart records identical judgement ruleHits without re-executing step 1", async () => {
    const runId = "run-k4";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    const killed = runChildRunner(projectId, runId, scratchDir, { crashPoint: "K4_AFTER_OUTCOME" });
    expect(killed.signal).toBe("SIGKILL");

    const preRestart = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(preRestart.events.some((e) => e.type === "step_result" && e.stepId === "generate")).toBe(true);
    expect(preRestart.events.some((e) => e.type === "judgement" && e.stepId === "generate")).toBe(false);

    const recovered = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(recovered.finalStatus).toBe("finished");
    expect(recovered.dispatchedSteps.map((s) => s.stepId)).toEqual(["verify"]);

    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(loaded.events.filter((e) => e.type === "step_started" && e.stepId === "generate")).toHaveLength(1);
    const genJudgement = loaded.events.find((e) => e.type === "judgement" && e.stepId === "generate");
    expect(genJudgement?.type === "judgement" && genJudgement.data.ruleHits).toEqual(["step_passed"]);
    expect(loaded.state.terminalOutcome).toBe("done");
  });

  it("K5: real SIGKILL inside production runFlow public+private append mid-tx rolls back BOTH tables atomically while keeping prior artefact", () => {
    const runId = "run-k5-runner";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    // Real runner child acquires ownership and kills mid-tx during step_result + privateDetail insert
    const killed = runChildRunner(projectId, runId, scratchDir, {
      extraEnv: { FLOW_K5_KILL_MID_TX: "1" },
    });
    expect(killed.signal).toBe("SIGKILL");
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);

    const store = openFlowsStore(projectId, { dataRoot: scratchDir, readonly: true });
    try {
      const events = store.getParsedEvents(runId);
      // Prior artefact_recorded survived (proving kill hit step_result, not earlier)
      expect(events.some((e) => e.type === "artefact_recorded")).toBe(true);
      // step_result rolled back completely alongside its private_details row
      expect(events.some((e) => e.type === "step_result")).toBe(false);
    } finally {
      store.close();
    }

    const rawDb = new Database(path.join(scratchDir, "flows", projectId, "flows.db"), { readonly: true });
    try {
      const privCount = rawDb
        .prepare(`SELECT COUNT(*) AS c FROM private_details WHERE run_id = ?`)
        .get(runId) as { c: number };
      expect(privCount.c).toBe(0);
    } finally {
      rawDb.close();
    }
  });

  it("K6: interior tampering refused by real child runner with HashChainCorruptionError AND releases flows.owner cleanly", async () => {
    const runId = "run-k6";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    const rawDb = new Database(path.join(scratchDir, "flows", projectId, "flows.db"));
    try {
      rawDb.prepare(`UPDATE flow_events SET line = '{"tampered":1}' WHERE run_id = ? AND seq = 1`).run(runId);
    } finally {
      rawDb.close();
    }

    const child = runChildRunner(projectId, runId, scratchDir);
    expect(child.status).toBe(1);
    expect(child.stderr).toContain("HashChainCorruptionError");
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);

    expect(() => openFlowsStore(projectId, { dataRoot: scratchDir, readonly: true })).toThrow(HashChainCorruptionError);
    await expect(runFlow(projectId, runId, { dataRoot: scratchDir })).rejects.toThrow(HashChainCorruptionError);

    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);
    const reacquired = acquireOwnerLock(projectId, scratchDir);
    reacquired.release();
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);
  });

  it("K7: occurrence allocation reads INSIDE BEGIN IMMEDIATE under write contention, survives SIGKILL, and never collides on prior receipt", async () => {
    const runId = "run-k7";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    // Part A: Real BEGIN IMMEDIATE contention proof (moving occurrence read before BEGIN IMMEDIATE fails this test!)
    const contendRunId = "run-k7-tx-order";
    planAndApproveRun({ projectId, runId: contendRunId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });
    const contendLock = acquireOwnerLock(projectId, scratchDir);
    const contendStore = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: contendLock });
    try {
      const ev2 = contendStore.getEvents(contendRunId)[1]!;
      const r3 = contendStore.appendEvent({
        v: 1, runId: contendRunId, seq: 3, eventId: "ev_s3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 10000, steps: 10 } },
      });

      const dbPath = contendStore.dbPath;
      const lockedLatch = path.join(scratchDir, "k7-locked.latch");
      // Separate OS process acquires BEGIN IMMEDIATE on flows.db, signals latch, holds write lock 250ms,
      // inserts a valid completed occurrence 1 (step_started + step_failed + judgement(notify)), and commits.
      const writerScript = `
        const crypto = require("node:crypto");
        const fs = require("node:fs");
        const Database = require("better-sqlite3");
        function canon(obj) {
          if (obj === null || typeof obj !== "object") return JSON.stringify(obj);
          if (Array.isArray(obj)) return "[" + obj.map((v) => v === undefined ? "null" : canon(v)).join(",") + "]";
          return "{" + Object.keys(obj).filter((k) => obj[k] !== undefined).sort().map((k) => JSON.stringify(k) + ":" + canon(obj[k])).join(",") + "}";
        }
        const db = new Database(${JSON.stringify(dbPath)}, { timeout: 5000 });
        db.exec("BEGIN IMMEDIATE;");
        fs.writeFileSync(${JSON.stringify(lockedLatch)}, "1");
        const until = Date.now() + 250;
        while (Date.now() < until) {}
        const runId = ${JSON.stringify(contendRunId)};
        const attId = "att_" + crypto.createHash("sha256").update("generate:1").digest("hex").slice(0, 12) + "_1";
        const effKey = "eff_" + crypto.createHash("sha256").update(JSON.stringify(["deck-flow-effect-key-v1", runId, "generate", 1])).digest("hex").slice(0, 24);
        const now = Date.now();
        const at = new Date(now).toISOString();
        let seq = 3;
        let prev = ${JSON.stringify(r3.hash)};
        const insert = db.prepare("INSERT INTO flow_events (run_id, seq, step_id, attempt_id, phase, event_type, line, hash, prev_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
        const evs = [
          { v: 1, runId, seq: ++seq, eventId: "ev_c4", prev, at, actor: "runner", type: "step_started", stepId: "generate", attemptId: attId, data: { occurrence: 1, effectKey: effKey } },
          { v: 1, runId, seq: ++seq, eventId: "ev_c5", prev: "", at, actor: "runner", type: "step_failed", stepId: "generate", attemptId: attId, data: { errorCode: "execution_error" } },
          { v: 1, runId, seq: ++seq, eventId: "ev_c6", prev: "", at, actor: "system", type: "judgement", stepId: "generate", attemptId: attId, data: { final: "notify", ruleHits: ["retry_step"], reasonCodes: ["retry"], engineTokens: 0 } },
        ];
        for (const ev of evs) {
          ev.prev = prev;
          const line = canon(ev);
          const hash = crypto.createHash("sha256").update(line, "utf8").digest("hex");
          insert.run(runId, ev.seq, ev.stepId, ev.attemptId, ev.type, ev.type, line, hash, ev.prev, now);
          prev = hash;
        }
        db.exec("COMMIT;");
        db.close();
      `;
      const writerChild = spawn(process.execPath, ["-e", writerScript], { cwd: DECK_PKG_DIR, stdio: "inherit" });
      const writerDone = new Promise<number | null>((resolve) => writerChild.once("exit", (code) => resolve(code)));
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(lockedLatch) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 10));
      }
      expect(fs.existsSync(lockedLatch)).toBe(true);

      // Call allocateAndAppendStepIntent WHILE writerChild holds BEGIN IMMEDIATE!
      // It MUST block until writerChild commits occurrence 1, read inside BEGIN IMMEDIATE, and allocate occurrence 2.
      const allocated = contendStore.allocateAndAppendStepIntent({
        runId: contendRunId,
        stepId: "generate",
      });
      expect(await writerDone).toBe(0);
      expect(allocated.occurrence).toBe(2);
      expect(allocated.attemptId).toMatch(/^att_[a-f0-9]{12}_2$/);
    } finally {
      contendStore.close();
      contendLock.release();
    }

    // Part B: Real SIGKILL across occurrence 2 allocation + distinct receipt on retry
    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    try {
      const head = store.getEvents(runId)[1]!;
      store.appendEvent({
        v: 1, runId, seq: 3, eventId: "ev_s", prev: head.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 10000, steps: 10 } },
      });

      const first = store.allocateAndAppendStepIntent({ runId, stepId: "generate" });
      expect(first.occurrence).toBe(1);
      expect(first.attemptId).toMatch(/^att_[a-f0-9]{12}_1$/);

      const artId1 = buildCollisionFreeArtifactId("generate", "output_file", 1);
      const rec1 = store.writeAndRecordArtifact({
        artifactId: artId1,
        runId, stepId: "generate", attemptId: first.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("attempt 1 output\n", "utf8"),
      });
      const artEv = store.appendEvent({
        v: 1, runId, seq: first.seq + 1, eventId: "ev_a1", prev: first.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: first.attemptId,
        data: { artefactId: artId1, sha256: rec1.contentHash, sizeBytes: rec1.size },
      });
      const failEv = store.appendEvent({
        v: 1, runId, seq: artEv.seq + 1, eventId: "ev_f1", prev: artEv.hash,
        at: new Date().toISOString(), actor: "runner", type: "step_failed",
        stepId: "generate", attemptId: first.attemptId,
        data: { errorCode: "execution_error" },
      });
      store.appendEvent({
        v: 1, runId, seq: failEv.seq + 1, eventId: "ev_j1", prev: failEv.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: first.attemptId,
        data: { final: "notify", ruleHits: ["retry_step"], reasonCodes: ["retry"], engineTokens: 0 },
      });
    } finally {
      store.close();
      lock.release();
    }

    // Real child runner SIGKILL right after durably allocating occurrence 2 intent
    const killedOcc2 = runChildRunner(projectId, runId, scratchDir, { crashPoint: "K1_AFTER_INTENT" });
    expect(killedOcc2.signal).toBe("SIGKILL");
    const afterKill = loadRunState(projectId, runId, { dataRoot: scratchDir });
    const genStartsAfterKill = afterKill.events.filter((e) => e.type === "step_started" && e.stepId === "generate");
    expect(genStartsAfterKill).toHaveLength(2);
    expect(genStartsAfterKill[1]?.type === "step_started" && genStartsAfterKill[1].data.occurrence).toBe(2);

    // Separate retry run proves occurrence 2 writes a distinct receipt ID and finishes cleanly without PK collision
    const retryRunId = "run-k7-retry-complete";
    planAndApproveRun({ projectId, runId: retryRunId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });
    const rLock = acquireOwnerLock(projectId, scratchDir);
    const rStore = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: rLock });
    try {
      const head = rStore.getEvents(retryRunId)[1]!;
      rStore.appendEvent({
        v: 1, runId: retryRunId, seq: 3, eventId: "ev_rs", prev: head.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 10000, steps: 10 } },
      });
      const first = rStore.allocateAndAppendStepIntent({ runId: retryRunId, stepId: "generate" });
      const artId1 = buildCollisionFreeArtifactId("generate", "output_file", 1);
      const rec1 = rStore.writeAndRecordArtifact({
        artifactId: artId1,
        runId: retryRunId, stepId: "generate", attemptId: first.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("attempt 1 output\n", "utf8"),
      });
      const artEv = rStore.appendEvent({
        v: 1, runId: retryRunId, seq: first.seq + 1, eventId: "ev_ra1", prev: first.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: first.attemptId,
        data: { artefactId: artId1, sha256: rec1.contentHash, sizeBytes: rec1.size },
      });
      const failEv = rStore.appendEvent({
        v: 1, runId: retryRunId, seq: artEv.seq + 1, eventId: "ev_rf1", prev: artEv.hash,
        at: new Date().toISOString(), actor: "runner", type: "step_failed",
        stepId: "generate", attemptId: first.attemptId,
        data: { errorCode: "execution_error" },
      });
      rStore.appendEvent({
        v: 1, runId: retryRunId, seq: failEv.seq + 1, eventId: "ev_rj1", prev: failEv.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: first.attemptId,
        data: { final: "notify", ruleHits: ["retry_step"], reasonCodes: ["retry"], engineTokens: 0 },
      });
    } finally {
      rStore.close();
      rLock.release();
    }
    const retryChild = runChildRunner(projectId, retryRunId, scratchDir);
    expect(retryChild.status).toBe(0);
    const loadedRetry = loadRunState(projectId, retryRunId, { dataRoot: scratchDir });
    expect(loadedRetry.verifiedArtefacts.size).toBe(2);
    expect(loadedRetry.state.terminalOutcome).toBe("done");
  });

  it("K8: real SIGKILL after judgement (final event of check batch) rolls back check_result + step_result + judgement as ONE atomic tx", async () => {
    const runId = "run-k8-prod";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    // Major 6: Killing AFTER judgement (the 3rd and final event in check batch) defeats EVERY split-commit mutation
    const killed = runChildRunner(projectId, runId, scratchDir, {
      extraEnv: { FLOW_K8_KILL_AFTER_JUDGEMENT: "1" },
    });
    expect(killed.signal).toBe("SIGKILL");

    const mid = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(mid.events.some((e) => e.type === "step_started" && e.stepId === "verify")).toBe(true);
    expect(mid.events.some((e) => e.type === "check_result")).toBe(false);
    expect(mid.events.some((e) => e.type === "step_result" && e.stepId === "verify")).toBe(false);
    expect(mid.events.some((e) => e.type === "judgement" && e.stepId === "verify")).toBe(false);

    const recovered = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(recovered.dispatchedSteps).toHaveLength(0);
    expect(recovered.finalStatus).toBe("stopped");
  });

  it("K9: real SIGKILL right after step 1 judgement before step 2 -> restart transitions to step 2 without re-running or re-judging step 1", async () => {
    const runId = "run-k9";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    const killed = runChildRunner(projectId, runId, scratchDir, { crashPoint: "K9_AFTER_JUDGEMENT" });
    expect(killed.signal).toBe("SIGKILL");

    const mid = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(mid.events.filter((e) => e.type === "judgement" && e.stepId === "generate")).toHaveLength(1);
    expect(mid.events.filter((e) => "stepId" in e && e.stepId === "verify")).toHaveLength(0);

    const recovered = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(recovered.finalStatus).toBe("finished");
    expect(recovered.dispatchedSteps.map((s) => s.stepId)).toEqual(["verify"]);

    const final = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(final.events.filter((e) => e.type === "judgement" && e.stepId === "generate")).toHaveLength(1);
    expect(final.state.terminalOutcome).toBe("done");
  });

  it("K10: finished run releases owner lock BEFORE child process exits, rerun is a no-op, and store refuses append after run_finished", async () => {
    const runId = "run-k10";
    planAndApproveRun({ projectId, runId, flowYaml: CHECKED_IN_STUB_YAML, dataRoot: scratchDir });

    // Major 6: Keep child process ALIVE after runFlow returns so we prove explicit lock.release() ran (not kernel exit cleanup)
    const doneLatch = path.join(scratchDir, "k10-done.latch");
    const child = spawn(process.execPath, ["--import", "tsx", CHILD_SCRIPT, projectId, runId, scratchDir], {
      cwd: DECK_PKG_DIR,
      stdio: "ignore",
      env: { ...process.env, FLOW_HOLD_AFTER_DONE_FILE: doneLatch },
    });
    // Attach exit listener immediately after spawn so we never miss an early exit and can assert SIGKILL
    const exitSignalPromise = new Promise<NodeJS.Signals | null>((resolve) => {
      child.once("exit", (_code, signal) => resolve(signal));
    });
    try {
      const deadline = Date.now() + 8000;
      while (!fs.existsSync(doneLatch) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(fs.existsSync(doneLatch)).toBe(true);
      expect(child.exitCode).toBeNull();

      // Child is STILL ALIVE right now; lock MUST already be released!
      expect(isOwnerLocked(projectId, scratchDir)).toBe(false);
      const acquiredWhileChildAlive = acquireOwnerLock(projectId, scratchDir);
      acquiredWhileChildAlive.release();
    } finally {
      child.kill("SIGKILL");
      const sig = await exitSignalPromise;
      expect(sig).toBe("SIGKILL");
    }

    const afterFirst = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(afterFirst.state.status).toBe("finished");

    const rerun = runChildRunner(projectId, runId, scratchDir);
    expect(rerun.status).toBe(0);
    expect(loadRunState(projectId, runId, { dataRoot: scratchDir }).events.length).toBe(afterFirst.events.length);
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);

    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    try {
      const events = store.getEvents(runId);
      const last = events[events.length - 1]!;
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: last.seq + 1, eventId: "ev_after_fin", prev: last.hash,
          at: new Date().toISOString(), actor: "runner", type: "step_started",
          stepId: "generate", attemptId: buildBoundedAttemptId("generate", 99),
          data: { occurrence: 99, effectKey: buildDeterministicEffectKey(runId, "generate", 99) },
        })
      ).toThrow(IllegalFlowTransitionError);
    } finally {
      store.close();
      lock.release();
    }
  });
});
