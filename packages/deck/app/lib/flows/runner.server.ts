/**
 * runner.server.ts - Slice 1a + Slice 2 Flow Runner.
 *
 * Enforces:
 * - Single-writer ownership via `flows.owner`, atomic `planAndApproveRun`, solo `BEGIN IMMEDIATE`
 *   intent + occurrence allocation, atomic K1/K3 unknown recovery & K8 check batching,
 *   bounded process-group teardown (`runBoundedProcessGroup`), and clean lock release.
 * - Slice 2 rules-only decision engine (`evaluateStepJudgement`), limits, budget, rewinds,
 *   idempotent inbox decision/notify card bridge, expiry safe defaults, and crash-safe
 *   handoff_sent / handoff_returned / step_rewound recovery.
 *
 * ASCII only - no em-dashes.
 */

import { spawn } from "node:child_process";
import crypto from "node:crypto";
import path from "node:path";
import {
  FlowAdapterAbortedError,
  resolveRoleAdapters,
  type FlowStepAdapter,
} from "./adapter.server.js";
import {
  extractGitDiffSignals,
  GitDiffEvidenceError,
  isFlowCommandCheckId,
  isSupportedSuiteCheckId,
  runAllowlistedCheckSuite,
  runReproCheck,
  type CheckCommandMap,
  type FlowCommandCheckId,
  type ReproTestCommand,
} from "./checks.server.js";
import {
  evaluateStepJudgement,
  resolveFlowLimits,
  type StepSignals,
} from "./engine.js";
import {
  buildDeterministicHandoffId,
  buildDeterministicNotifyCardId,
  countInvalidAnsweredDecisionCards,
  emitDecisionCardToInbox,
  emitNotifyCardToInbox,
  readDecisionCardResolution,
  supersedeDecisionCardInInbox,
  type InboxBridgeTarget,
} from "./inbox-bridge.server.js";
import { loadRunState, verifyArtifactFileOnDisk } from "./load-run.server.js";
import { acquireOwnerLock } from "./owner.server.js";
import { resolvePinnedBudget, resolvePinnedCheckTarget } from "./replay.js";
import { openFlowsStore, StepDeadlineExceededError, type FlowsStore } from "./store.server.js";
import {
  FlowGitShaRegex,
  FlowIdRegex,
  FlowSafePathSchema,
  FlowSafeValueRegex,
  FlowStepResultOutputsSchema,
  type CheckStep,
  type FlowActor,
  type FlowBuiltInCheckId,
  type FlowDefinition,
  type FlowEvent,
  type FlowHandoffReturnedEvent,
  type FlowHandoffSentEvent,
  type FlowReasonCode,
  type FlowRunState,
  type FlowStep,
  type FlowStepStartedEvent,
} from "./types.js";
import { parseFlowYamlOrThrow } from "./validator.js";
import {
  captureWorktreeOutcome,
  createDetachedCommitWorktree,
  createEphemeralWorktree,
  recoverEphemeralWorktree,
  resolveBaseCommitSha,
  rollbackWorktree,
  type WorktreeHandle,
} from "./worktree.server.js";

const DEFAULT_STUB_TOKEN_COST = 100;
const SUPPORTED_BUILT_IN_CHECKS = new Set(["check_exists", "check_nonempty"]);

export type CrashPoint =
  | "K1_AFTER_INTENT"
  | "K_AFTER_WORKTREE_CREATED"
  | "K3_AFTER_ARTEFACT"
  | "K4_AFTER_OUTCOME"
  | "K8_BEFORE_CHECK_BATCH"
  | "K9_AFTER_JUDGEMENT"
  | "K_AFTER_HANDOFF_SENT"
  | "K_AFTER_INBOX_CARD_WRITTEN"
  | "K_AFTER_HANDOFF_RETURNED"
  | "K_AFTER_REWIND";

export interface RunFlowOptions {
  dataRoot?: string;
  stepTimeoutMs?: number;
  runnerVersion?: string;
  inbox?: InboxBridgeTarget;
  now?: () => Date;
  evaluateSignals?: (ctx: {
    step: FlowStep;
    attemptId: string;
    occurrence: number;
    outcome: "passed" | "failed" | "unknown";
    errorCode?: "timeout" | "execution_error" | "budget_exceeded" | "check_failed";
  }) => StepSignals | Promise<StepSignals>;
  onCheckRun?: (ctx: {
    step: CheckStep;
    attemptId: string;
    occurrence: number;
    defaultPassed: boolean;
    targetSha: string;
  }) => { passed: boolean; errorClass?: string } | Promise<{ passed: boolean; errorClass?: string }>;
  getStubAgentBytes?: (ctx: { step: FlowStep; occurrence: number }) => Buffer;
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
  /** Optional git repository root for flows declaring workspace.kind === "git-worktree". */
  workspaceRepoRoot?: string;
  /** Optional base directory outside workspaceRepoRoot for ephemeral git worktrees. */
  worktreeRoot?: string;
  /** Optional role-keyed step adapters (subject to roles.<name>.differs_from checks). */
  adapters?: Record<string, FlowStepAdapter>;
  /** Available adapters keyed by the runtime declared in the pinned flow. */
  adaptersByRuntime?: Record<string, FlowStepAdapter>;
  /** Optional fallback adapter, subject to the declared runtime for named roles. */
  adapter?: FlowStepAdapter;
  /** Optional explicit allowlisted command map for Slice 3 check steps. */
  checkCommands?: CheckCommandMap;
  /** Optional explicit command/runner for check repro fail-on-base/pass-on-head verification. */
  reproTestCommand?: ReproTestCommand;
  /** Optional expected head SHA for stale_sha detection in check steps. */
  expectedHeadSha?: string;
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

class WorktreeOutcomeRejectedError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = "WorktreeOutcomeRejectedError";
  }
}

/**
 * Execute a bounded command in its own POSIX process group and guarantee
 * that the entire process group (child + grandchildren) is killed on timeout, abort, or exit.
 */
export async function runBoundedProcessGroup(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    timeoutMs: number;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    stdoutLimitBytes?: number;
  },
): Promise<{
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stdoutTruncated: boolean;
  stderr: string;
  timedOut: boolean;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const pid = child.pid;
    const stdoutChunks: Buffer[] = [];
    const stdoutLimit = options.stdoutLimitBytes ?? 65_536;
    let stdoutBytes = 0;
    let stdoutTruncated = false;
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
      const remaining = stdoutLimit - stdoutBytes;
      if (chunk.length > remaining) stdoutTruncated = true;
      if (remaining > 0) {
        const captured = chunk.subarray(0, remaining);
        stdoutChunks.push(captured);
        stdoutBytes += captured.length;
      }
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
      const stdout = Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8");
      resolve({ code, signal, stdout, stdoutTruncated, stderr, timedOut });
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
 * Unambiguous, fixed-length (28-char) hash-based artifactId scoped
 * to (stepId, declaredOutputName, occurrence).
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

function collectExpectedDecisions(flow: FlowDefinition): string[] {
  const result: string[] = [];
  for (const step of flow.steps) {
    const isDecisionStep = step.type === "decision";
    const hasDecideRule = Boolean(
      step.rules?.some((ruleMap) => Object.values(ruleMap).includes("decide")),
    );
    if ((isDecisionStep || hasDecideRule) && !result.includes(step.id)) {
      result.push(step.id);
    }
  }
  return result;
}

/**
 * Plan a flow run without approving it (appends ONLY run_planned at seq 1).
 * The run cannot start until approveRun records a matching flow_approved event.
 */
export function planRun(params: {
  projectId: string;
  runId: string;
  flowYaml: string;
  source?: "project" | "library" | "builtin";
  metadata?: Record<string, string>;
  dataRoot?: string;
}): {
  runId: string;
  flowHash: string;
  flow: FlowDefinition;
  expectedDecisions: string[];
} {
  const { flow, hash } = parseFlowYamlOrThrow(params.flowYaml);
  const expectedDecisions = collectExpectedDecisions(flow);

  const lock = acquireOwnerLock(params.projectId, params.dataRoot);
  let store: FlowsStore | undefined;
  try {
    store = openFlowsStore(params.projectId, { dataRoot: params.dataRoot, ownerLock: lock });
    store.planRun({
      runId: params.runId,
      flowRef: flow.flow,
      flowHash: hash,
      flowYamlBytes: params.flowYaml,
      source: params.source ?? "builtin",
      expectedDecisions,
      ...(params.metadata ? { metadata: params.metadata } : {}),
    });
    return {
      runId: params.runId,
      flowHash: hash,
      flow,
      expectedDecisions,
    };
  } finally {
    store?.close();
    lock.release();
  }
}

/**
 * Approve an existing planned run for its exact pinned flow_hash.
 * Refuses missing runs, mismatched flowHash, non-planned runs, or duplicate approvals.
 */
export function approveRun(params: {
  projectId: string;
  runId: string;
  flowHash: string;
  actorId: string;
  dataRoot?: string;
}): {
  runId: string;
  flowHash: string;
  actorId: string;
} {
  if (!FlowIdRegex.test(params.actorId)) {
    throw new Error(`Invalid actorId '${params.actorId}': must match ${FlowIdRegex.source}`);
  }

  const lock = acquireOwnerLock(params.projectId, params.dataRoot);
  let store: FlowsStore | undefined;
  try {
    store = openFlowsStore(params.projectId, { dataRoot: params.dataRoot, ownerLock: lock });
    store.approveRun({
      runId: params.runId,
      flowHash: params.flowHash,
      actorId: params.actorId,
    });
    return {
      runId: params.runId,
      flowHash: params.flowHash,
      actorId: params.actorId,
    };
  } finally {
    store?.close();
    lock.release();
  }
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

function getHandoffSpecForStep(
  flow: FlowDefinition,
  step: FlowStep,
  outcome: "passed" | "failed" | "unknown",
  reasonCode: FlowReasonCode,
  nowDate: Date = new Date(),
): {
  kind: "decision" | "handoff";
  target: string;
  reasonCode: FlowReasonCode;
  optionKeys: string[];
  alwaysDecide?: boolean;
  expiresAt?: string;
  options: Array<{ key: string; label?: string; detail?: string }>;
} {
  const expiresAt = flow.on_unanswered?.after_hours
    ? new Date(nowDate.getTime() + flow.on_unanswered.after_hours * 3600_000).toISOString()
    : undefined;

  if (step.type === "decision") {
    return {
      kind: "decision",
      target: "operator",
      reasonCode: "decision_required",
      optionKeys: step.options.map((o) => o.key),
      alwaysDecide: step.always === "decide" ? true : undefined,
      expiresAt,
      options: step.options.map((o) => ({
        key: o.key,
        label: o.label ?? o.key,
        detail: o.end
          ? `Ends run (${o.end})`
          : o.goto
            ? `Rewind to ${o.goto}`
            : o.label ?? o.key,
      })),
    };
  }

  if (step.type === "handoff") {
    const rawKeys = step.returns ? Object.values(step.returns).flat() : [];
    const uniqueKeys = Array.from(new Set(rawKeys.length > 0 ? rawKeys : ["approve", "changes", "comment"])).slice(
      0,
      16,
    );
    return {
      kind: "handoff",
      target: step.to && FlowIdRegex.test(step.to) ? step.to : "reviewer",
      reasonCode: "handoff_required",
      optionKeys: uniqueKeys,
      expiresAt,
      options: uniqueKeys.map((k) => ({
        key: k,
        label: k.charAt(0).toUpperCase() + k.slice(1).replace(/[-_]/g, " "),
        detail: step.on_return?.[k]?.goto ? `Rewind to ${step.on_return[k]!.goto}` : `Return ${k}`,
      })),
    };
  }

  const escalatedOptions =
    outcome === "failed"
      ? [
          { key: "retry", label: "Retry", detail: "Rewind and retry step" },
          { key: "stop", label: "Stop", detail: "Stop run" },
        ]
      : [
          { key: "continue", label: "Continue", detail: "Approve and continue flow" },
          { key: "retry", label: "Retry", detail: "Rewind and retry step" },
          { key: "stop", label: "Stop", detail: "Stop run" },
        ];

  return {
    kind: "decision",
    target: "operator",
    reasonCode,
    optionKeys: escalatedOptions.map((o) => o.key),
    expiresAt,
    options: escalatedOptions,
  };
}

function getOccurrenceForAttempt(
  events: readonly FlowEvent[],
  stepId: string,
  attemptId: string,
): number {
  for (const ev of events) {
    if (ev.type === "step_started" && ev.stepId === stepId && ev.attemptId === attemptId) {
      return ev.data.occurrence;
    }
  }
  return 1;
}

function completeHandoffFollowUp(params: {
  store: FlowsStore;
  runId: string;
  flow: FlowDefinition;
  state: FlowRunState;
  events: readonly FlowEvent[];
  sentEv: FlowHandoffSentEvent;
  returnedEv: FlowHandoffReturnedEvent;
  nowIso: string;
  fireCrash: (point: CrashPoint) => void;
}): void {
  const { store, runId, flow, state, events, sentEv, returnedEv, nowIso, fireCrash } = params;
  const step = flow.steps.find((s) => s.id === sentEv.stepId);
  if (!step) return;

  const limits = resolveFlowLimits(flow);
  const { stepId, attemptId } = sentEv;
  const { choiceKey, resolution } = returnedEv.data;

  const alreadySettled = events.some(
    (e) =>
      (e.type === "step_result" || e.type === "step_failed" || e.type === "step_outcome_unknown") &&
      e.stepId === stepId &&
      e.attemptId === attemptId,
  );
  const alreadyRewoundOrFinishedAfterReturn = events.some(
    (e) =>
      e.seq > returnedEv.seq &&
      (e.type === "step_rewound" || e.type === "run_finished"),
  );
  if (alreadyRewoundOrFinishedAfterReturn) {
    return;
  }

  // Case A: decision or handoff step awaiting settlement after handoff_returned
  if (step.type === "decision" || step.type === "handoff") {
    if (alreadySettled) {
      return;
    }
    if (resolution === "dismissed") {
      store.appendChainedBatch(runId, [
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: nowIso,
            actor: "runner", type: "step_failed", stepId, attemptId,
            data: { errorCode: "execution_error" },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
            actor: "system", type: "judgement", stepId, attemptId,
            data: {
              final: "stop",
              ruleHits: ["decision_dismissed"],
              reasonCodes: ["decision_dismissed"],
              engineTokens: 0,
            },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
            actor: "system", type: "run_finished",
            data: { outcome: "stopped", reasonCode: "decision_dismissed" },
          },
        }),
      ]);
      return;
    }

    if (resolution === "expired") {
      const rawOnUnanswered = flow.on_unanswered?.outcome ?? "stop";
      const isAlwaysDecide = step.type === "decision" && step.always === "decide";
      const onUnanswered =
        isAlwaysDecide && (rawOnUnanswered === "continue" || rawOnUnanswered === "notify")
          ? "stop"
          : rawOnUnanswered;
      if (onUnanswered === "continue" || onUnanswered === "notify") {
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
              actor: "runner", type: "step_result", stepId, attemptId,
              data: { outputs: { status: "ok" }, tokensUsed: 0, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId, attemptId,
              data: {
                final: onUnanswered,
                ruleHits: ["unanswered_expired"],
                reasonCodes: ["ok"],
                engineTokens: 0,
              },
            },
          }),
        ]);
      } else {
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: nowIso,
              actor: "runner", type: "step_failed", stepId, attemptId,
              data: { errorCode: "timeout" },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId, attemptId,
              data: {
                final: "stop",
                ruleHits: ["unanswered_expired"],
                reasonCodes: ["unanswered_expired"],
                engineTokens: 0,
              },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
              actor: "system", type: "run_finished",
              data: { outcome: "stopped", reasonCode: "unanswered_expired" },
            },
          }),
        ]);
      }
      return;
    }

    // resolution === "answered"
    if (step.type === "decision") {
      const opt = step.options.find((o) => o.key === choiceKey);
      if (opt?.end === "done") {
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
              actor: "runner", type: "step_result", stepId, attemptId,
              data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId, attemptId,
              data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
              actor: "system", type: "run_finished",
              data: { outcome: "done", reasonCode: "completed" },
            },
          }),
        ]);
        return;
      }

      if (opt?.end === "stopped" || opt?.end === "dropped") {
        const endOutcome = opt.end;
        const endReason = endOutcome === "dropped" ? "operator_dropped" : "operator_stopped";
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
              actor: "runner", type: "step_result", stepId, attemptId,
              data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId, attemptId,
              data: { final: "stop", ruleHits: ["stop_rule"], reasonCodes: [endReason], engineTokens: 0 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
              actor: "system", type: "run_finished",
              data: { outcome: endOutcome, reasonCode: endReason },
            },
          }),
        ]);
        return;
      }

      if (opt?.goto) {
        if (state.rewindsUsed >= limits.maxRewinds) {
          store.appendChainedBatch(runId, [
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
                actor: "runner", type: "step_result", stepId, attemptId,
                data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
                actor: "system", type: "judgement", stepId, attemptId,
                data: { final: "stop", ruleHits: ["loop_count"], reasonCodes: ["max_rewinds_reached"], engineTokens: 0 },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
                actor: "system", type: "run_finished",
                data: { outcome: "stopped", reasonCode: "ceiling_reached" },
              },
            }),
          ]);
          return;
        }
        const gotoTarget = opt.goto;
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
              actor: "runner", type: "step_result", stepId, attemptId,
              data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId, attemptId,
              data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_rew", seq), prev, at: nowIso,
              actor: "runner", type: "step_rewound", stepId, attemptId,
              data: {
                fromStepId: stepId,
                toStepId: gotoTarget,
                rewindNumber: state.rewindsUsed + 1,
                reasonCode: "on_return_rewind",
              },
            },
          }),
        ]);
        fireCrash("K_AFTER_REWIND");
        return;
      }

      store.appendChainedBatch(runId, [
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
            actor: "runner", type: "step_result", stepId, attemptId,
            data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
            actor: "system", type: "judgement", stepId, attemptId,
            data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
          },
        }),
      ]);
      return;
    }

    // step.type === "handoff"
    const handoffGoto = step.on_return?.[choiceKey]?.goto;
    if (handoffGoto) {
      if (state.rewindsUsed >= limits.maxRewinds) {
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
              actor: "runner", type: "step_result", stepId, attemptId,
              data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
              actor: "system", type: "judgement", stepId, attemptId,
              data: { final: "stop", ruleHits: ["loop_count"], reasonCodes: ["max_rewinds_reached"], engineTokens: 0 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: nowIso,
              actor: "system", type: "run_finished",
              data: { outcome: "stopped", reasonCode: "ceiling_reached" },
            },
          }),
        ]);
        return;
      }
      store.appendChainedBatch(runId, [
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
            actor: "runner", type: "step_result", stepId, attemptId,
            data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
            actor: "system", type: "judgement", stepId, attemptId,
            data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: nextEventId("ev_rew", seq), prev, at: nowIso,
            actor: "runner", type: "step_rewound", stepId, attemptId,
            data: {
              fromStepId: stepId,
              toStepId: handoffGoto,
              rewindNumber: state.rewindsUsed + 1,
              reasonCode: "on_return_rewind",
            },
          },
        }),
      ]);
      fireCrash("K_AFTER_REWIND");
      return;
    }

    store.appendChainedBatch(runId, [
      (seq, prev) => ({
        event: {
          v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: nowIso,
          actor: "runner", type: "step_result", stepId, attemptId,
          data: { outputs: { status: "ok", choice: choiceKey }, tokensUsed: 0, wallTimeMs: 1 },
        },
      }),
      (seq, prev) => ({
        event: {
          v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: nowIso,
          actor: "system", type: "judgement", stepId, attemptId,
          data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
        },
      }),
    ]);
    return;
  }

  // Case B: agent/check escalation decision after judgement(decide)
  if (resolution === "dismissed") {
    const head = findHead(store, runId);
    store.appendEvent({
      v: 1, runId, seq: head.seq + 1, eventId: nextEventId("ev_fin", head.seq + 1), prev: head.hash,
      at: nowIso, actor: "system", type: "run_finished",
      data: { outcome: "stopped", reasonCode: "decision_dismissed" },
    });
    return;
  }

  if (resolution === "expired") {
    const onUnanswered = flow.on_unanswered?.outcome ?? "stop";
    const stepPassed = events.some(
      (e) => e.type === "step_result" && e.stepId === stepId && e.attemptId === attemptId,
    );
    if ((onUnanswered === "continue" || onUnanswered === "notify") && stepPassed) {
      return;
    }
    const head = findHead(store, runId);
    store.appendEvent({
      v: 1, runId, seq: head.seq + 1, eventId: nextEventId("ev_fin", head.seq + 1), prev: head.hash,
      at: nowIso, actor: "system", type: "run_finished",
      data: { outcome: "stopped", reasonCode: "unanswered_expired" },
    });
    return;
  }

  if (choiceKey === "stop") {
    const head = findHead(store, runId);
    store.appendEvent({
      v: 1, runId, seq: head.seq + 1, eventId: nextEventId("ev_fin", head.seq + 1), prev: head.hash,
      at: nowIso, actor: "system", type: "run_finished",
      data: { outcome: "stopped", reasonCode: "operator_stopped" },
    });
    return;
  }

  if (choiceKey === "retry") {
    if (state.rewindsUsed >= limits.maxRewinds) {
      const head = findHead(store, runId);
      store.appendEvent({
        v: 1, runId, seq: head.seq + 1, eventId: nextEventId("ev_fin", head.seq + 1), prev: head.hash,
        at: nowIso, actor: "system", type: "run_finished",
        data: { outcome: "stopped", reasonCode: "ceiling_reached" },
      });
      return;
    }
    const toStepId = step.type === "check" && step.on_fail?.goto ? step.on_fail.goto : step.id;
    const head = findHead(store, runId);
    store.appendEvent({
      v: 1, runId, seq: head.seq + 1, eventId: nextEventId("ev_rew", head.seq + 1), prev: head.hash,
      at: nowIso, actor: "runner", type: "step_rewound", stepId, attemptId,
      data: {
        fromStepId: stepId,
        toStepId,
        rewindNumber: state.rewindsUsed + 1,
        reasonCode: "retry",
      },
    });
    fireCrash("K_AFTER_REWIND");
  }
}

function isStepCompletedForCursor(
  step: FlowStep,
  state: FlowRunState,
  events: readonly FlowEvent[],
  flow: FlowDefinition,
): boolean {
  const stepState = Object.hasOwn(state.stepStates, step.id) ? state.stepStates[step.id] : undefined;
  if (!stepState || stepState.status !== "passed") return false;
  const final = stepState.lastJudgement?.final;
  if (final === "continue" || final === "notify") {
    return true;
  }
  if (final === "decide") {
    let latestStartSeq = 0;
    let latestAttemptId: string | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "step_started" && ev.stepId === step.id) {
        latestStartSeq = ev.seq;
        latestAttemptId = ev.attemptId;
        break;
      }
    }
    if (!latestAttemptId) return false;
    const canContinueOnExpire =
      step.type !== "decision" &&
      step.type !== "handoff" &&
      (flow.on_unanswered?.outcome === "continue" || flow.on_unanswered?.outcome === "notify");
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.seq < latestStartSeq) break;
      if (
        ev.type === "handoff_returned" &&
        ev.stepId === step.id &&
        ev.attemptId === latestAttemptId &&
        ((ev.data.resolution === "answered" &&
          ev.data.choiceKey !== "stop" &&
          ev.data.choiceKey !== "retry") ||
          (ev.data.resolution === "expired" && canContinueOnExpire))
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Submit a handoff/decision return directly to the run ledger.
 * Rejects duplicate, late, unknown, invalid-option, and non-human always:decide returns
 * by appending `return_rejected` (when the run is not terminal).
 */
export function submitHandoffReturn(params: {
  projectId: string;
  runId: string;
  handoffId: string;
  choiceKey: string;
  actor: FlowActor;
  actorId: string;
  note?: string;
  resolution?: "answered" | "dismissed" | "expired";
  dataRoot?: string;
}): { accepted: boolean; rejectReason?: string } {
  if (!FlowIdRegex.test(params.handoffId)) {
    throw new Error(`Invalid handoffId '${params.handoffId}'`);
  }
  if (!FlowIdRegex.test(params.choiceKey)) {
    throw new Error(`Invalid choiceKey '${params.choiceKey}'`);
  }
  if (!FlowIdRegex.test(params.actorId)) {
    throw new Error(`Invalid actorId '${params.actorId}'`);
  }

  const lock = acquireOwnerLock(params.projectId, params.dataRoot);
  let store: FlowsStore | undefined;
  try {
    store = openFlowsStore(params.projectId, { dataRoot: params.dataRoot, ownerLock: lock });
    const loaded = loadRunState(params.projectId, params.runId, { dataRoot: params.dataRoot });
    const { events, state } = loaded;
    const resolution = params.resolution ?? "answered";
    const nowIso = new Date().toISOString();

    const isTerminal =
      state.status === "finished" ||
      state.status === "stopped" ||
      events.some((e) => e.type === "run_finished" || (e.type === "judgement" && e.data.final === "stop"));

    const sentEv = events.find(
      (e): e is FlowHandoffSentEvent => e.type === "handoff_sent" && e.data.handoffId === params.handoffId,
    );
    const returnedEv = events.find(
      (e): e is FlowHandoffReturnedEvent => e.type === "handoff_returned" && e.data.handoffId === params.handoffId,
    );
    const cancelledEv = events.find(
      (e) => e.type === "handoff_cancelled" && e.data.handoffId === params.handoffId,
    );

    const recordRejection = (
      rejectReason: "duplicate_return" | "late_return" | "unknown_handoff" | "invalid_option" | "human_required",
      targetStepId?: string,
      targetAttemptId?: string,
    ): { accepted: false; rejectReason: string } => {
      if (!isTerminal && targetStepId && targetAttemptId) {
        const head = findHead(store!, params.runId);
        store!.appendEvent({
          v: 1,
          runId: params.runId,
          seq: head.seq + 1,
          eventId: nextEventId("ev_rej", head.seq + 1),
          prev: head.hash,
          at: nowIso,
          actor: params.actor,
          type: "return_rejected",
          stepId: targetStepId,
          attemptId: targetAttemptId,
          data: {
            handoffId: params.handoffId,
            attemptedChoiceKey: params.choiceKey,
            rejectReason,
          },
        });
      }
      return { accepted: false, rejectReason };
    };

    const latestStarted = [...events]
      .reverse()
      .find((e): e is Extract<FlowEvent, { type: "step_started" }> => e.type === "step_started");

    if (isTerminal) {
      return { accepted: false, rejectReason: "late_return" };
    }
    if (!sentEv) {
      return recordRejection("unknown_handoff", latestStarted?.stepId, latestStarted?.attemptId);
    }
    if (returnedEv) {
      return recordRejection("duplicate_return", sentEv.stepId, sentEv.attemptId);
    }
    if (cancelledEv || (state.activeHandoff && state.activeHandoff.handoffId !== params.handoffId)) {
      return recordRejection("late_return", sentEv.stepId, sentEv.attemptId);
    }
    if (!state.activeHandoff || state.activeHandoff.handoffId !== params.handoffId) {
      return recordRejection("late_return", sentEv.stepId, sentEv.attemptId);
    }
    if (sentEv.data.alwaysDecide) {
      if ((resolution === "answered" || resolution === "dismissed") && params.actor !== "human") {
        return recordRejection("human_required", sentEv.stepId, sentEv.attemptId);
      }
      if (resolution === "expired" && params.actor === "agent") {
        return recordRejection("human_required", sentEv.stepId, sentEv.attemptId);
      }
    }
    if (resolution === "answered" && !sentEv.data.optionKeys.includes(params.choiceKey)) {
      return recordRejection("invalid_option", sentEv.stepId, sentEv.attemptId);
    }
    if (resolution !== "expired" && state.activeHandoff.expiresAt && nowIso >= state.activeHandoff.expiresAt) {
      return recordRejection("late_return", sentEv.stepId, sentEv.attemptId);
    }

    const head = findHead(store, params.runId);
    store.appendEvent(
      {
        v: 1,
        runId: params.runId,
        seq: head.seq + 1,
        eventId: nextEventId("ev_ret", head.seq + 1),
        prev: head.hash,
        at: nowIso,
        actor: params.actor,
        type: "handoff_returned",
        stepId: sentEv.stepId,
        attemptId: sentEv.attemptId,
        data: {
          handoffId: params.handoffId,
          choiceKey: params.choiceKey,
          resolution,
          actorId: params.actorId,
        },
      },
      params.note !== undefined ? { privateDetail: params.note } : undefined,
    );
    store.checkpointPassive();
    return { accepted: true };
  } finally {
    store?.close();
    lock.release();
  }
}

/**
 * Execute or recover-and-resume a Slice 1a/2 flow run under single-writer ownership.
 */
export async function runFlow(
  projectId: string,
  runId: string,
  options: RunFlowOptions = {}
): Promise<RunFlowResult> {
  const lock = acquireOwnerLock(projectId, options.dataRoot);
  const dispatchedSteps: Array<{ stepId: string; attemptId: string; occurrence: number }> = [];
  const checkErrorClassesByStep = new Map<string, Map<string, number>>();

  const fireCrash = (point: CrashPoint) => {
    options.onCrashPoint?.(point);
    const envPoint = process.env["FLOW_CRASH_POINT"];
    if (envPoint && envPoint === point) {
      process.kill(process.pid, "SIGKILL");
    }
  };

  const nowDate = () => options.now?.() ?? new Date();
  const nowIso = () => nowDate().toISOString();

  let store: FlowsStore | undefined;
  try {
    store = openFlowsStore(projectId, { dataRoot: options.dataRoot, ownerLock: lock });

    // 1. Load, verify pin hash, verify hash chain, verify artefacts on disk, replay state
    const loaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
    const { flow } = loaded;
    const worktreeBaseDir = options.worktreeRoot ?? path.join(store.projectDir, "worktrees");
    const stepTimeoutMs =
      options.stepTimeoutMs ??
      (flow.limits?.step_timeout_min ? Math.round(flow.limits.step_timeout_min * 60_000) : 5_000);
    let events = loaded.events;
    let state = loaded.state;

    // 2. Halt cleanly on finished or stopped
    if (state.status === "finished" || state.status === "stopped") {
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

    const approvedAtEntry = events.some(
      (e) => e.type === "flow_approved" && e.data.flowHash === loaded.run.flow_hash,
    );
    if (state.status === "planned" || !approvedAtEntry) {
      throw new Error(
        `Flow run '${runId}' is not approved for pinned flow_hash '${loaded.run.flow_hash}'`,
      );
    }

    const roleAdapters = resolveRoleAdapters(flow, options.adapters ?? {}, options.adapter, options.adaptersByRuntime);

    // 2b. Handle waiting_decision (Slice 1a unknown/artefact_missing vs Slice 2 handoff/inbox bridge)
    if (state.status === "waiting_decision") {
      const hasUnknownOutcome = events.some((e) => e.type === "step_outcome_unknown");
      if (hasUnknownOutcome || state.activeDecision?.reasonCode === "artefact_missing") {
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

      // If judgement(decide) committed right before crash and handoff_sent has not yet been emitted
      if (!state.activeHandoff && state.activeDecision) {
        const pendingJudge = [...events]
          .reverse()
          .find((e) => e.type === "judgement" && e.data.final === "decide");
        if (pendingJudge && pendingJudge.type === "judgement") {
          const stepDef = flow.steps.find((s) => s.id === pendingJudge.stepId);
          if (stepDef) {
            const occ = getOccurrenceForAttempt(events, pendingJudge.stepId, pendingJudge.attemptId);
            const handoffId = buildDeterministicHandoffId(runId, pendingJudge.stepId, occ);
            const settledOutcome = events.some(
              (e) => e.type === "step_failed" && e.stepId === pendingJudge.stepId && e.attemptId === pendingJudge.attemptId,
            )
              ? "failed"
              : "passed";
            const spec = getHandoffSpecForStep(
              flow,
              stepDef,
              settledOutcome,
              pendingJudge.data.reasonCodes[0] ?? "decision_required",
              nowDate(),
            );
            const head = findHead(store, runId);
            store.appendEvent({
              v: 1,
              runId,
              seq: head.seq + 1,
              eventId: nextEventId("ev_hnd", head.seq + 1),
              prev: head.hash,
              at: nowIso(),
              actor: "runner",
              type: "handoff_sent",
              stepId: pendingJudge.stepId,
              attemptId: pendingJudge.attemptId,
              data: {
                handoffId,
                kind: spec.kind,
                target: spec.target,
                reasonCode: spec.reasonCode,
                optionKeys: spec.optionKeys,
                ...(spec.alwaysDecide ? { alwaysDecide: true } : {}),
                ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
              },
            });
            fireCrash("K_AFTER_HANDOFF_SENT");
            const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
            events = reloaded.events;
            state = reloaded.state;
          }
        }
      }

      if (state.activeHandoff) {
        const active = state.activeHandoff;
        if (!options.inbox) {
          if (active.expiresAt && nowDate().getTime() >= Date.parse(active.expiresAt)) {
            const curHead = findHead(store, runId);
            store.appendEvent({
              v: 1,
              runId,
              seq: curHead.seq + 1,
              eventId: nextEventId("ev_ret", curHead.seq + 1),
              prev: curHead.hash,
              at: nowIso(),
              actor: "system",
              type: "handoff_returned",
              stepId: active.stepId,
              attemptId: active.attemptId,
              data: {
                handoffId: active.handoffId,
                choiceKey: "unanswered_expired",
                resolution: "expired",
                actorId: "system",
              },
            });
            fireCrash("K_AFTER_HANDOFF_RETURNED");
            const afterRet = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
            events = afterRet.events;
            state = afterRet.state;
          } else {
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
        } else {
        const stepDef = flow.steps.find((s) => s.id === active.stepId);
        const occ = getOccurrenceForAttempt(events, active.stepId, active.attemptId);
        const settledOutcome = events.some(
          (e) => e.type === "step_failed" && e.stepId === active.stepId && e.attemptId === active.attemptId,
        )
          ? "failed"
          : "passed";
        const spec = stepDef
          ? getHandoffSpecForStep(flow, stepDef, settledOutcome, active.reasonCode, nowDate())
          : {
              options: active.optionKeys.map((k) => ({ key: k, label: k, detail: k })),
            };
        const head = findHead(store, runId);

        const emitRes = await emitDecisionCardToInbox({
          target: options.inbox,
          handoffId: active.handoffId,
          runId,
          headSeq: head.seq,
          headHash: head.hash,
          stepId: active.stepId,
          reasonCode: active.reasonCode,
          title: stepDef?.title,
          alwaysDecide: active.alwaysDecide,
          options: spec.options,
          nowIso: nowIso(),
        });
        if (emitRes.emitted) {
          fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
        }

        const res = await readDecisionCardResolution(options.inbox, active.handoffId);
        if (res.status === "answered") {
          if (!active.optionKeys.includes(res.choiceKey)) {
            const safeAttempted = FlowIdRegex.test(res.choiceKey) ? res.choiceKey : "invalid";
            const invalidCardCount = await countInvalidAnsweredDecisionCards(
              options.inbox,
              active.handoffId,
              active.optionKeys,
            );
            const recordedInvalidRejections = events.filter(
              (e) =>
                e.type === "return_rejected" &&
                e.data.handoffId === active.handoffId &&
                e.data.rejectReason === "invalid_option",
            ).length;
            if (recordedInvalidRejections < invalidCardCount) {
              const curHead = findHead(store, runId);
              store.appendEvent({
                v: 1,
                runId,
                seq: curHead.seq + 1,
                eventId: nextEventId("ev_rej", curHead.seq + 1),
                prev: curHead.hash,
                at: nowIso(),
                actor: "human",
                type: "return_rejected",
                stepId: active.stepId,
                attemptId: active.attemptId,
                data: {
                  handoffId: active.handoffId,
                  attemptedChoiceKey: safeAttempted,
                  rejectReason: "invalid_option",
                },
              });
            }
            const reemitHead = findHead(store, runId);
            const reemitRes = await emitDecisionCardToInbox({
              target: options.inbox,
              handoffId: active.handoffId,
              runId,
              headSeq: reemitHead.seq,
              headHash: reemitHead.hash,
              stepId: active.stepId,
              reasonCode: active.reasonCode,
              title: stepDef?.title,
              alwaysDecide: active.alwaysDecide,
              options: spec.options,
              validOptionKeys: active.optionKeys,
              nowIso: nowIso(),
            });
            if (reemitRes.emitted) {
              fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
            }
            store.checkpointPassive();
            const rejLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
            return {
              runId,
              finalStatus: rejLoaded.state.status,
              terminalOutcome: rejLoaded.state.terminalOutcome,
              terminalReason: rejLoaded.state.terminalReason,
              dispatchedSteps,
              eventCount: rejLoaded.events.length,
            };
          }

          const curHead = findHead(store, runId);
          store.appendEvent(
            {
              v: 1,
              runId,
              seq: curHead.seq + 1,
              eventId: nextEventId("ev_ret", curHead.seq + 1),
              prev: curHead.hash,
              at: nowIso(),
              actor: "human",
              type: "handoff_returned",
              stepId: active.stepId,
              attemptId: active.attemptId,
              data: {
                handoffId: active.handoffId,
                choiceKey: res.choiceKey,
                resolution: "answered",
                actorId: res.actorId,
              },
            },
            res.customAnswer !== undefined ? { privateDetail: res.customAnswer } : undefined,
          );
          fireCrash("K_AFTER_HANDOFF_RETURNED");
        } else if (res.status === "dismissed") {
          const curHead = findHead(store, runId);
          store.appendEvent(
            {
              v: 1,
              runId,
              seq: curHead.seq + 1,
              eventId: nextEventId("ev_ret", curHead.seq + 1),
              prev: curHead.hash,
              at: nowIso(),
              actor: "human",
              type: "handoff_returned",
              stepId: active.stepId,
              attemptId: active.attemptId,
              data: {
                handoffId: active.handoffId,
                choiceKey: "dismissed",
                resolution: "dismissed",
                actorId: res.actorId,
              },
            },
            res.reason !== undefined ? { privateDetail: res.reason } : undefined,
          );
          fireCrash("K_AFTER_HANDOFF_RETURNED");
        } else if (
          active.expiresAt &&
          nowDate().getTime() >= Date.parse(active.expiresAt)
        ) {
          const curHead = findHead(store, runId);
          store.appendEvent({
            v: 1,
            runId,
            seq: curHead.seq + 1,
            eventId: nextEventId("ev_ret", curHead.seq + 1),
            prev: curHead.hash,
            at: nowIso(),
            actor: "system",
            type: "handoff_returned",
            stepId: active.stepId,
            attemptId: active.attemptId,
            data: {
              handoffId: active.handoffId,
              choiceKey: "unanswered_expired",
              resolution: "expired",
              actorId: "system",
            },
          });
          fireCrash("K_AFTER_HANDOFF_RETURNED");
          await supersedeDecisionCardInInbox(
            options.inbox,
            active.handoffId,
            "Flow decision expired (on_unanswered)",
          );
        } else {
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

        // Reload after committing handoff_returned and run follow-up
        const afterRet = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
        events = afterRet.events;
        state = afterRet.state;
        void occ;
        }
      }
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
        at: nowIso(),
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

    // 3b. Complete any pending handoff_returned follow-up (e.g., crash right after K_AFTER_HANDOFF_RETURNED)
    for (let i = events.length - 1; i >= 0; i--) {
      const ev = events[i]!;
      if (ev.type === "handoff_returned") {
        const sentEv = events.find(
          (s): s is FlowHandoffSentEvent =>
            s.type === "handoff_sent" && s.data.handoffId === ev.data.handoffId,
        );
        if (sentEv) {
          if (ev.data.resolution === "expired" && options.inbox) {
            await supersedeDecisionCardInInbox(
              options.inbox,
              ev.data.handoffId,
              "Flow decision expired (on_unanswered)",
            );
          }
          completeHandoffFollowUp({
            store,
            runId,
            flow,
            state,
            events,
            sentEv,
            returnedEv: ev,
            nowIso: nowIso(),
            fireCrash,
          });
          const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
          events = reloaded.events;
          state = reloaded.state;
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
        }
        break;
      }
    }

    // 4. Crash Recovery Scan
    const startedAttempts: FlowStepStartedEvent[] = [];
    const outcomeAttempts = new Set<string>();
    const judgedAttempts = new Set<string>();
    const handoffAttempts = new Set<string>();
    const passedResultAttempts: Array<Extract<FlowEvent, { type: "step_result" }>> = [];
    const failedResultAttempts: Array<{
      stepId: string;
      attemptId: string;
      errorCode: "timeout" | "execution_error" | "budget_exceeded" | "check_failed";
    }> = [];

    for (const ev of events) {
      if (ev.type === "step_started") {
        startedAttempts.push(ev);
      } else if (ev.type === "step_result") {
        const key = `${ev.stepId}:${ev.attemptId}`;
        outcomeAttempts.add(key);
        passedResultAttempts.push(ev);
      } else if (ev.type === "step_failed") {
        const key = `${ev.stepId}:${ev.attemptId}`;
        outcomeAttempts.add(key);
        failedResultAttempts.push({ stepId: ev.stepId, attemptId: ev.attemptId, errorCode: ev.data.errorCode });
      } else if (ev.type === "step_outcome_unknown") {
        outcomeAttempts.add(`${ev.stepId}:${ev.attemptId}`);
      } else if (ev.type === "judgement") {
        judgedAttempts.add(`${ev.stepId}:${ev.attemptId}`);
      } else if (ev.type === "handoff_sent" || ev.type === "handoff_returned") {
        handoffAttempts.add(`${ev.stepId}:${ev.attemptId}`);
      }
    }

    // K1 / K3 recovery: commit step_outcome_unknown + judgement(stop) + run_finished(stopped) ATOMICALLY
    for (const att of startedAttempts) {
      const key = `${att.stepId}:${att.attemptId}`;
      if (!outcomeAttempts.has(key) && !handoffAttempts.has(key)) {
        if (
          options.workspaceRepoRoot &&
          flow.workspace?.kind === "git-worktree" &&
          flow.steps.some((step) => step.id === att.stepId && step.type === "agent")
        ) {
          await recoverEphemeralWorktree({
            repoRoot: options.workspaceRepoRoot,
            worktreeBaseDir,
            runId,
            attemptId: att.attemptId,
            intentEventId: att.eventId,
          });
        }
        const tsIso = nowIso();
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_unk", seq), prev, at: tsIso,
              actor: "runner", type: "step_outcome_unknown", stepId: att.stepId, attemptId: att.attemptId,
              data: { reasonCode: "crash_during_execution" },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
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
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
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

    // K4 recovery: re-evaluate step judgement cleanly without re-running step
    for (const att of passedResultAttempts) {
      const key = `${att.stepId}:${att.attemptId}`;
      if (!judgedAttempts.has(key)) {
        const step = flow.steps.find((s) => s.id === att.stepId);
        const occurrence = getOccurrenceForAttempt(events, att.stepId, att.attemptId);
        let gitSignals: StepSignals = {};
        if (step?.type === "agent" && flow.workspace?.kind === "git-worktree") {
          const { base_sha: baseSha, head_sha: headSha } = att.data.outputs;
          if (options.workspaceRepoRoot || baseSha || headSha) {
            if (!options.workspaceRepoRoot || !baseSha || !headSha) {
              throw new GitDiffEvidenceError("Recovered worktree result is missing its repository or commit pair");
            }
            gitSignals = await extractGitDiffSignals({
              repoRoot: options.workspaceRepoRoot,
              baseSha,
              headSha,
              expectedHeadSha: options.expectedHeadSha,
              flow,
              timeoutMs: Math.min(stepTimeoutMs, 15_000),
            });
            if (!gitSignals.changedFiles) {
              throw new GitDiffEvidenceError("Recovered worktree commits could not be compared");
            }
          }
        }
        const hookSignals =
          step && options.evaluateSignals
            ? await options.evaluateSignals({
                step,
                attemptId: att.attemptId,
                occurrence,
                outcome: "passed",
              })
            : {};
        const decision = step
          ? evaluateStepJudgement({
              flow,
              step,
              occurrence,
              rewindsUsed: state.rewindsUsed,
              outcome: "passed",
              budgetUsed: state.budgetUsed,
              signals: { ...gitSignals, ...hookSignals },
            })
          : {
              final: "continue" as const,
              ruleHits: ["step_passed" as const],
              reasonCodes: ["ok" as const],
              engineTokens: 0,
              shouldRewind: false,
              shouldRerunCheck: false,
            };

        if (gitSignals.changedFiles && options.workspaceRepoRoot) {
          const intent = startedAttempts.find((event) => event.attemptId === att.attemptId && event.stepId === att.stepId);
          if (intent) {
            await recoverEphemeralWorktree({
              repoRoot: options.workspaceRepoRoot,
              worktreeBaseDir,
              runId,
              attemptId: att.attemptId,
              intentEventId: intent.eventId,
              keepBranch: decision.final !== "stop" && !decision.shouldRewind && !decision.shouldRerunCheck,
            });
          }
        }

        if (decision.final === "stop") {
          const tsIso = nowIso();
          const finReason = decision.reasonCodes.includes("budget_exceeded")
            ? "ceiling_reached"
            : "unrecoverable_failure";
          store.appendChainedBatch(runId, [
            (seq, prev) => ({
              event: {
                v: 1,
                runId,
                seq,
                eventId: nextEventId("ev_judge", seq),
                prev,
                at: tsIso,
                actor: "system",
                type: "judgement",
                stepId: att.stepId,
                attemptId: att.attemptId,
                data: {
                  final: "stop",
                  ruleHits: decision.ruleHits,
                  reasonCodes: decision.reasonCodes,
                  engineTokens: 0,
                },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1,
                runId,
                seq,
                eventId: nextEventId("ev_fin", seq),
                prev,
                at: tsIso,
                actor: "system",
                type: "run_finished",
                data: { outcome: "stopped", reasonCode: finReason },
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

        if (decision.final === "decide") {
          const handoffId = buildDeterministicHandoffId(runId, att.stepId, occurrence);
          const reason = decision.reasonCodes[0] ?? "decision_required";
          const spec = step
            ? getHandoffSpecForStep(flow, step, "passed", reason, nowDate())
            : {
                kind: "decision" as const,
                target: "operator",
                reasonCode: reason,
                optionKeys: ["continue", "retry", "stop"],
                expiresAt: undefined,
                options: [
                  { key: "continue", label: "Continue", detail: "Approve and continue flow" },
                  { key: "retry", label: "Retry", detail: "Rewind and retry step" },
                  { key: "stop", label: "Stop", detail: "Stop run" },
                ],
              };
          const tsIso = nowIso();
          const resBatch = store.appendChainedBatch(runId, [
            (seq, prev) => ({
              event: {
                v: 1,
                runId,
                seq,
                eventId: nextEventId("ev_judge", seq),
                prev,
                at: tsIso,
                actor: "system",
                type: "judgement",
                stepId: att.stepId,
                attemptId: att.attemptId,
                data: {
                  final: "decide",
                  ruleHits: decision.ruleHits,
                  reasonCodes: decision.reasonCodes,
                  engineTokens: 0,
                },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1,
                runId,
                seq,
                eventId: nextEventId("ev_hnd", seq),
                prev,
                at: tsIso,
                actor: "runner",
                type: "handoff_sent",
                stepId: att.stepId,
                attemptId: att.attemptId,
                data: {
                  handoffId,
                  kind: spec.kind,
                  target: spec.target,
                  reasonCode: spec.reasonCode,
                  optionKeys: spec.optionKeys,
                  ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
                },
              },
            }),
          ]);
          fireCrash("K_AFTER_HANDOFF_SENT");
          if (options.inbox) {
            const tail = resBatch[resBatch.length - 1]!;
            const emitRes = await emitDecisionCardToInbox({
              target: options.inbox,
              handoffId,
              runId,
              headSeq: tail.seq,
              headHash: tail.hash,
              stepId: att.stepId,
              reasonCode: spec.reasonCode,
              title: step?.title,
              options: spec.options,
              nowIso: nowIso(),
            });
            if (emitRes.emitted) {
              fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
            }
          }
          store.checkpointPassive();
          const waitLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
          return {
            runId,
            finalStatus: waitLoaded.state.status,
            terminalOutcome: waitLoaded.state.terminalOutcome,
            terminalReason: waitLoaded.state.terminalReason,
            dispatchedSteps,
            eventCount: waitLoaded.events.length,
          };
        }

        if (decision.shouldRewind && decision.rewindTargetStepId) {
          const toStepId = decision.rewindTargetStepId;
          const tsIso = nowIso();
          const judgeReasons: FlowReasonCode[] =
            decision.final === "continue" ? ["ok"] : decision.reasonCodes;
          const batchRes = store.appendChainedBatch(runId, [
            (seq, prev) => ({
              event: {
                v: 1,
                runId,
                seq,
                eventId: nextEventId("ev_judge", seq),
                prev,
                at: tsIso,
                actor: "system",
                type: "judgement",
                stepId: att.stepId,
                attemptId: att.attemptId,
                data: {
                  final: decision.final,
                  ruleHits: decision.final === "continue" ? ["step_passed"] : decision.ruleHits,
                  reasonCodes: judgeReasons,
                  engineTokens: 0,
                },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1,
                runId,
                seq,
                eventId: nextEventId("ev_rew", seq),
                prev,
                at: tsIso,
                actor: "runner",
                type: "step_rewound",
                stepId: att.stepId,
                attemptId: att.attemptId,
                data: {
                  fromStepId: att.stepId,
                  toStepId,
                  rewindNumber: state.rewindsUsed + 1,
                  reasonCode: decision.reasonCodes[0] ?? "stale_sha",
                },
              },
            }),
          ]);
          if (decision.final === "notify" && options.inbox) {
            const judgeRow = batchRes[0]!;
            const notifyReason = decision.reasonCodes[0] ?? "stale_sha";
            const actionId = buildDeterministicNotifyCardId(
              runId,
              att.stepId,
              occurrence,
              notifyReason,
            );
            await emitNotifyCardToInbox({
              target: options.inbox,
              actionId,
              runId,
              headSeq: judgeRow.seq,
              headHash: judgeRow.hash,
              stepId: att.stepId,
              reasonCode: notifyReason,
              nowIso: nowIso(),
            });
          }
          fireCrash("K_AFTER_REWIND");
          judgedAttempts.add(key);
          const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
          events = reloaded.events;
          state = reloaded.state;
          continue;
        }

        const head = findHead(store, runId);
        const judgeEv = store.appendEvent({
          v: 1,
          runId,
          seq: head.seq + 1,
          eventId: nextEventId("ev_judge", head.seq + 1),
          prev: head.hash,
          at: nowIso(),
          actor: "system",
          type: "judgement",
          stepId: att.stepId,
          attemptId: att.attemptId,
          data: {
            final: decision.final,
            ruleHits: decision.ruleHits,
            reasonCodes: decision.reasonCodes,
            engineTokens: 0,
          },
        });
        fireCrash("K9_AFTER_JUDGEMENT");
        if (decision.final === "notify" && options.inbox) {
          const notifyReason = decision.reasonCodes[0] ?? "ok";
          const actionId = buildDeterministicNotifyCardId(
            runId,
            att.stepId,
            occurrence,
            notifyReason,
          );
          await emitNotifyCardToInbox({
            target: options.inbox,
            actionId,
            runId,
            headSeq: judgeEv.seq,
            headHash: judgeEv.hash,
            stepId: att.stepId,
            reasonCode: notifyReason,
            nowIso: nowIso(),
          });
        }
        judgedAttempts.add(key);
        const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
        events = reloaded.events;
        state = reloaded.state;
      }
    }

    // K4 recovery for durable step_failed without judgement -> synthesize stop judgement + run_finished(stopped)
    for (const att of failedResultAttempts) {
      const key = `${att.stepId}:${att.attemptId}`;
      if (!judgedAttempts.has(key)) {
        const tsIso = nowIso();
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
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
              v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
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

    // 5. Execute remaining pending steps via cursor loop supporting Slice 2 rewinds
    let cursor = 0;
    while (cursor < flow.steps.length) {
      if (state.nextStepId) {
        const targetIdx = flow.steps.findIndex((s) => s.id === state.nextStepId);
        if (targetIdx !== -1) {
          cursor = targetIdx;
        }
      }

      const step = flow.steps[cursor]!;
      if (!state.nextStepId && isStepCompletedForCursor(step, state, events, flow)) {
        cursor += 1;
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
          at: nowIso(),
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
        at: nowIso(),
      });
      dispatchedSteps.push({
        stepId: step.id,
        attemptId: intent.attemptId,
        occurrence: intent.occurrence,
      });

      fireCrash("K1_AFTER_INTENT");

      const collectPreviousOutputs = (): Record<string, Record<string, string>> => {
        const prevOut: Record<string, Record<string, string>> = Object.create(null);
        for (const [sid, st] of Object.entries(state.stepStates)) {
          prevOut[sid] = { ...st.outputs };
        }
        return prevOut;
      };

      const filterStepOutputs = (
        raw: Record<string, string> | undefined,
      ): Record<string, string> => {
        const candidate: Record<string, string> = { status: "ok" };
        if (raw) {
          for (const [k, v] of Object.entries(raw)) {
            if (typeof v !== "string") continue;
            if (k === "branch" && !FlowSafeValueRegex.test(v)) continue;
            if ((k === "head_sha" || k === "base_sha") && !FlowGitShaRegex.test(v)) continue;
            if (k === "repro_test" && !FlowSafePathSchema.safeParse(v).success) continue;
            candidate[k] = v;
          }
        }
        const parsed = FlowStepResultOutputsSchema.safeParse(candidate);
        if (parsed.success) {
          const clean: Record<string, string> = {};
          for (const [k, v] of Object.entries(parsed.data)) {
            if (typeof v === "string") clean[k] = v;
          }
          return clean;
        }
        return { status: "ok" };
      };

      // Handle decision & handoff steps via handoff_sent + optional inbox card or bound role adapter
      if (step.type === "decision" || step.type === "handoff") {
        const handoffId = buildDeterministicHandoffId(runId, step.id, intent.occurrence);
        const spec = getHandoffSpecForStep(flow, step, "passed", "decision_required", nowDate());
        const sentEv = store.appendEvent({
          v: 1,
          runId,
          seq: intent.seq + 1,
          eventId: nextEventId("ev_hnd", intent.seq + 1),
          prev: intent.hash,
          at: nowIso(),
          actor: "runner",
          type: "handoff_sent",
          stepId: step.id,
          attemptId: intent.attemptId,
          data: {
            handoffId,
            kind: spec.kind,
            target: spec.target,
            reasonCode: spec.reasonCode,
            optionKeys: spec.optionKeys,
            ...(spec.alwaysDecide ? { alwaysDecide: true } : {}),
            ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
          },
        });
        fireCrash("K_AFTER_HANDOFF_SENT");

        const handoffAdapter =
          step.type === "handoff" && step.to ? roleAdapters.get(step.to) : undefined;

        if (step.type === "handoff" && handoffAdapter) {
          let adapterRes: Awaited<ReturnType<FlowStepAdapter["dispatch"]>>;
          try {
            adapterRes = await runWithTimeout(step.id, stepTimeoutMs, async (signal) => {
              if (options.onStepDispatch) {
                await options.onStepDispatch({
                  stepId: step.id,
                  attemptId: intent.attemptId,
                  occurrence: intent.occurrence,
                  signal,
                });
              }
              return handoffAdapter.dispatch({
                runId,
                step,
                attemptId: intent.attemptId,
                occurrence: intent.occurrence,
                roleName: step.to,
                runtime: step.to ? flow.roles?.[step.to]?.runtime : undefined,
                previousOutputs: collectPreviousOutputs(),
                signal,
                timeoutMs: stepTimeoutMs,
              });
            });
          } catch (err) {
            if (
              err instanceof StepTimeoutError ||
              err instanceof StepDeadlineExceededError ||
              err instanceof FlowAdapterAbortedError
            ) {
              const timeoutDecision = evaluateStepJudgement({
                flow,
                step,
                occurrence: intent.occurrence,
                rewindsUsed: state.rewindsUsed,
                outcome: "failed",
                errorCode: "timeout",
                budgetUsed: {
                  tokens: state.budgetUsed.tokens,
                  steps: state.budgetUsed.steps + 1,
                },
              });
              const tsIso = nowIso();
              if (timeoutDecision.final === "decide") {
                if (options.inbox) {
                  const emitRes = await emitDecisionCardToInbox({
                    target: options.inbox,
                    handoffId,
                    runId,
                    headSeq: sentEv.seq,
                    headHash: sentEv.hash,
                    stepId: step.id,
                    reasonCode: "timeout",
                    title: step.title,
                    alwaysDecide: spec.alwaysDecide,
                    options: spec.options,
                    nowIso: tsIso,
                  });
                  if (emitRes.emitted) {
                    fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
                  }
                }
              } else {
                store.appendChainedBatch(runId, [
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_hcancel", seq), prev, at: tsIso,
                      actor: "runner", type: "handoff_cancelled", stepId: step.id, attemptId: intent.attemptId,
                      data: { handoffId, reasonCode: "timeout" },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: tsIso,
                      actor: "runner", type: "step_failed", stepId: step.id, attemptId: intent.attemptId,
                      data: { errorCode: "timeout" },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                      actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        final: "stop",
                        ruleHits: timeoutDecision.ruleHits,
                        reasonCodes: timeoutDecision.reasonCodes,
                        engineTokens: 0,
                      },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
                      actor: "system", type: "run_finished",
                      data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
                    },
                  }),
                ]);
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
            throw err;
          }

          if (adapterRes.kind !== "handoff") {
            throw new Error(
              `Handoff step '${step.id}' adapter '${handoffAdapter.id}' returned non-handoff result`,
            );
          }

          if (!spec.optionKeys.includes(adapterRes.verdict)) {
            const safeAttempted = FlowIdRegex.test(adapterRes.verdict) ? adapterRes.verdict : "invalid";
            const rejHead = findHead(store, runId);
            store.appendEvent({
              v: 1,
              runId,
              seq: rejHead.seq + 1,
              eventId: nextEventId("ev_rej", rejHead.seq + 1),
              prev: rejHead.hash,
              at: nowIso(),
              actor: "agent",
              type: "return_rejected",
              stepId: step.id,
              attemptId: intent.attemptId,
              data: {
                handoffId,
                attemptedChoiceKey: safeAttempted,
                rejectReason: "invalid_option",
              },
            });
            store.checkpointPassive();
            const waitLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
            return {
              runId,
              finalStatus: waitLoaded.state.status,
              terminalOutcome: waitLoaded.state.terminalOutcome,
              terminalReason: waitLoaded.state.terminalReason,
              dispatchedSteps,
              eventCount: waitLoaded.events.length,
            };
          }

          const resolvedActorId =
            adapterRes.actorId && FlowIdRegex.test(adapterRes.actorId)
              ? adapterRes.actorId
              : FlowIdRegex.test(handoffAdapter.id)
                ? handoffAdapter.id
                : "reviewer-1";

          const retHead = findHead(store, runId);
          store.appendEvent(
            {
              v: 1,
              runId,
              seq: retHead.seq + 1,
              eventId: nextEventId("ev_ret", retHead.seq + 1),
              prev: retHead.hash,
              at: nowIso(),
              actor: "agent",
              type: "handoff_returned",
              stepId: step.id,
              attemptId: intent.attemptId,
              data: {
                handoffId,
                choiceKey: adapterRes.verdict,
                resolution: "answered",
                actorId: resolvedActorId,
              },
            },
            adapterRes.note !== undefined ? { privateDetail: adapterRes.note } : undefined,
          );
          fireCrash("K_AFTER_HANDOFF_RETURNED");

          const afterRet = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
          events = afterRet.events;
          state = afterRet.state;

          const sentEventObj = events.find(
            (e): e is FlowHandoffSentEvent =>
              e.type === "handoff_sent" && e.data.handoffId === handoffId,
          );
          const returnedEventObj = events.find(
            (e): e is FlowHandoffReturnedEvent =>
              e.type === "handoff_returned" && e.data.handoffId === handoffId,
          );
          if (sentEventObj && returnedEventObj) {
            completeHandoffFollowUp({
              store,
              runId,
              flow,
              state,
              events,
              sentEv: sentEventObj,
              returnedEv: returnedEventObj,
              nowIso: nowIso(),
              fireCrash,
            });
          }

          const reloadedAfterHandoff = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
          events = reloadedAfterHandoff.events;
          state = reloadedAfterHandoff.state;

          if (
            state.status === "stopped" ||
            state.status === "finished" ||
            state.status === "waiting_decision"
          ) {
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

          if (!state.nextStepId) {
            cursor += 1;
          }
          continue;
        }

        if (options.inbox) {
          const emitRes = await emitDecisionCardToInbox({
            target: options.inbox,
            handoffId,
            runId,
            headSeq: sentEv.seq,
            headHash: sentEv.hash,
            stepId: step.id,
            reasonCode: spec.reasonCode,
            title: step.title,
            alwaysDecide: spec.alwaysDecide,
            options: spec.options,
            nowIso: nowIso(),
          });
          if (emitRes.emitted) {
            fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
          }
        }

        store.checkpointPassive();
        const waitLoaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
        return {
          runId,
          finalStatus: waitLoaded.state.status,
          terminalOutcome: waitLoaded.state.terminalOutcome,
          terminalReason: waitLoaded.state.terminalReason,
          dispatchedSteps,
          eventCount: waitLoaded.events.length,
        };
      }

      const startMs = Date.now();
      const deadlineMs = startMs + stepTimeoutMs;
      let stepWorkOutcome:
        | {
            kind: "agent";
            artifactId: string;
            contentHash: string;
            size: number;
            outputs: Record<string, string>;
            tokensUsed: number;
            signals?: StepSignals;
          }
        | {
            kind: "check";
            primaryCheckId: FlowBuiltInCheckId;
            targetSha: string;
            passed: boolean;
            errorClass?: string;
            signals?: StepSignals;
          }
        | { kind: "noop" } = { kind: "noop" };

      let activeWorktree: WorktreeHandle | undefined;
      let keepWorktreeBranch = false;

      try {
        if (
          step.type === "agent" &&
          flow.workspace?.kind === "git-worktree" &&
          options.workspaceRepoRoot
        ) {
          activeWorktree = await createEphemeralWorktree({
            repoRoot: options.workspaceRepoRoot,
            baseRef: flow.workspace.base ?? "main",
            worktreeBaseDir,
            runId,
            stepId: step.id,
            attemptId: intent.attemptId,
            intentEventId: intent.eventId,
            timeoutMs: Math.min(stepTimeoutMs, 15_000),
          });
          fireCrash("K_AFTER_WORKTREE_CREATED");
        }

        stepWorkOutcome = await runWithTimeout(step.id, stepTimeoutMs, async (signal) => {
          if (options.onStepDispatch) {
            await options.onStepDispatch({
              stepId: step.id,
              attemptId: intent.attemptId,
              occurrence: intent.occurrence,
              signal,
            });
          }
          if (signal.aborted || Date.now() > deadlineMs) {
            throw new StepTimeoutError(step.id, stepTimeoutMs);
          }

          if (step.type === "agent") {
            const runtime = step.role && Object.hasOwn(flow.roles ?? {}, step.role)
              ? flow.roles?.[step.role]?.runtime
              : undefined;
            const boundAdapter =
              (step.role ? roleAdapters.get(step.role) : undefined) ?? (runtime === undefined ? options.adapter : undefined);
            if (runtime !== undefined && !boundAdapter) {
              throw new WorktreeOutcomeRejectedError(`No adapter configured for runtime '${runtime}'`);
            }

            let adapterOutputs: Record<string, string> | undefined;
            let adapterArtifactBytes: Buffer | undefined;
            let adapterArtifactName: string | undefined;
            let adapterTokensUsed = DEFAULT_STUB_TOKEN_COST;
            let combinedSignals: StepSignals = {};

            if (boundAdapter) {
              const adapterRes = await boundAdapter.dispatch({
                runId,
                step,
                attemptId: intent.attemptId,
                occurrence: intent.occurrence,
                roleName: step.role,
                runtime,
                worktreePath: activeWorktree?.worktreePath,
                baseSha: activeWorktree?.baseSha,
                previousOutputs: collectPreviousOutputs(),
                signal,
                timeoutMs: stepTimeoutMs,
              });
              if (adapterRes.kind !== "agent") {
                throw new Error(
                  `Agent step '${step.id}' adapter '${boundAdapter.id}' returned non-agent result`,
                );
              }
              adapterOutputs = adapterRes.outputs;
              adapterArtifactBytes = adapterRes.artifactBytes;
              adapterArtifactName = adapterRes.artifactName;
              adapterTokensUsed = adapterRes.tokensUsed ?? DEFAULT_STUB_TOKEN_COST;
              if (adapterRes.signals) {
                combinedSignals = { ...combinedSignals, ...adapterRes.signals };
              }
            }

            if (signal.aborted || Date.now() > deadlineMs) {
              throw new StepTimeoutError(step.id, stepTimeoutMs);
            }

            const rawOutputs: Record<string, string> = { ...(adapterOutputs ?? {}) };
            if (activeWorktree && options.workspaceRepoRoot) {
              const wtOutcome = await captureWorktreeOutcome(activeWorktree);
              if (!wtOutcome.isClean) {
                throw new WorktreeOutcomeRejectedError(
                  `Worktree '${activeWorktree.worktreePath}' has uncommitted or untracked changes`,
                );
              }
              if (
                adapterOutputs?.["head_sha"] !== undefined &&
                adapterOutputs["head_sha"] !== wtOutcome.headSha
              ) {
                throw new WorktreeOutcomeRejectedError(
                  `Adapter head_sha '${adapterOutputs["head_sha"]}' disagrees with verified worktree HEAD '${wtOutcome.headSha}'`,
                );
              }
              rawOutputs["base_sha"] = wtOutcome.baseSha;
              rawOutputs["head_sha"] = wtOutcome.headSha;
              if (wtOutcome.branch && !rawOutputs["branch"]) {
                rawOutputs["branch"] = wtOutcome.branch;
              }
              const gitSignals = await extractGitDiffSignals({
                repoRoot: options.workspaceRepoRoot,
                baseSha: wtOutcome.baseSha,
                headSha: wtOutcome.headSha,
                expectedHeadSha: options.expectedHeadSha,
                flow,
                timeoutMs: Math.min(stepTimeoutMs, 15_000),
                signal,
              });
              combinedSignals = { ...combinedSignals, ...gitSignals };
            }

            const filteredOutputs = filterStepOutputs(rawOutputs);
            if (activeWorktree && rawOutputs["head_sha"]) {
              filteredOutputs["base_sha"] = activeWorktree.baseSha;
              filteredOutputs["head_sha"] = rawOutputs["head_sha"];
            }
            const wantsHeadShaArtifact =
              Boolean(filteredOutputs["head_sha"]) &&
              Boolean(step.outputs?.includes("head_sha"));

            const declaredOutputName = wantsHeadShaArtifact
              ? "head_sha"
              : (adapterArtifactName ?? step.outputs?.[0]);
            const artifactId = buildCollisionFreeArtifactId(
              step.id,
              declaredOutputName,
              intent.occurrence,
            );
            const agentBytes =
              adapterArtifactBytes ??
              (wantsHeadShaArtifact
                ? Buffer.from(JSON.stringify(filteredOutputs) + "\n", "utf8")
                : options.getStubAgentBytes
                  ? options.getStubAgentBytes({ step, occurrence: intent.occurrence })
                  : Buffer.from(`stub output for ${step.id}\n`, "utf8"));

            const rec = store!.writeAndRecordArtifact({
              artifactId,
              runId,
              stepId: step.id,
              attemptId: intent.attemptId,
              name: declaredOutputName ?? `${step.id.slice(0, 32)}.txt`,
              mediaType: wantsHeadShaArtifact ? "application/json" : "text/plain",
              bytes: agentBytes,
              deadlineMs,
            });
            return {
              kind: "agent" as const,
              artifactId,
              contentHash: rec.contentHash,
              size: rec.size,
              outputs: filteredOutputs,
              tokensUsed: adapterTokensUsed,
              ...(Object.keys(combinedSignals).length > 0 ? { signals: combinedSignals } : {}),
            };
          }

          if (step.type === "check") {
            const declaredChecks =
              step.run && step.run.length > 0
                ? step.run
                : step.repro
                  ? ["repro"]
                  : ["check_nonempty"];
            const isArtefactCheckOnly =
              declaredChecks.every((name) => SUPPORTED_BUILT_IN_CHECKS.has(name)) && !step.repro;
            const isCommandCheckSuite =
              !isArtefactCheckOnly && declaredChecks.every((name) => isSupportedSuiteCheckId(name));

            const artifactsDir = path.join(store!.projectDir, "artifacts", runId);
            const receiptNameById = new Map(store!.listArtifacts(runId).map((r) => [r.artifact_id, r.name]));
            const targetRec = resolvePinnedCheckTarget(step, events, receiptNameById, flow);
            const targetSha = targetRec ? targetRec.sha256 : "0".repeat(64);

            if (isCommandCheckSuite) {
              const commandCheckIds = declaredChecks.filter((name): name is FlowCommandCheckId =>
                isFlowCommandCheckId(name),
              );
              const requiresRepro = Boolean(step.repro) || declaredChecks.includes("repro");
              let primaryCheckId: FlowBuiltInCheckId = commandCheckIds[0] ?? "repro";
              let defaultPassed = false;
              let errorClass: string | undefined;
              let checkSignals: StepSignals | undefined;

              const againstDot = step.against?.indexOf(".") ?? -1;
              const producerStepId =
                againstDot !== -1
                  ? step.against!.slice(0, againstDot)
                  : targetRec?.stepId;
              const producerOutputs = producerStepId
                ? state.stepStates[producerStepId]?.outputs
                : undefined;

              let reproTestPath: string | undefined;
              if (step.repro?.test.from) {
                const reproDot = step.repro.test.from.indexOf(".");
                if (reproDot !== -1) {
                  const reproProducer = step.repro.test.from.slice(0, reproDot);
                  const reproField = step.repro.test.from.slice(reproDot + 1);
                  reproTestPath = state.stepStates[reproProducer]?.outputs[reproField];
                }
              } else if (requiresRepro) {
                reproTestPath = producerOutputs?.["repro_test"];
              }

              const headSha = producerOutputs?.["head_sha"];
              let baseSha = producerOutputs?.["base_sha"];
              if (!baseSha && options.workspaceRepoRoot) {
                baseSha = await resolveBaseCommitSha(
                  options.workspaceRepoRoot,
                  flow.workspace?.base ?? "main",
                  Math.min(stepTimeoutMs, 15_000),
                );
              }

              if (
                options.workspaceRepoRoot &&
                headSha &&
                baseSha &&
                FlowGitShaRegex.test(headSha) &&
                FlowGitShaRegex.test(baseSha) &&
                targetRec
              ) {
                let checkWt: WorktreeHandle | undefined;
                try {
                  let suiteRes: Awaited<ReturnType<typeof runAllowlistedCheckSuite>> = {
                    passed: true,
                    results: [],
                  };
                  if (commandCheckIds.length > 0) {
                    checkWt = await createDetachedCommitWorktree({
                      repoRoot: options.workspaceRepoRoot,
                      commitSha: headSha,
                      worktreeBaseDir,
                      label: `chk_${step.id}_${intent.occurrence}`,
                      timeoutMs: Math.min(stepTimeoutMs, 15_000),
                    });

                    suiteRes = await runAllowlistedCheckSuite({
                      checkIds: commandCheckIds,
                      cwd: checkWt.worktreePath,
                      checkCommands: options.checkCommands,
                      timeoutMs: stepTimeoutMs,
                      signal,
                    });
                  }

                  checkSignals = await extractGitDiffSignals({
                    repoRoot: options.workspaceRepoRoot,
                    baseSha,
                    headSha,
                    expectedHeadSha: options.expectedHeadSha,
                    flow,
                    checkResults: suiteRes.results,
                    timeoutMs: Math.min(stepTimeoutMs, 15_000),
                    signal,
                  });

                  if (!suiteRes.passed) {
                    defaultPassed = false;
                    primaryCheckId = suiteRes.failedCheckId ?? commandCheckIds[0] ?? "test";
                    errorClass = suiteRes.errorClass;
                  } else if (requiresRepro) {
                    if (!reproTestPath) {
                      defaultPassed = false;
                      primaryCheckId = "repro";
                      errorClass = "repro:missing_repro_test_output";
                    } else {
                      const reproRes = await runReproCheck({
                        repoRoot: options.workspaceRepoRoot,
                        worktreeBaseDir,
                        baseSha,
                        headSha,
                        reproTestPath,
                        runTestCommand: options.reproTestCommand,
                        timeoutMs: stepTimeoutMs,
                        signal,
                      });
                      defaultPassed = reproRes.passed;
                      if (!reproRes.passed) {
                        primaryCheckId = "repro";
                        errorClass = `repro:${reproRes.reason ?? "failed"}`;
                      }
                    }
                  } else {
                    defaultPassed = true;
                  }
                } finally {
                  if (checkWt) {
                    await rollbackWorktree(checkWt);
                  }
                }
              }

              let passed = defaultPassed;
              if (options.onCheckRun) {
                const checkHookRes = await options.onCheckRun({
                  step,
                  attemptId: intent.attemptId,
                  occurrence: intent.occurrence,
                  defaultPassed,
                  targetSha,
                });
                passed = checkHookRes.passed;
                errorClass = checkHookRes.errorClass ?? errorClass;
              }
              return {
                kind: "check" as const,
                primaryCheckId,
                targetSha,
                passed,
                errorClass,
                ...(checkSignals ? { signals: checkSignals } : {}),
              };
            }

            const allChecksSupported = isArtefactCheckOnly;
            const requiresNonEmpty = declaredChecks.includes("check_nonempty");
            const primaryCheckId: FlowBuiltInCheckId = !allChecksSupported
              ? "check_unsupported"
              : requiresNonEmpty
                ? "check_nonempty"
                : "check_exists";

            let defaultPassed = false;
            if (allChecksSupported && targetRec) {
              const artPath = path.join(artifactsDir, targetRec.sha256);
              const okOnDisk = verifyArtifactFileOnDisk(artPath, artifactsDir, targetRec.sha256, targetRec.sizeBytes);
              defaultPassed = okOnDisk && (!requiresNonEmpty || targetRec.sizeBytes > 0);
            }

            let passed = defaultPassed;
            let errorClass: string | undefined;
            if (options.onCheckRun) {
              const checkHookRes = await options.onCheckRun({
                step,
                attemptId: intent.attemptId,
                occurrence: intent.occurrence,
                defaultPassed,
                targetSha,
              });
              passed = checkHookRes.passed;
              errorClass = checkHookRes.errorClass;
            }
            return { kind: "check" as const, primaryCheckId, targetSha, passed, errorClass };
          }

          return { kind: "noop" as const };
        });

        if (Date.now() > deadlineMs) {
          throw new StepTimeoutError(step.id, stepTimeoutMs);
        }

        if (stepWorkOutcome.kind === "agent") {
          const hookSignals = options.evaluateSignals
            ? await options.evaluateSignals({
                step,
                attemptId: intent.attemptId,
                occurrence: intent.occurrence,
                outcome: "passed",
              })
            : {};
          const signals: StepSignals = { ...(stepWorkOutcome.signals ?? {}), ...hookSignals };

          const missingClaim = (signals.claimedOutputMissingCount ?? 0) > 0;

          if (missingClaim) {
            const failEv = store.appendEvent(
              {
                v: 1,
                runId,
                seq: intent.seq + 1,
                eventId: nextEventId("ev_fail", intent.seq + 1),
                prev: intent.hash,
                at: nowIso(),
                actor: "runner",
                type: "step_failed",
                stepId: step.id,
                attemptId: intent.attemptId,
                data: { errorCode: "execution_error" },
              },
              { deadlineMs },
            );

            const decision = evaluateStepJudgement({
              flow,
              step,
              occurrence: intent.occurrence,
              rewindsUsed: state.rewindsUsed,
              outcome: "failed",
              errorCode: "execution_error",
              budgetUsed: {
                tokens: state.budgetUsed.tokens,
                steps: state.budgetUsed.steps + 1,
              },
              signals,
            });

            if (decision.final === "continue" || decision.final === "notify") {
              const toStepId = decision.rewindTargetStepId ?? step.id;
              const tsIso = nowIso();
              store.appendChainedBatch(
                runId,
                [
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                      actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        final: decision.final,
                        ruleHits: decision.ruleHits,
                        reasonCodes: decision.reasonCodes,
                        engineTokens: 0,
                      },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_rew", seq), prev, at: tsIso,
                      actor: "runner", type: "step_rewound", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        fromStepId: step.id,
                        toStepId,
                        rewindNumber: state.rewindsUsed + 1,
                        reasonCode: decision.reasonCodes[0] ?? "claimed_output_missing",
                      },
                    },
                  }),
                ],
                { deadlineMs },
              );
              fireCrash("K_AFTER_REWIND");
              const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
              events = reloaded.events;
              state = reloaded.state;
              continue;
            }

            if (decision.final === "decide") {
              const handoffId = buildDeterministicHandoffId(runId, step.id, intent.occurrence);
              const reason = decision.reasonCodes[0] ?? "claimed_output_missing";
              const spec = getHandoffSpecForStep(flow, step, "failed", reason, nowDate());
              const tsIso = nowIso();
              const resBatch = store.appendChainedBatch(
                runId,
                [
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                      actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        final: "decide",
                        ruleHits: decision.ruleHits,
                        reasonCodes: decision.reasonCodes,
                        engineTokens: 0,
                      },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_hnd", seq), prev, at: tsIso,
                      actor: "runner", type: "handoff_sent", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        handoffId,
                        kind: spec.kind,
                        target: spec.target,
                        reasonCode: spec.reasonCode,
                        optionKeys: spec.optionKeys,
                        ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
                      },
                    },
                  }),
                ],
                { deadlineMs },
              );
              fireCrash("K_AFTER_HANDOFF_SENT");
              if (options.inbox) {
                const tail = resBatch[resBatch.length - 1]!;
                const emitRes = await emitDecisionCardToInbox({
                  target: options.inbox,
                  handoffId,
                  runId,
                  headSeq: tail.seq,
                  headHash: tail.hash,
                  stepId: step.id,
                  reasonCode: spec.reasonCode,
                  title: step.title,
                  options: spec.options,
                  nowIso: nowIso(),
                });
                if (emitRes.emitted) fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
              }
            } else {
              const tsIso = nowIso();
              store.appendChainedBatch(
                runId,
                [
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                      actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        final: "stop",
                        ruleHits: decision.ruleHits,
                        reasonCodes: decision.reasonCodes,
                        engineTokens: 0,
                      },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
                      actor: "system", type: "run_finished",
                      data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
                    },
                  }),
                ],
                { deadlineMs },
              );
              void failEv;
            }
          } else {
            const artEv = store.appendEvent(
              {
                v: 1,
                runId,
                seq: intent.seq + 1,
                eventId: nextEventId("ev_art", intent.seq + 1),
                prev: intent.hash,
                at: nowIso(),
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
                at: nowIso(),
                actor: "agent",
                type: "step_result",
                stepId: step.id,
                attemptId: intent.attemptId,
                data: {
                  outputs: stepWorkOutcome.outputs,
                  tokensUsed: stepWorkOutcome.tokensUsed,
                  wallTimeMs: Math.max(1, Date.now() - startMs),
                },
              },
              {
                privateDetail: process.env["FLOW_K5_KILL_MID_TX"] === "1" ? "stub_private_trace_k5" : undefined,
                deadlineMs,
              },
            );

            fireCrash("K4_AFTER_OUTCOME");

            if (Date.now() > deadlineMs) {
              const tsIso = nowIso();
              store.appendChainedBatch(runId, [
                (seq, prev) => ({
                  event: {
                    v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                    actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                    data: { final: "stop", ruleHits: ["step_timeout"], reasonCodes: ["timeout"], engineTokens: 0 },
                  },
                }),
                (seq, prev) => ({
                  event: {
                    v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
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

            const decision = evaluateStepJudgement({
              flow,
              step,
              occurrence: intent.occurrence,
              rewindsUsed: state.rewindsUsed,
              outcome: "passed",
              budgetUsed: {
                tokens: state.budgetUsed.tokens + stepWorkOutcome.tokensUsed,
                steps: state.budgetUsed.steps + 1,
              },
              signals,
            });

            if (
              decision.final !== "stop" &&
              !decision.shouldRewind &&
              !decision.shouldRerunCheck
            ) {
              keepWorktreeBranch = true;
            }

            if (decision.final === "stop") {
              const tsIso = nowIso();
              const finReason = decision.reasonCodes.includes("budget_exceeded")
                ? "ceiling_reached"
                : "unrecoverable_failure";
              store.appendChainedBatch(
                runId,
                [
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                      actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        final: "stop",
                        ruleHits: decision.ruleHits,
                        reasonCodes: decision.reasonCodes,
                        engineTokens: 0,
                      },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
                      actor: "system", type: "run_finished",
                      data: { outcome: "stopped", reasonCode: finReason },
                    },
                  }),
                ],
                { deadlineMs },
              );
            } else if (decision.final === "decide") {
              const handoffId = buildDeterministicHandoffId(runId, step.id, intent.occurrence);
              const reason = decision.reasonCodes[0] ?? "decision_required";
              const spec = getHandoffSpecForStep(flow, step, "passed", reason, nowDate());
              const tsIso = nowIso();
              const resBatch = store.appendChainedBatch(
                runId,
                [
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                      actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        final: "decide",
                        ruleHits: decision.ruleHits,
                        reasonCodes: decision.reasonCodes,
                        engineTokens: 0,
                      },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_hnd", seq), prev, at: tsIso,
                      actor: "runner", type: "handoff_sent", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        handoffId,
                        kind: spec.kind,
                        target: spec.target,
                        reasonCode: spec.reasonCode,
                        optionKeys: spec.optionKeys,
                        ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
                      },
                    },
                  }),
                ],
                { deadlineMs },
              );
              fireCrash("K_AFTER_HANDOFF_SENT");
              if (options.inbox) {
                const tail = resBatch[resBatch.length - 1]!;
                const emitRes = await emitDecisionCardToInbox({
                  target: options.inbox,
                  handoffId,
                  runId,
                  headSeq: tail.seq,
                  headHash: tail.hash,
                  stepId: step.id,
                  reasonCode: spec.reasonCode,
                  title: step.title,
                  options: spec.options,
                  nowIso: nowIso(),
                });
                if (emitRes.emitted) fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
              }
            } else if (decision.shouldRewind && decision.rewindTargetStepId) {
              const toStepId = decision.rewindTargetStepId;
              const tsIso = nowIso();
              const judgeReasons: FlowReasonCode[] =
                decision.final === "continue" ? ["ok"] : decision.reasonCodes;
              const batchRes = store.appendChainedBatch(
                runId,
                [
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                      actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        final: decision.final,
                        ruleHits: decision.final === "continue" ? ["step_passed"] : decision.ruleHits,
                        reasonCodes: judgeReasons,
                        engineTokens: 0,
                      },
                    },
                  }),
                  (seq, prev) => ({
                    event: {
                      v: 1, runId, seq, eventId: nextEventId("ev_rew", seq), prev, at: tsIso,
                      actor: "runner", type: "step_rewound", stepId: step.id, attemptId: intent.attemptId,
                      data: {
                        fromStepId: step.id,
                        toStepId,
                        rewindNumber: state.rewindsUsed + 1,
                        reasonCode: decision.reasonCodes[0] ?? "stale_sha",
                      },
                    },
                  }),
                ],
                { deadlineMs },
              );
              if (decision.final === "notify" && options.inbox) {
                const judgeRow = batchRes[0]!;
                const notifyReason = decision.reasonCodes[0] ?? "stale_sha";
                const actionId = buildDeterministicNotifyCardId(
                  runId,
                  step.id,
                  intent.occurrence,
                  notifyReason,
                );
                await emitNotifyCardToInbox({
                  target: options.inbox,
                  actionId,
                  runId,
                  headSeq: judgeRow.seq,
                  headHash: judgeRow.hash,
                  stepId: step.id,
                  reasonCode: notifyReason,
                  nowIso: nowIso(),
                });
              }
              fireCrash("K_AFTER_REWIND");
              const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
              events = reloaded.events;
              state = reloaded.state;
              continue;
            } else {
              const judgeEv = store.appendEvent(
                {
                  v: 1,
                  runId,
                  seq: resEv.seq + 1,
                  eventId: nextEventId("ev_judge", resEv.seq + 1),
                  prev: resEv.hash,
                  at: nowIso(),
                  actor: "system",
                  type: "judgement",
                  stepId: step.id,
                  attemptId: intent.attemptId,
                  data: {
                    final: decision.final,
                    ruleHits: decision.ruleHits,
                    reasonCodes: decision.reasonCodes,
                    engineTokens: 0,
                  },
                },
                { deadlineMs },
              );

              fireCrash("K9_AFTER_JUDGEMENT");

              if (decision.final === "notify" && options.inbox) {
                const notifyReason = decision.reasonCodes[0] ?? "ok";
                const actionId = buildDeterministicNotifyCardId(
                  runId,
                  step.id,
                  intent.occurrence,
                  notifyReason,
                );
                await emitNotifyCardToInbox({
                  target: options.inbox,
                  actionId,
                  runId,
                  headSeq: judgeEv.seq,
                  headHash: judgeEv.hash,
                  stepId: step.id,
                  reasonCode: notifyReason,
                  nowIso: nowIso(),
                });
              }

              if (Date.now() > deadlineMs) {
                store.appendEvent({
                  v: 1,
                  runId,
                  seq: judgeEv.seq + 1,
                  eventId: nextEventId("ev_fin", judgeEv.seq + 1),
                  prev: judgeEv.hash,
                  at: nowIso(),
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
            }
          }
        } else if (stepWorkOutcome.kind === "check") {
          const { primaryCheckId, targetSha, passed, errorClass } = stepWorkOutcome;

          let sameCheckFailCount = 0;
          if (!passed) {
            const classMap = checkErrorClassesByStep.get(step.id) ?? new Map<string, number>();
            checkErrorClassesByStep.set(step.id, classMap);
            if (errorClass !== undefined) {
              const prevCount = classMap.get(errorClass) ?? 0;
              sameCheckFailCount = prevCount + 1;
              classMap.set(errorClass, sameCheckFailCount);
            } else {
              const priorFails = events.filter(
                (e) => e.type === "step_failed" && e.stepId === step.id,
              ).length;
              sameCheckFailCount = priorFails + 1;
            }
          }

          const hookSignals = options.evaluateSignals
            ? await options.evaluateSignals({
                step,
                attemptId: intent.attemptId,
                occurrence: intent.occurrence,
                outcome: passed ? "passed" : "failed",
                errorCode: passed ? undefined : "check_failed",
              })
            : {};
          const signals: StepSignals = { ...(stepWorkOutcome.signals ?? {}), ...hookSignals };

          const decision = evaluateStepJudgement({
            flow,
            step,
            occurrence: intent.occurrence,
            rewindsUsed: state.rewindsUsed,
            outcome: passed ? "passed" : "failed",
            errorCode: passed ? undefined : "check_failed",
            budgetUsed: {
              tokens: state.budgetUsed.tokens,
              steps: state.budgetUsed.steps + 1,
            },
            sameCheckFailCount,
            signals,
          });

          fireCrash("K8_BEFORE_CHECK_BATCH");

          const tsIso = nowIso();
          const wallTimeMs = Math.max(1, Date.now() - startMs);
          const checkBuilders: Array<(seq: number, prev: string) => { event: FlowEvent; privateDetail?: string }> = [
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_chk", seq), prev, at: tsIso,
                actor: "runner", type: "check_result", stepId: step.id, attemptId: intent.attemptId,
                data: { checkId: primaryCheckId, targetSha, passed },
              },
            }),
          ];

          if (passed && !decision.shouldRerunCheck) {
            checkBuilders.push(
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_res", seq), prev, at: tsIso,
                  actor: "runner", type: "step_result", stepId: step.id, attemptId: intent.attemptId,
                  data: { outputs: { check: "passed" }, tokensUsed: 0, wallTimeMs },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                  actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                  data: {
                    final: decision.final,
                    ruleHits: decision.ruleHits,
                    reasonCodes: decision.reasonCodes,
                    engineTokens: 0,
                  },
                },
              }),
            );

            if (decision.final === "stop") {
              checkBuilders.push((seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
                  actor: "system", type: "run_finished",
                  data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
                },
              }));
            } else if (decision.final === "decide") {
              const handoffId = buildDeterministicHandoffId(runId, step.id, intent.occurrence);
              const reason = decision.reasonCodes[0] ?? "decision_required";
              const spec = getHandoffSpecForStep(flow, step, "passed", reason, nowDate());
              checkBuilders.push((seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_hnd", seq), prev, at: tsIso,
                  actor: "runner", type: "handoff_sent", stepId: step.id, attemptId: intent.attemptId,
                  data: {
                    handoffId,
                    kind: spec.kind,
                    target: spec.target,
                    reasonCode: spec.reasonCode,
                    optionKeys: spec.optionKeys,
                    ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
                  },
                },
              }));
            }

            const batchRes = store.appendChainedBatch(runId, checkBuilders, { deadlineMs });

            if (decision.final === "notify" && options.inbox) {
              const judgeRow = batchRes[2]!;
              const notifyReason = decision.reasonCodes[0] ?? "ok";
              const actionId = buildDeterministicNotifyCardId(runId, step.id, intent.occurrence, notifyReason);
              await emitNotifyCardToInbox({
                target: options.inbox,
                actionId,
                runId,
                headSeq: judgeRow.seq,
                headHash: judgeRow.hash,
                stepId: step.id,
                reasonCode: notifyReason,
                nowIso: nowIso(),
              });
            } else if (decision.final === "decide") {
              fireCrash("K_AFTER_HANDOFF_SENT");
              if (options.inbox) {
                const tail = batchRes[batchRes.length - 1]!;
                const handoffId = buildDeterministicHandoffId(runId, step.id, intent.occurrence);
                const reason = decision.reasonCodes[0] ?? "decision_required";
                const spec = getHandoffSpecForStep(flow, step, "passed", reason, nowDate());
                const emitRes = await emitDecisionCardToInbox({
                  target: options.inbox,
                  handoffId,
                  runId,
                  headSeq: tail.seq,
                  headHash: tail.hash,
                  stepId: step.id,
                  reasonCode: spec.reasonCode,
                  title: step.title,
                  options: spec.options,
                  nowIso: nowIso(),
                });
                if (emitRes.emitted) fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
              }
            }

            if (Date.now() > deadlineMs && decision.final !== "stop" && decision.final !== "decide") {
              const lastBatchEv = batchRes[batchRes.length - 1]!;
              store.appendEvent({
                v: 1,
                runId,
                seq: lastBatchEv.seq + 1,
                eventId: nextEventId("ev_fin", lastBatchEv.seq + 1),
                prev: lastBatchEv.hash,
                at: nowIso(),
                actor: "system",
                type: "run_finished",
                data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
              });
            }
          } else {
            // Either check failed OR staleSha requires check rerun
            checkBuilders.push(
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: tsIso,
                  actor: "runner", type: "step_failed", stepId: step.id, attemptId: intent.attemptId,
                  data: { errorCode: "check_failed" },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                  actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                  data: {
                    final: decision.final,
                    ruleHits: decision.ruleHits,
                    reasonCodes: decision.reasonCodes,
                    engineTokens: 0,
                  },
                },
              }),
            );

            if ((decision.final === "continue" || decision.final === "notify") && decision.shouldRewind && decision.rewindTargetStepId) {
              const targetId = decision.rewindTargetStepId;
              checkBuilders.push((seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_rew", seq), prev, at: tsIso,
                  actor: "runner", type: "step_rewound", stepId: step.id, attemptId: intent.attemptId,
                  data: {
                    fromStepId: step.id,
                    toStepId: targetId,
                    rewindNumber: state.rewindsUsed + 1,
                    reasonCode: decision.reasonCodes[0] ?? "on_fail_rewind",
                  },
                },
              }));
              const batchRes = store.appendChainedBatch(runId, checkBuilders, { deadlineMs });
              if (decision.final === "notify" && options.inbox) {
                const judgeRow = batchRes[2]!;
                const notifyReason = decision.reasonCodes[0] ?? "on_fail_rewind";
                const actionId = buildDeterministicNotifyCardId(runId, step.id, intent.occurrence, notifyReason);
                await emitNotifyCardToInbox({
                  target: options.inbox,
                  actionId,
                  runId,
                  headSeq: judgeRow.seq,
                  headHash: judgeRow.hash,
                  stepId: step.id,
                  reasonCode: notifyReason,
                  nowIso: nowIso(),
                });
              }
              fireCrash("K_AFTER_REWIND");
              const reloaded = loadRunState(projectId, runId, { dataRoot: options.dataRoot });
              events = reloaded.events;
              state = reloaded.state;
              continue;
            }

            if (decision.final === "decide") {
              const handoffId = buildDeterministicHandoffId(runId, step.id, intent.occurrence);
              const reason = decision.reasonCodes[0] ?? "check_failed";
              const spec = getHandoffSpecForStep(flow, step, "failed", reason, nowDate());
              checkBuilders.push((seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_hnd", seq), prev, at: tsIso,
                  actor: "runner", type: "handoff_sent", stepId: step.id, attemptId: intent.attemptId,
                  data: {
                    handoffId,
                    kind: spec.kind,
                    target: spec.target,
                    reasonCode: spec.reasonCode,
                    optionKeys: spec.optionKeys,
                    ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
                  },
                },
              }));
              const batchRes = store.appendChainedBatch(runId, checkBuilders, { deadlineMs });
              fireCrash("K_AFTER_HANDOFF_SENT");
              if (options.inbox) {
                const tail = batchRes[batchRes.length - 1]!;
                const emitRes = await emitDecisionCardToInbox({
                  target: options.inbox,
                  handoffId,
                  runId,
                  headSeq: tail.seq,
                  headHash: tail.hash,
                  stepId: step.id,
                  reasonCode: spec.reasonCode,
                  title: step.title,
                  options: spec.options,
                  nowIso: nowIso(),
                });
                if (emitRes.emitted) fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
              }
            } else {
              // Stop
              const stopFinalBuilders = checkBuilders.slice(0, 2);
              stopFinalBuilders.push(
                (seq, prev) => ({
                  event: {
                    v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                    actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                    data: {
                      final: "stop",
                      ruleHits: decision.ruleHits,
                      reasonCodes: decision.reasonCodes,
                      engineTokens: 0,
                    },
                  },
                }),
                (seq, prev) => ({
                  event: {
                    v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
                    actor: "system", type: "run_finished",
                    data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
                  },
                }),
              );
              store.appendChainedBatch(runId, stopFinalBuilders, { deadlineMs });
            }
          }
        }
      } catch (err) {
        if (err instanceof WorktreeOutcomeRejectedError || err instanceof GitDiffEvidenceError) {
          keepWorktreeBranch = false;
          const tsIso = nowIso();
          store.appendChainedBatch(runId, [
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: tsIso,
                actor: "runner", type: "step_failed", stepId: step.id, attemptId: intent.attemptId,
                data: { errorCode: "execution_error" },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                data: {
                  final: "stop",
                  ruleHits: ["step_failed_recovery"],
                  reasonCodes: ["execution_error"],
                  engineTokens: 0,
                },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
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
        if (
          err instanceof StepTimeoutError ||
          err instanceof StepDeadlineExceededError ||
          err instanceof FlowAdapterAbortedError
        ) {
          keepWorktreeBranch = false;
          const timeoutDecision = evaluateStepJudgement({
            flow,
            step,
            occurrence: intent.occurrence,
            rewindsUsed: state.rewindsUsed,
            outcome: "failed",
            errorCode: "timeout",
            budgetUsed: {
              tokens: state.budgetUsed.tokens,
              steps: state.budgetUsed.steps + 1,
            },
          });
          const tsIso = nowIso();
          if (timeoutDecision.final === "decide") {
            const handoffId = buildDeterministicHandoffId(runId, step.id, intent.occurrence);
            const spec = getHandoffSpecForStep(flow, step, "failed", "timeout", nowDate());
            const resBatch = store.appendChainedBatch(runId, [
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: tsIso,
                  actor: "runner", type: "step_failed", stepId: step.id, attemptId: intent.attemptId,
                  data: { errorCode: "timeout" },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                  actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                  data: { final: "decide", ruleHits: ["step_timeout"], reasonCodes: ["timeout"], engineTokens: 0 },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_hnd", seq), prev, at: tsIso,
                  actor: "runner", type: "handoff_sent", stepId: step.id, attemptId: intent.attemptId,
                  data: {
                    handoffId,
                    kind: spec.kind,
                    target: spec.target,
                    reasonCode: spec.reasonCode,
                    optionKeys: spec.optionKeys,
                    ...(spec.expiresAt ? { expiresAt: spec.expiresAt } : {}),
                  },
                },
              }),
            ]);
            fireCrash("K_AFTER_HANDOFF_SENT");
            if (options.inbox) {
              const tail = resBatch[resBatch.length - 1]!;
              const emitRes = await emitDecisionCardToInbox({
                target: options.inbox,
                handoffId,
                runId,
                headSeq: tail.seq,
                headHash: tail.hash,
                stepId: step.id,
                reasonCode: "timeout",
                title: step.title,
                options: spec.options,
                nowIso: nowIso(),
              });
              if (emitRes.emitted) fireCrash("K_AFTER_INBOX_CARD_WRITTEN");
            }
          } else {
            store.appendChainedBatch(runId, [
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fail", seq), prev, at: tsIso,
                  actor: "runner", type: "step_failed", stepId: step.id, attemptId: intent.attemptId,
                  data: { errorCode: "timeout" },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_judge", seq), prev, at: tsIso,
                  actor: "system", type: "judgement", stepId: step.id, attemptId: intent.attemptId,
                  data: { final: "stop", ruleHits: ["step_timeout"], reasonCodes: ["timeout"], engineTokens: 0 },
                },
              }),
              (seq, prev) => ({
                event: {
                  v: 1, runId, seq, eventId: nextEventId("ev_fin", seq), prev, at: tsIso,
                  actor: "system", type: "run_finished",
                  data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
                },
              }),
            ]);
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
        throw err;
      } finally {
        if (activeWorktree) {
          try {
            await rollbackWorktree(activeWorktree, { keepBranch: keepWorktreeBranch });
          } catch {
            // Best-effort cleanup so failed attempts never leak worktrees
          }
        }
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

      if (!state.nextStepId) {
        cursor += 1;
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
      at: nowIso(),
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
