/**
 * runner.server.ts - Slice 1a Flow Runner (built-in stub agent + built-in deterministic check).
 *
 * Per Slice 1a spec, custom external agent/check adapters are NOT part of Slice 1a:
 * - Zero untrusted adapter output objects exist to launder into the public ledger.
 * - Built-in stub agent produces deterministic, collision-free verified artefacts on disk.
 * - Built-in deterministic check evaluates ONLY publicly recorded + disk-verified artefacts,
 *   supports literal SHA-256 `against` or `stepId.outputName` / `outputName`, and enforces
 *   an explicit allowlist of built-in check names (`check_exists`, `check_nonempty`).
 * - Single-writer ownership via `flows.owner`, atomic `planAndApproveRun`, solo `BEGIN IMMEDIATE`
 *   intent + occurrence allocation, atomic K1/K3 unknown recovery & K8 check batching,
 *   bounded process-group teardown (`runBoundedProcessGroup`), and clean lock release.
 *
 * ASCII only - no em-dashes.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { loadRunState, verifyArtifactFileOnDisk } from "./load-run.server.js";
import { acquireOwnerLock } from "./owner.server.js";
import { resolvePinnedBudget, resolvePinnedCheckTarget } from "./replay.js";
import { openFlowsStore, StepDeadlineExceededError, type FlowsStore } from "./store.server.js";
import {
  FlowIdRegex,
  type FlowBuiltInCheckId,
  type FlowDefinition,
  type FlowEvent,
  type FlowRunState,
} from "./types.js";
import { parseFlowYamlOrThrow } from "./validator.js";

const DEFAULT_STUB_TOKEN_COST = 100;
const SUPPORTED_BUILT_IN_CHECKS = new Set(["check_exists", "check_nonempty"]);

export type CrashPoint =
  | "K1_AFTER_INTENT"
  | "K3_AFTER_ARTEFACT"
  | "K4_AFTER_OUTCOME"
  | "K8_BEFORE_CHECK_BATCH"
  | "K9_AFTER_JUDGEMENT";

export interface RunFlowOptions {
  dataRoot?: string;
  stepTimeoutMs?: number;
  runnerVersion?: string;
  onCrashPoint?: (point: CrashPoint) => void;
  /**
   * Optional observation/lifecycle hook invoked per step dispatch (returns void only;
   * cannot inject any data into public events or artefacts).
   */
  onStepDispatch?: (ctx: {
    stepId: string;
    attemptId: string;
    occurrence: number;
    signal: AbortSignal;
  }) => void | Promise<void>;
}

export interface RunFlowResult {
  runId: string;
  finalStatus: FlowRunState["status"];
  terminalOutcome: FlowRunState["terminalOutcome"];
  terminalReason: FlowRunState["terminalReason"];
  dispatchedSteps: Array<{ stepId: string; attemptId: string; occurrence: number }>;
  eventCount: number;
}

class StepTimeoutError extends Error {
  constructor(stepId: string, timeoutMs: number) {
    super(`Step '${stepId}' timed out after ${timeoutMs}ms`);
    this.name = "StepTimeoutError";
  }
}

/**
 * Execute a bounded command in its own POSIX process group and guarantee
 * that the entire process group (child + grandchildren) is killed on timeout, abort, or exit.
 */
export async function runBoundedProcessGroup(
  command: string,
  args: string[],
  options: { cwd?: string; timeoutMs: number; env?: NodeJS.ProcessEnv; signal?: AbortSignal }
): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string; timedOut: boolean }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let killEscalation: NodeJS.Timeout | undefined;

    const killGroup = (sig: NodeJS.Signals) => {
      if (!pid) return;
      try {
        process.kill(-pid, sig);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
      }
    };

    const triggerTimeout = () => {
      timedOut = true;
      killGroup("SIGTERM");
      killEscalation = setTimeout(() => killGroup("SIGKILL"), 150);
    };

    const onAbort = () => triggerTimeout();
    if (options.signal?.aborted) {
      triggerTimeout();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }
    const timer = setTimeout(triggerTimeout, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < 65536) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      if (stderr.length < 65536) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      if (killEscalation) clearTimeout(killEscalation);
      options.signal?.removeEventListener("abort", onAbort);
      killGroup("SIGKILL");
      reject(err);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (killEscalation) clearTimeout(killEscalation);
      options.signal?.removeEventListener("abort", onAbort);
      killGroup("SIGKILL");
      resolve({ code, signal, stdout, stderr, timedOut });
    });
  });
}

async function runWithTimeout<T>(
  stepId: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  const workPromise = Promise.resolve().then(() => fn(controller.signal));
  const timeoutPromise = new Promise<"__STEP_TIMEOUT__">((resolve) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      resolve("__STEP_TIMEOUT__");
    }, timeoutMs);
  });
  try {
    const raced = await Promise.race([workPromise, timeoutPromise]);
    if (timedOut || raced === "__STEP_TIMEOUT__") {
      // Wait for bounded teardown (exceeding 150ms SIGTERM->SIGKILL grace) BEFORE releasing flows.owner
      await Promise.race([
        workPromise.then(() => undefined, () => undefined),
        new Promise<void>((r) => setTimeout(r, 350)),
      ]);
      throw new StepTimeoutError(stepId, timeoutMs);
    }
    return raced;
  } finally {
    if (timer) clearTimeout(timer);
    if (timedOut) workPromise.catch(() => {});
  }
}

/**
 * Major 4 & Round 7 Major 3: Unambiguous, fixed-length (28-char) hash-based artifactId scoped
 * to (stepId, declaredOutputName, occurrence). Eliminates delimiter collisions (`a_b`+`c` vs `a`+`b_c`),
 * prototype keys (`__proto__`), 64-char stepId mismatches, AND agent retry receipt PK collisions.
 */
export function buildCollisionFreeArtifactId(
  stepId: string,
  declaredOutputName?: string,
  occurrence = 1,
): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify([stepId, declaredOutputName ?? "", occurrence]))
    .digest("hex")
    .slice(0, 24);
  return `art_${digest}`;
}

/**
 * Plan and approve a flow run atomically in ONE BEGIN IMMEDIATE transaction.
 */
export function planAndApproveRun(params: {
  projectId: string;
  runId: string;
  flowYaml: string;
  actorId?: string;
  source?: "project" | "library" | "builtin";
  dataRoot?: string;
}): { flowHash: string; flow: FlowDefinition } {
  const { flow, hash } = parseFlowYamlOrThrow(params.flowYaml);
  const expectedDecisions = flow.steps.filter((s) => s.type === "decision").map((s) => s.id);
  const actorId = params.actorId ?? "operator-1";
  if (!FlowIdRegex.test(actorId)) {
    throw new Error(`Invalid actorId '${actorId}': must match ${FlowIdRegex.source}`);
  }

  const lock = acquireOwnerLock(params.projectId, params.dataRoot);
  let store: FlowsStore | undefined;
  try {
    store = openFlowsStore(params.projectId, { dataRoot: params.dataRoot, ownerLock: lock });
    store.createAndApproveRun({
      runId: params.runId,
      flowRef: flow.flow,
      flowHash: hash,
      flowYamlBytes: params.flowYaml,
      source: params.source ?? "builtin",
      expectedDecisions,
      actorId,
    });
    return { flowHash: hash, flow };
  } finally {
    store?.close();
    lock.release();
  }
}

function nextEventId(prefix: string, seq: number): string {
  return `${prefix}_${seq}_${crypto.randomBytes(4).toString("hex")}`;
}

function findHead(store: FlowsStore, runId: string): { seq: number; hash: string } {
  const rows = store.getEvents(runId);
  if (rows.length === 0) return { seq: 0, hash: "0".repeat(64) };
  const last = rows[rows.length - 1]!;
  return { seq: last.seq, hash: last.hash };
}

/**
 * Execute or recover-and-resume a Slice 1a flow run under single-writer ownership.
 */
export async function runFlow(
  projectId: string,
  runId: string,
  options: RunFlowOptions = {}
): Promise<RunFlowResult> {
  const lock = acquireOwnerLock(projectId, options.dataRoot);
  const dispatchedSteps: Array<{ stepId: string; attemptId: string; occurrence: number }> = [];

  const fireCrash = (point: CrashPoint) => {
    options.onCrashPoint?.(point);
    const envPoint = process.env["FLOW_CRASH_POINT"];
    if (envPoint && envPoint === point) {
      process.kill(process.pid, "SIGKILL");
    }
  };

  let store: FlowsStore | undefined;
  try {
    store = openFlowsStore(projectId, { dataRoot: options.dataRoot, ownerLock: lock });

    // 1. Load, verify pin hash, verify hash chain, verify artefacts on disk, replay state
    const loaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
    const { flow } = loaded;
    const stepTimeoutMs =
      options.stepTimeoutMs ??
      (flow.limits?.step_timeout_min ? Math.round(flow.limits.step_timeout_min * 60_000) : 5_000);
    let events = loaded.events;
    let state = loaded.state;

    // 2. Halt cleanly on finished, stopped, AND waiting_decision (ZERO redispatch!)
    if (state.status === "finished" || state.status === "stopped" || state.status === "waiting_decision") {
      store.checkpointPassive();
      return {
        runId,
        finalStatus: state.status,
        terminalOutcome: state.terminalOutcome,
        terminalReason: state.terminalReason,
        dispatchedSteps,
        eventCount: events.length,
      };
    }

    const approved = events.some((e) => e.type === "flow_approved" && e.data.flowHash === loaded.run.flow_hash);
    if (!approved) {
      throw new Error(`Flow run '${runId}' is not approved for pinned flow_hash '${loaded.run.flow_hash}'`);
    }

    // 3. Emit run_started if approved but not yet running
    if (state.status === "approved") {
      const head = findHead(store, runId);
      const initialBudget = resolvePinnedBudget(flow);
      store.appendEvent({
        v: 1,
        runId,
        seq: head.seq + 1,
        eventId: nextEventId("ev_start", head.seq + 1),
        prev: head.hash,
        at: new Date().toISOString(),
        actor: "runner",
        type: "run_started",
        data: {
          runnerVersion: options.runnerVersion ?? "1.0.0",
          inputIds: {},
          budget: initialBudget,
        },
      });
      const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
      events = reloaded.events;
      state = reloaded.state;
    }

    // 4. Crash Recovery Scan
    const startedAttempts: Array<{ stepId: string; attemptId: string }> = [];
    const outcomeAttempts = new Set<string>();
    const judgedAttempts = new Set<string>();
    const passedResultAttempts: Array<{ stepId: string; attemptId: string }> = [];
    const failedResultAttempts: Array<{
      stepId: string;
      attemptId: string;
      errorCode: "timeout" | "execution_error" | "budget_exceeded" | "check_failed";
    }> = [];

    for (const ev of events) {
      if (ev.type === "step_started") {
        startedAttempts.push({ stepId: ev.stepId, attemptId: ev.attemptId });
      } else if (ev.type === "step_result") {
        const key = `${ev.stepId}:${ev.attemptId}`;
        outcomeAttempts.add(key);
        passedResultAttempts.push({ stepId: ev.stepId, attemptId: ev.attemptId });
      } else if (ev.type === "step_failed") {
        const key = `${ev.stepId}:${ev.attemptId}`;
        outcomeAttempts.add(key);
        failedResultAttempts.push({ stepId: ev.stepId, attemptId: ev.attemptId, errorCode: ev.data.errorCode });
      } else if (ev.type === "step_outcome_unknown") {
        outcomeAttempts.add(`${ev.stepId}:${ev.attemptId}`);
      } else if (ev.type === "judgement") {
        judgedAttempts.add(`${ev.stepId}:${ev.attemptId}`);
      }
    }

    // K1 / K3 recovery: commit step_outcome_unknown + judgement(stop) + run_finished(stopped) ATOMICALLY
    for (const att of startedAttempts) {
      const key = `${att.stepId}:${att.attemptId}`;
      if (!outcomeAttempts.has(key)) {
        const nowIso = new Date().toISOString();
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_unk", seq), prev, at: nowIso,
              actor: "runner", type: "step_outcome_unknown", stepId: att.stepId, attemptId: att.attemptId,
              data: { reasonCode: "crash_during_execution" },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId: att.stepId, attemptId: att.attemptId,
              data: {
                final: "stop",
                ruleHits: ["recovery_unknown_outcome"],
                reasonCodes: ["crash_during_execution"],
                engineTokens: 0,
              },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
              actor: "system", type: "run_finished",
              data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
            },
          }),
        ]);
        store.checkpointPassive();
        const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
        return {
          runId,
          finalStatus: finalLoaded.state.status,
          terminalOutcome: finalLoaded.state.terminalOutcome,
          terminalReason: finalLoaded.state.terminalReason,
          dispatchedSteps,
          eventCount: finalLoaded.events.length,
        };
      }
    }

    // K4 recovery: record identical judgement without re-running step
    for (const att of passedResultAttempts) {
      const key = `${att.stepId}:${att.attemptId}`;
      if (!judgedAttempts.has(key)) {
        const head = findHead(store, runId);
        store.appendEvent({
          v: 1,
          runId,
          seq: head.seq + 1,
          eventId: nextEventId("ev_judge", head.seq + 1),
          prev: head.hash,
          at: new Date().toISOString(),
          actor: "system",
          type: "judgement",
          stepId: att.stepId,
          attemptId: att.attemptId,
          data: {
            final: "continue",
            ruleHits: ["step_passed"],
            reasonCodes: ["ok"],
            engineTokens: 0,
          },
        });
        judgedAttempts.add(key);
        const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
        events = reloaded.events;
        state = reloaded.state;
      }
    }

    // Major 4: K4 recovery for durable step_failed without judgement -> synthesize stop judgement + run_finished(stopped)
    for (const att of failedResultAttempts) {
      const key = `${att.stepId}:${att.attemptId}`;
      if (!judgedAttempts.has(key)) {
        const nowIso = new Date().toISOString();
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId: att.stepId, attemptId: att.attemptId,
              data: {
                final: "stop",
                ruleHits: ["step_failed_recovery"],
                reasonCodes: [att.errorCode],
                engineTokens: 0,
              },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
              actor: "system", type: "run_finished",
              data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
            },
          }),
        ]);
        store.checkpointPassive();
        const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
        return {
          runId,
          finalStatus: finalLoaded.state.status,
          terminalOutcome: finalLoaded.state.terminalOutcome,
          terminalReason: finalLoaded.state.terminalReason,
          dispatchedSteps,
          eventCount: finalLoaded.events.length,
        };
      }
    }

    // 5. Execute remaining pending steps in flow order
    for (const step of flow.steps) {
      const existingStepState = state.stepStates[step.id];
      if (existingStepState?.status === "passed" && existingStepState.lastJudgement?.final === "continue") {
        continue;
      }

      // Pre-dispatch step & token budget reservation
      const tokenReserve = step.type === "agent" ? DEFAULT_STUB_TOKEN_COST : 0;
      if (state.budgetRemaining.steps <= 0 || state.budgetRemaining.tokens < tokenReserve) {
        const head = findHead(store, runId);
        store.appendEvent({
          v: 1,
          runId,
          seq: head.seq + 1,
          eventId: nextEventId("ev_fin", head.seq + 1),
          prev: head.hash,
          at: new Date().toISOString(),
          actor: "system",
          type: "run_finished",
          data: { outcome: "stopped", reasonCode: "ceiling_reached" },
        });
        store.checkpointPassive();
        const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
        return {
          runId,
          finalStatus: finalLoaded.state.status,
          terminalOutcome: finalLoaded.state.terminalOutcome,
          terminalReason: finalLoaded.state.terminalReason,
          dispatchedSteps,
          eventCount: finalLoaded.events.length,
        };
      }

      const intent = store.allocateAndAppendStepIntent({
        runId,
        stepId: step.id,
      });
      dispatchedSteps.push({
        stepId: step.id,
        attemptId: intent.attemptId,
        occurrence: intent.occurrence,
      });

      fireCrash("K1_AFTER_INTENT");

      const startMs = Date.now();
      const deadlineMs = startMs + stepTimeoutMs;
      let stepWorkOutcome:
        | { kind: "agent"; artifactId: string; contentHash: string; size: number }
        | { kind: "check"; primaryCheckId: FlowBuiltInCheckId; targetSha: string; passed: boolean }
        | { kind: "noop" } = { kind: "noop" };

      try {
        // Major 2 & 5: Wrap BOTH step I/O AND all synchronous append-time verification/commit under ONE deadline
        stepWorkOutcome = await runWithTimeout(step.id, stepTimeoutMs, async (signal) => {
          if (options.onStepDispatch) {
            await options.onStepDispatch({
              stepId: step.id,
              attemptId: intent.attemptId,
              occurrence: intent.occurrence,
              signal,
            });
          }
          // Major 1 (Round 10): Check wall-clock deadline IMMEDIATELY after synchronous/async dispatch hook
          // BEFORE writing any artefact bytes or committing any SQL receipt!
          if (signal.aborted || Date.now() > deadlineMs) {
            throw new StepTimeoutError(step.id, stepTimeoutMs);
          }

          if (step.type === "agent") {
            const declaredOutputName = step.outputs?.[0];
            const artifactId = buildCollisionFreeArtifactId(step.id, declaredOutputName, intent.occurrence);
            const rec = store!.writeAndRecordArtifact({
              artifactId,
              runId,
              stepId: step.id,
              attemptId: intent.attemptId,
              name: declaredOutputName ?? `${step.id.slice(0, 32)}.txt`,
              mediaType: "text/plain",
              bytes: Buffer.from(`stub output for ${step.id}\n`, "utf8"),
              deadlineMs,
            });
            return { kind: "agent" as const, artifactId, contentHash: rec.contentHash, size: rec.size };
          }

          if (step.type === "check") {
            const declaredChecks = step.run && step.run.length > 0 ? step.run : ["check_nonempty"];
            const allChecksSupported = declaredChecks.every((name) => SUPPORTED_BUILT_IN_CHECKS.has(name));
            const requiresNonEmpty = declaredChecks.includes("check_nonempty");
            const primaryCheckId: FlowBuiltInCheckId = !allChecksSupported
              ? "check_unsupported"
              : requiresNonEmpty
                ? "check_nonempty"
                : "check_exists";

            const artifactsDir = path.join(store!.projectDir, "artifacts", runId);
            const receiptNameById = new Map(store!.listArtifacts(runId).map((r) => [r.artifact_id, r.name]));

            // Critical 2 & Major 4: Use ONE shared pure check-target resolver (event order + preceding steps + latest succeeded occurrence)
            const targetRec = resolvePinnedCheckTarget(step, events, receiptNameById, flow);

            let passed = false;
            let targetSha = "0".repeat(64);
            if (targetRec) {
              targetSha = targetRec.sha256;
            }
            if (allChecksSupported && targetRec) {
              const artPath = path.join(artifactsDir, targetRec.sha256);
              const okOnDisk = verifyArtifactFileOnDisk(artPath, artifactsDir, targetRec.sha256, targetRec.sizeBytes);
              // Major 4: check_exists allows verified 0-byte artefacts; check_nonempty requires > 0 bytes
              passed = okOnDisk && (!requiresNonEmpty || targetRec.sizeBytes > 0);
            }
            return { kind: "check" as const, primaryCheckId, targetSha, passed };
          }

          return { kind: "noop" as const };
        });

        // Major 2: Enforce elapsed wall-clock deadline AFTER synchronous I/O completes AND during append-time rereads
        if (Date.now() > deadlineMs) {
          throw new StepTimeoutError(step.id, stepTimeoutMs);
        }

        if (stepWorkOutcome.kind === "agent") {
          const artEv = store.appendEvent(
            {
              v: 1,
              runId,
              seq: intent.seq + 1,
              eventId: nextEventId("ev_art", intent.seq + 1),
              prev: intent.hash,
              at: new Date().toISOString(),
              actor: "runner",
              type: "artefact_recorded",
              stepId: step.id,
              attemptId: intent.attemptId,
              data: {
                artefactId: stepWorkOutcome.artifactId,
                sha256: stepWorkOutcome.contentHash,
                sizeBytes: stepWorkOutcome.size,
              },
            },
            { deadlineMs },
          );

          fireCrash("K3_AFTER_ARTEFACT");

          // Major 1 (Round 11): Re-check deadline AFTER artefact_recorded commit before emitting step_result
          if (Date.now() > deadlineMs) {
            throw new StepDeadlineExceededError(runId, deadlineMs);
          }

          const resEv = store.appendEvent(
            {
              v: 1,
              runId,
              seq: artEv.seq + 1,
              eventId: nextEventId("ev_res", artEv.seq + 1),
              prev: artEv.hash,
              at: new Date().toISOString(),
              actor: "agent",
              type: "step_result",
              stepId: step.id,
              attemptId: intent.attemptId,
              data: {
                outputs: { status: "ok" },
                tokensUsed: DEFAULT_STUB_TOKEN_COST,
                wallTimeMs: Math.max(1, Date.now() - startMs),
              },
            },
            {
              privateDetail: process.env["FLOW_K5_KILL_MID_TX"] === "1" ? "stub_private_trace_k5" : undefined,
              deadlineMs,
            },
          );

          fireCrash("K4_AFTER_OUTCOME");

          // Major 1 (Round 11): If synchronous WAL COMMIT pushed wall-clock past deadlineMs,
          // record compensating timeout stop judgement + run_finished(stopped) rather than continue!
          if (Date.now() > deadlineMs) {
            const nowIso = new Date().toISOString();
            store.appendChainedBatch(runId, [
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
                  actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                  data: { final: "stop", ruleHits: ["step_timeout"], reasonCodes: ["timeout"], engineTokens: 0 },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
                  actor: "system", type: "run_finished",
                  data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
                },
              }),
            ]);
            store.checkpointPassive();
            const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
            return {
              runId,
              finalStatus: finalLoaded.state.status,
              terminalOutcome: finalLoaded.state.terminalOutcome,
              terminalReason: finalLoaded.state.terminalReason,
              dispatchedSteps,
              eventCount: finalLoaded.events.length,
            };
          }

          const judgeEv = store.appendEvent(
            {
              v: 1,
              runId,
              seq: resEv.seq + 1,
              eventId: nextEventId("ev_judge", resEv.seq + 1),
              prev: resEv.hash,
              at: new Date().toISOString(),
              actor: "system",
              type: "judgement",
              stepId: step.id,
              attemptId: intent.attemptId,
              data: {
                final: "continue",
                ruleHits: ["step_passed"],
                reasonCodes: ["ok"],
                engineTokens: 0,
              },
            },
            { deadlineMs },
          );

          fireCrash("K9_AFTER_JUDGEMENT");

          if (Date.now() > deadlineMs) {
            store.appendEvent({
              v: 1,
              runId,
              seq: judgeEv.seq + 1,
              eventId: nextEventId("ev_fin", judgeEv.seq + 1),
              prev: judgeEv.hash,
              at: new Date().toISOString(),
              actor: "system",
              type: "run_finished",
              data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
            });
            store.checkpointPassive();
            const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
            return {
              runId,
              finalStatus: finalLoaded.state.status,
              terminalOutcome: finalLoaded.state.terminalOutcome,
              terminalReason: finalLoaded.state.terminalReason,
              dispatchedSteps,
              eventCount: finalLoaded.events.length,
            };
          }
        } else if (stepWorkOutcome.kind === "check") {
          const { primaryCheckId, targetSha, passed } = stepWorkOutcome;

          fireCrash("K8_BEFORE_CHECK_BATCH");

          const nowIso = new Date().toISOString();
          const wallTimeMs = Math.max(1, Date.now() - startMs);
          const checkBuilders: Array<(seq: number, prev: string) => { event: FlowEvent; privateDetail?: string }> = [
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_chk", seq), prev, at: nowIso,
                actor: "runner", type: "check_result", stepId: step.id, attemptId: intent.attemptId,
                data: { checkId: primaryCheckId, targetSha, passed },
              },
            }),
          ];

          if (passed) {
            checkBuilders.push(
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
                  actor: "runner", type: "step_result", stepId: step.id, attemptId: intent.attemptId,
                  data: { outputs: { check: "passed" }, tokensUsed: 0, wallTimeMs },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
                  actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                  data: { final: "continue", ruleHits: ["check_passed"], reasonCodes: ["ok"], engineTokens: 0 },
                },
              }),
            );
          } else {
            checkBuilders.push(
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: nowIso,
                  actor: "runner", type: "step_failed", stepId: step.id, attemptId: intent.attemptId,
                  data: { errorCode: "check_failed" },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
                  actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                  data: { final: "stop", ruleHits: ["check_failed"], reasonCodes: ["check_failed"], engineTokens: 0 },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
                  actor: "system", type: "run_finished",
                  data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
                },
              }),
            );
          }

          const batchRes = store.appendChainedBatch(runId, checkBuilders, { deadlineMs });

          if (!passed || Date.now() > deadlineMs) {
            if (passed) {
              const lastBatchEv = batchRes[batchRes.length - 1]!;
              store.appendEvent({
                v: 1,
                runId,
                seq: lastBatchEv.seq + 1,
                eventId: nextEventId("ev_fin", lastBatchEv.seq + 1),
                prev: lastBatchEv.hash,
                at: new Date().toISOString(),
                actor: "system",
                type: "run_finished",
                data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
              });
            }
            store.checkpointPassive();
            const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
            return {
              runId,
              finalStatus: finalLoaded.state.status,
              terminalOutcome: finalLoaded.state.terminalOutcome,
              terminalReason: finalLoaded.state.terminalReason,
              dispatchedSteps,
              eventCount: finalLoaded.events.length,
            };
          }
        }
      } catch (err) {
        if (err instanceof StepTimeoutError || err instanceof StepDeadlineExceededError) {
          const nowIso = new Date().toISOString();
          store.appendChainedBatch(runId, [
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: nowIso,
                actor: "runner", type: "step_failed", stepId: step.id, attemptId: intent.attemptId,
                data: { errorCode: "timeout" },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
                actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                data: { final: "stop", ruleHits: ["step_timeout"], reasonCodes: ["timeout"], engineTokens: 0 },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
                actor: "system", type: "run_finished",
                data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
              },
            }),
          ]);
          store.checkpointPassive();
          const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
          return {
            runId,
            finalStatus: finalLoaded.state.status,
            terminalOutcome: finalLoaded.state.terminalOutcome,
            terminalReason: finalLoaded.state.terminalReason,
            dispatchedSteps,
            eventCount: finalLoaded.events.length,
          };
        }
        throw err;
      }

      const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
      events = reloaded.events;
      state = reloaded.state;

      if (state.status === "stopped" || state.status === "finished" || state.status === "waiting_decision") {
        store.checkpointPassive();
        return {
          runId,
          finalStatus: state.status,
          terminalOutcome: state.terminalOutcome,
          terminalReason: state.terminalReason,
          dispatchedSteps,
          eventCount: events.length,
        };
      }
    }

    // 6. All steps complete -> commit run_finished, checkpoint WAL, and release lock (K10)
    const head = findHead(store, runId);
    store.appendEvent({
      v: 1,
      runId,
      seq: head.seq + 1,
      eventId: nextEventId("ev_fin", head.seq + 1),
      prev: head.hash,
      at: new Date().toISOString(),
      actor: "system",
      type: "run_finished",
      data: { outcome: "done", reasonCode: "completed" },
    });
    store.checkpointPassive();

    const finalLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
    return {
      runId,
      finalStatus: finalLoaded.state.status,
      terminalOutcome: finalLoaded.state.terminalOutcome,
      terminalReason: finalLoaded.state.terminalReason,
      dispatchedSteps,
      eventCount: finalLoaded.events.length,
    };
  } finally {
    store?.close();
    lock.release();
  }
}
