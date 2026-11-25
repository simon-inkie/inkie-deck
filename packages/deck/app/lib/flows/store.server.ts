/**
 * store.server.ts - Local SQLite execution engine for Deck task flows (Slice 1a).
 *
 * Architectural invariants enforced in ONE authoritative place each:
 * 1. Confinement: FlowsStore is NOT exported; callers MUST open via openFlowsStore(projectId),
 *    which runs resolveProjectDataDir + checkFilesystemSafety + ensureConfinedDir BEFORE opening SQLite,
 *    and re-verifies projectDir before every artefact write/read or purge.
 * 2. Durability & Integrity: PRAGMA journal_mode = WAL and PRAGMA synchronous = FULL (2) asserted on
 *    BOTH writable and read-only opens; PRAGMA quick_check + foreign_key_check + full chain verification
 *    (canonical JSON, SQL-to-envelope binding, unfiltered seq >= 1) on every open; single-snapshot export.
 * 3. Privacy & Allowlist: ONE assertNoCallerPrivateRefs gate rejects all top-level and nested private refs;
 *    64-hex outputs must back onto a publicly recorded artefact_recorded SHA-256 still verified on disk.
 * 4. Transition Table: ONE declarative TRANSITION_TABLE enforces strict legal ordering across every event type
 *    (no overlapping attempts, no undeclared/skipped steps, check_result required before check step_result,
 *    judgement(continue) forbidden after step_failed/unknown, all declared steps passed before run_finished(done)).
 *
 * Threat Model (approved 23 Nov 2026):
 * Defends against crashes (SIGKILL / power loss), buggy callers, and accidental concurrent
 * processes of the same user (a second Deck instance or stray runner). Does NOT defend against
 * a malicious same-user process (which can already read and edit the user's data directory and
 * flows.db directly). Confinement, symlink/hardlink checks, held dirfds, and post-open inode
 * checks remain as defense-in-depth; adversarial same-user directory redirects between native
 * SQLite pathname resolution and open() are explicitly out of threat model.
 *
 * ASCII only - no em-dashes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import type { CheckStep, FlowDefinition, FlowEvent, FlowStep } from "./types.js";
import { FlowEventSchema, FlowIdRegex, FlowRunMetadataSchema, FlowSha256Regex } from "./types.js";
import {
  assertActiveOwnerLock,
  assertNoSymlinkInChain,
  assertSafeRegularFileInDirFd,
  assertSafeRegularLstatInDirFd,
  checkFilesystemSafety,
  openConfinedDirFd,
  openConfinedSubdirFd,
  precreateSafeFile0600InDirFd,
  resolveFlowsRootDir,
  resolveProjectDataDir,
  snapshotProcFds,
  verifyOpenedSqliteFileInDirFd,
  type OwnerLock,
} from "./owner.server.js";
import { resolveFlowLimits } from "./engine.js";
import { resolvePinnedBudget, resolvePinnedCheckTarget, type ResolvedCheckTarget } from "./replay.js";

// Track open SQLite connections per canonical flows.db path so we never open/close a raw fd
// on an inode while a same-process SQLite connection holds POSIX fcntl locks on it (Critical 1).
const openDbCounts = new Map<string, number>();
import { validateFlowYaml } from "./validator.js";

export interface FlowRunRow {
  run_id: string;
  flow_hash: string;
  parent_run_id: string | null;
  owner_epoch: number;
  spec_version: number;
  status: string;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

export interface FlowEventRow {
  run_id: string;
  seq: number;
  step_id: string;
  attempt_id: string;
  phase: string;
  event_type: string;
  line: string;
  hash: string;
  prev_hash: string;
  created_at: number;
}

export interface FlowArtifactRow {
  artifact_id: string;
  run_id: string;
  step_id: string;
  attempt_id: string;
  name: string;
  content_hash: string;
  media_type: string;
  size: number;
  created_at: number;
}

export interface CreateRunParams {
  runId: string;
  flowHash: string;
  flowYamlBytes: string | Buffer;
  parentRunId?: string;
  ownerEpoch?: number;
  specVersion?: number;
  metadata?: Record<string, string>;
}

export interface AppendOptions {
  privateDetail?: string;
  deadlineMs?: number;
}

export interface AppendResult {
  seq: number;
  hash: string;
  privateRef?: string;
}

export class StepDeadlineExceededError extends Error {
  constructor(public readonly runId: string, public readonly deadlineMs: number) {
    super(`Step deadline exceeded in run '${runId}' before commit (deadlineMs=${deadlineMs})`);
    this.name = "StepDeadlineExceededError";
  }
}

export class HashChainCorruptionError extends Error {
  constructor(public readonly runId: string, public readonly seq: number, message: string) {
    super(`Hash chain corruption in run '${runId}' at seq ${seq}: ${message}`);
    this.name = "HashChainCorruptionError";
  }
}

export class StorePragmaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorePragmaError";
  }
}

export class IllegalFlowTransitionError extends Error {
  constructor(public readonly runId: string, message: string) {
    super(`Illegal flow transition in run '${runId}': ${message}`);
    this.name = "IllegalFlowTransitionError";
  }
}

export class ArtifactVerificationError extends Error {
  constructor(public readonly artifactId: string, message: string) {
    super(`Artifact verification failed for '${artifactId}': ${message}`);
    this.name = "ArtifactVerificationError";
  }
}

export class PurgeIncompleteError extends Error {
  constructor(public readonly runId: string, message: string) {
    super(`Purge incomplete for run '${runId}': ${message}`);
    this.name = "PurgeIncompleteError";
  }
}

function assertValidRunId(runId: string): void {
  if (typeof runId !== "string" || !FlowIdRegex.test(runId)) {
    throw new Error(`Invalid flow runId '${String(runId)}': must match ${FlowIdRegex.source}`);
  }
}

/**
 * Deterministic canonical JSON serializer sorting object keys recursively
 * and omitting undefined properties (RFC 8259).
 */
export function canonicalJsonStringify(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return "[" + obj.map((v) => (v === undefined ? "null" : canonicalJsonStringify(v))).join(",") + "]";
  }
  const record = obj as Record<string, unknown>;
  const keys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const pairs = keys.map((k) => JSON.stringify(k) + ":" + canonicalJsonStringify(record[k]));
  return "{" + pairs.join(",") + "}";
}

/**
 * ONE gate forbidding ANY caller-supplied top-level or nested private reference.
 * Always operates on the single-pass materialized plain object before schema parsing.
 */
function assertNoCallerPrivateRefs(runId: string, plainEvent: Record<string, unknown>): void {
  if (plainEvent["privateRef"] !== undefined) {
    throw new IllegalFlowTransitionError(
      runId,
      "Caller-supplied privateRef is forbidden; pass privateDetail so the store mints a CSPRNG ref"
    );
  }
  const data = plainEvent["data"];
  if (data && typeof data === "object" && !Array.isArray(data)) {
    const dataRec = data as Record<string, unknown>;
    for (const refField of ["privateRef", "privateDetailRef", "privateErrorRef"]) {
      if (dataRec[refField] !== undefined) {
        throw new IllegalFlowTransitionError(
          runId,
          `Caller-supplied data.${refField} is forbidden; pass privateDetail so the store mints a CSPRNG ref`
        );
      }
    }
  }
}

/**
 * Single-pass plain materialization so caller getters/proxies fire AT MOST ONCE
 * before provenance checks, schema validation, and transaction entry.
 */
function materializePlain(value: unknown, depth = 0): unknown {
  if (depth > 16) {
    throw new Error("Event payload nesting depth limit exceeded");
  }
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => materializePlain(item, depth + 1));
  }
  // Minor 4 (Round 10): Null-prototype output + explicit refusal of own prototype-mutating keys
  const out: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of Object.keys(value as Record<string, unknown>)) {
    if (key === "__proto__" || key === "constructor" || key === "prototype") {
      throw new Error(`Event envelope failed schema validation: forbidden property '${key}'`);
    }
    out[key] = materializePlain((value as Record<string, unknown>)[key], depth + 1);
  }
  return out;
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else {
    for (const v of Object.values(value as Record<string, unknown>)) {
      deepFreeze(v);
    }
  }
  return value;
}

interface PreparedAppendItem {
  event: Readonly<FlowEvent>;
  privateDetail?: string;
  privateRef?: string;
}

function parseAndFreezeAppendItem(
  rawItem: { event: FlowEvent; privateDetail?: string },
  expectedRunId?: string,
): PreparedAppendItem {
  const rawEvent = rawItem.event;
  const privateDetail = rawItem.privateDetail;
  if (privateDetail !== undefined && typeof privateDetail !== "string") {
    throw new Error("privateDetail must be a string when provided");
  }
  const plain = materializePlain(rawEvent);
  if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
    throw new Error("Event envelope failed schema validation: expected object");
  }
  const plainRec = plain as Record<string, unknown>;
  const rawRunId = plainRec["runId"];
  if (typeof rawRunId !== "string" || !FlowIdRegex.test(rawRunId)) {
    throw new Error(`Invalid flow runId '${String(rawRunId)}': must match ${FlowIdRegex.source}`);
  }
  if (expectedRunId !== undefined && rawRunId !== expectedRunId) {
    throw new Error(`Batch contains mismatched runId: expected '${expectedRunId}', got '${rawRunId}'`);
  }

  assertNoCallerPrivateRefs(rawRunId, plainRec);

  // Major 2 (Round 10): Store ALWAYS generates eventId (CSPRNG) so callers cannot smuggle
  // private text into public projection exports via caller-controlled eventId strings.
  const storeEventId = `ev_${crypto.randomBytes(12).toString("hex")}`;
  let privateRef: string | undefined;
  const candidate: Record<string, unknown> = Object.assign(
    Object.create(null) as Record<string, unknown>,
    plainRec,
    { eventId: storeEventId },
  );
  if (privateDetail !== undefined) {
    privateRef = `priv_${crypto.randomBytes(16).toString("hex")}`;
    candidate["privateRef"] = privateRef;
  }

  const parseResult = FlowEventSchema.safeParse(candidate);
  if (!parseResult.success) {
    throw new Error(`Event envelope failed schema validation: ${JSON.stringify(parseResult.error.issues)}`);
  }
  const frozenEvent = deepFreeze(parseResult.data);
  return { event: frozenEvent, privateDetail, privateRef };
}

/**
 * Major 5 (Round 10): Enforce Revision 4 deterministic batching rule.
 * Solo intents and independent execution facts (e.g. artefact_recorded + agent step_result)
 * MUST commit separately; only declared deterministic/recovery batches may share a commit.
 */
const ALLOWED_MULTI_EVENT_BATCH_SHAPES = new Set([
  "check_result,step_result,judgement",
  "check_result,step_result,judgement,run_finished",
  "check_result,step_failed,judgement,run_finished",
  "step_outcome_unknown,judgement,run_finished",
  "step_failed,judgement,run_finished",
  "judgement,run_finished",
  // Slice 2 deterministic successor batches
  "check_result,step_failed,judgement",
  "check_result,step_failed,judgement,step_rewound",
  "check_result,step_failed,judgement,handoff_sent",
  "check_result,step_result,judgement,handoff_sent",
  "step_result,judgement",
  "step_result,judgement,run_finished",
  "step_result,judgement,handoff_sent",
  "step_result,judgement,step_rewound",
  "step_failed,judgement,step_rewound",
  "step_failed,judgement,handoff_sent",
  "judgement,step_rewound",
  "judgement,handoff_sent",
  "handoff_returned,step_result,judgement",
  "handoff_returned,step_result,judgement,run_finished",
  "handoff_returned,step_result,judgement,step_rewound",
  "handoff_returned,step_failed,judgement,run_finished",
  "handoff_returned,run_finished",
  "handoff_returned,step_rewound",
  "handoff_cancelled,step_failed,judgement,run_finished",
]);

function assertLegalBatchShape(runId: string, items: readonly PreparedAppendItem[]): void {
  if (items.length <= 1) return;
  const events = items.map((i) => i.event);
  if (events.some((e) => e.type === "step_started")) {
    throw new IllegalFlowTransitionError(
      runId,
      "step_started intent must be committed solo, never inside a multi-event batch"
    );
  }
  const shape = events.map((e) => e.type).join(",");
  if (!ALLOWED_MULTI_EVENT_BATCH_SHAPES.has(shape)) {
    throw new IllegalFlowTransitionError(
      runId,
      `Multi-event batch [${shape}] violates Revision 4 deterministic batching rule`
    );
  }
  const stepAttempts = new Set(
    events
      .filter((e): e is Extract<FlowEvent, { stepId: string; attemptId: string }> => "stepId" in e && "attemptId" in e)
      .map((e) => `${e.stepId}:${e.attemptId}`),
  );
  if (stepAttempts.size > 1) {
    throw new IllegalFlowTransitionError(
      runId,
      "Multi-event batch cannot span multiple steps or attempts"
    );
  }

  // Major 3 (Round 11): Enforce content-level deterministic successor constraints so callers
  // cannot smuggle arbitrary token counts, actors, outcomes, or private details into deterministic batches.
  if (events[0]!.type === "check_result") {
    if (items.some((i) => i.privateDetail !== undefined)) {
      throw new IllegalFlowTransitionError(
        runId,
        "Deterministic check batch cannot carry privateDetail"
      );
    }
    const chk = events[0]!;
    if (chk.data.passed && events[1]!.type === "step_result") {
      const res = events[1]!;
      const jdg = events[2]!;
      if (res.actor !== "runner" || res.data.tokensUsed !== 0) {
        throw new IllegalFlowTransitionError(
          runId,
          "Passing check batch requires runner step_result with tokensUsed === 0"
        );
      }
      // Major 2 (Round 12): Passing check step_result outputs MUST be consistent with a pass (no contradictory 'failed'/'false').
      for (const [outKey, outVal] of Object.entries(res.data.outputs)) {
        if (outVal !== "ok" && outVal !== "passed" && outVal !== "true" && outVal !== "pass" && outVal !== chk.data.targetSha) {
          throw new IllegalFlowTransitionError(
            runId,
            `Passing check batch step_result output '${outKey}=${outVal}' contradicts passing check_result`
          );
        }
      }
      if (
        jdg.type !== "judgement" ||
        jdg.actor !== "system" ||
        jdg.data.engineTokens !== 0
      ) {
        throw new IllegalFlowTransitionError(
          runId,
          "Passing check batch requires system judgement with engineTokens === 0"
        );
      }
      if (events.length === 3) {
        if (jdg.data.final === "continue") {
          if (
            jdg.data.ruleHits.length === 0 ||
            !jdg.data.ruleHits.every((h) => h === "check_passed" || h === "step_passed") ||
            jdg.data.reasonCodes.length === 0 ||
            !jdg.data.reasonCodes.every((c) => c === "ok")
          ) {
            throw new IllegalFlowTransitionError(
              runId,
              "Passing check batch requires system judgement(continue) with engineTokens === 0, passing ruleHits, and reasonCodes ['ok']"
            );
          }
        } else if (jdg.data.final !== "notify") {
          throw new IllegalFlowTransitionError(
            runId,
            "Passing 3-event check batch requires system judgement(continue | notify)"
          );
        }
      } else if (events.length === 4) {
        const tail = events[3]!;
        if (tail.type === "run_finished") {
          if (jdg.data.final === "continue") {
            if (
              jdg.data.ruleHits.length === 0 ||
              !jdg.data.ruleHits.every((h) => h === "check_passed" || h === "step_passed") ||
              jdg.data.reasonCodes.length === 0 ||
              !jdg.data.reasonCodes.every((c) => c === "ok") ||
              tail.actor !== "system" ||
              tail.data.outcome !== "done" ||
              tail.data.reasonCode !== "completed"
            ) {
              throw new IllegalFlowTransitionError(
                runId,
                "Passing check 4-event batch requires system run_finished(done, completed)"
              );
            }
          } else if (jdg.data.final === "stop") {
            if (tail.actor !== "system" || tail.data.outcome !== "stopped") {
              throw new IllegalFlowTransitionError(
                runId,
                "Stop check 4-event batch requires system run_finished(stopped)"
              );
            }
          } else {
            throw new IllegalFlowTransitionError(
              runId,
              "Passing check 4-event batch ending in run_finished requires judgement(continue | stop)"
            );
          }
        } else if (tail.type === "handoff_sent") {
          if (jdg.data.final !== "decide") {
            throw new IllegalFlowTransitionError(
              runId,
              "Check batch ending in handoff_sent requires judgement(decide)"
            );
          }
        }
      }
    } else if (chk.data.passed && events[1]!.type === "step_failed") {
      // Scenario 17: stale_sha check rerun batch (check_result(passed:true), step_failed, judgement(continue), step_rewound)
      const fail = events[1]!;
      const jdg = events[2]!;
      const rew = events[3]!;
      if (fail.actor !== "runner" || fail.data.errorCode !== "check_failed") {
        throw new IllegalFlowTransitionError(
          runId,
          "Stale check batch requires runner step_failed(check_failed)"
        );
      }
      if (
        jdg.type !== "judgement" ||
        jdg.actor !== "system" ||
        jdg.data.engineTokens !== 0 ||
        (jdg.data.final !== "continue" && jdg.data.final !== "notify")
      ) {
        throw new IllegalFlowTransitionError(
          runId,
          "Stale check batch requires system judgement(continue | notify) with engineTokens === 0"
        );
      }
      if (rew.type !== "step_rewound") {
        throw new IllegalFlowTransitionError(runId, "Stale check batch must end with step_rewound");
      }
    } else {
      const fail = events[1]!;
      const jdg = events[2]!;
      if (fail.type !== "step_failed" || fail.actor !== "runner" || fail.data.errorCode !== "check_failed") {
        throw new IllegalFlowTransitionError(
          runId,
          "Failing check batch requires runner step_failed(check_failed)"
        );
      }
      if (jdg.type !== "judgement" || jdg.actor !== "system" || jdg.data.engineTokens !== 0) {
        throw new IllegalFlowTransitionError(
          runId,
          "Failing check batch requires system judgement with engineTokens === 0"
        );
      }
      if (events.length === 4) {
        const tail = events[3]!;
        if (tail.type === "run_finished") {
          if (
            jdg.data.final !== "stop" ||
            tail.actor !== "system" ||
            tail.data.outcome !== "stopped"
          ) {
            throw new IllegalFlowTransitionError(
              runId,
              "Failing check batch requires system judgement(stop) and system run_finished(stopped)"
            );
          }
        } else if (tail.type === "step_rewound") {
          if (jdg.data.final !== "continue" && jdg.data.final !== "notify") {
            throw new IllegalFlowTransitionError(
              runId,
              "Failing check rewind batch requires system judgement(continue | notify)"
            );
          }
        } else if (tail.type === "handoff_sent") {
          if (jdg.data.final !== "decide") {
            throw new IllegalFlowTransitionError(
              runId,
              "Failing check handoff batch requires system judgement(decide)"
            );
          }
        }
      }
    }
  } else {
    // Recovery / timeout / handoff-followup batches: deterministic successors at idx >= 1
    // must carry zero privateDetail, and judgement / run_finished must be system-authored.
    if (events[0]!.type === "step_result") {
      if (events[0]!.actor !== "runner" || events[0]!.data.tokensUsed !== 0) {
        throw new IllegalFlowTransitionError(
          runId,
          "Handoff/decision follow-up batch requires runner step_result with tokensUsed === 0"
        );
      }
    }
    const isHandoffBatch = events[0]!.type === "handoff_returned";
    for (let idx = 1; idx < items.length; idx++) {
      if (items[idx]!.privateDetail !== undefined) {
        throw new IllegalFlowTransitionError(
          runId,
          "Deterministic successor event in batch cannot carry privateDetail"
        );
      }
      const ev = items[idx]!.event;
      if (ev.type === "judgement") {
        if (ev.actor !== "system" || ev.data.engineTokens !== 0) {
          throw new IllegalFlowTransitionError(
            runId,
            "Deterministic batch requires system judgement with engineTokens === 0"
          );
        }
        if (
          !isHandoffBatch &&
          (events[0]!.type === "step_outcome_unknown" ||
            (events[0]!.type === "step_failed" && !events.some((e) => e.type === "step_rewound" || e.type === "handoff_sent"))) &&
          ev.data.final !== "stop"
        ) {
          throw new IllegalFlowTransitionError(
            runId,
            "Recovery/stop batch requires system judgement(stop) with engineTokens === 0"
          );
        }
      } else if (ev.type === "run_finished") {
        if (ev.actor !== "system") {
          throw new IllegalFlowTransitionError(
            runId,
            "Batch run_finished must be system-authored"
          );
        }
        if (!isHandoffBatch && events[0]!.type !== "step_result" && ev.data.outcome !== "stopped") {
          throw new IllegalFlowTransitionError(
            runId,
            "Recovery/stop batch requires system run_finished(stopped)"
          );
        }
      }
    }
  }
}

/**
 * Derive a deterministic attemptId that ALWAYS fits within the 64-character FlowIdRegex limit.
 */
export function buildBoundedAttemptId(stepId: string, occurrence: number): string {
  const shortHash = crypto.createHash("sha256").update(`${stepId}:${occurrence}`).digest("hex").slice(0, 12);
  return `att_${shortHash}_${occurrence}`;
}

/**
 * Major 4: Derive a deterministic hash-based effectKey bound strictly to (runId, stepId, occurrence)
 * so callers cannot smuggle private text into public step_started.data.effectKey.
 */
export function buildDeterministicEffectKey(runId: string, stepId: string, occurrence: number): string {
  const digest = crypto
    .createHash("sha256")
    .update(JSON.stringify(["deck-flow-effect-key-v1", runId, stepId, occurrence]))
    .digest("hex")
    .slice(0, 24);
  return `eff_${digest}`;
}

interface TransitionContext {
  runId: string;
  run: FlowRunRow;
  pinnedFlow: FlowDefinition;
  stepById: Map<string, FlowStep>;
  stepIndexById: Map<string, number>;
  nextSeq: number;
  hasPlanned: boolean;
  hasApproved: boolean;
  hasStarted: boolean;
  hasRunFinished: boolean;
  hasStopJudgement: boolean;
  hasPendingDecide: boolean;
  hasPendingUnknown: boolean;
  rewindsUsed: number;
  expectedNextStepId: string | null;
  openHandoff: {
    handoffId: string;
    stepId: string;
    attemptId: string;
    kind: "decision" | "handoff";
    optionKeys: string[];
    alwaysDecide: boolean;
    target: string;
  } | null;
  closedHandoffIds: Set<string>;
  returnedHandoffByAttempt: Map<
    string,
    { handoffId: string; choiceKey: string; resolution: "answered" | "dismissed" | "expired" }
  >;
  unknownAttempts: Set<string>;
  pendingDecideAttemptKey: string | null;
  terminalDecisionEnd: { outcome: "done" | "stopped" | "dropped"; stepId: string; choiceKey: string } | null;
  seenOccurrences: Set<string>;
  startedAttempts: Set<string>;
  settledAttempts: Set<string>;
  succeededAttempts: Set<string>;
  failedAttempts: Set<string>;
  checkedAttempts: Set<string>;
  passedCheckAttempts: Set<string>;
  judgedAttempts: Set<string>;
  passedStepIds: Set<string>;
  passedCheckProvenanceByStep: Map<
    string,
    { producerStepId: string; producerAttemptId: string; producerOccurrence: number; targetSha: string }
  >;
  passedCheckProvenanceByAttempt: Map<
    string,
    { producerStepId: string; producerAttemptId: string; producerOccurrence: number; targetSha: string }
  >;
  publicRecordedArtefactShas: Set<string>;
  events: FlowEvent[];
  budgetStepsRemaining: number | null;
  budgetTokensRemaining: number | null;
  hasActiveUnsettledAttempt: () => boolean;
  hasUnjudgedSettledAttempt: () => boolean;
  resolveExpectedCheckTarget: (step: CheckStep) => ResolvedCheckTarget | undefined;
  verifyArtefactReceiptAndDisk: (
    artifactId: string,
    stepId: string,
    attemptId: string,
    sha256: string,
    sizeBytes: number,
  ) => void;
  verifyPublicArtefactShaOnDisk: (sha256: string, requireNonEmpty?: boolean) => void;
}

const COMMAND_CHECK_IDS = new Set(["typecheck", "test", "lint", "leak_scan", "build", "repro"]);

const REWIND_ELIGIBLE_REASON_CODES = new Set([
  "check_failed",
  "on_fail_rewind",
  "on_return_rewind",
  "claimed_output_missing",
  "stale_sha",
  "retry",
  "merge_conflict",
  "flaky_suspected",
  "review_comment",
]);

type TransitionRule<T extends FlowEvent["type"] = FlowEvent["type"]> = (
  ctx: TransitionContext,
  event: Extract<FlowEvent, { type: T }>,
) => void;

/**
 * ONE declarative transition table consulted by appendItemsInOpenTx for EVERY event type.
 */
const TRANSITION_TABLE: { [K in FlowEvent["type"]]: TransitionRule<K> } = {
  run_planned(ctx, ev) {
    if (ctx.nextSeq !== 1) {
      throw new IllegalFlowTransitionError(ctx.runId, "run_planned is only legal at seq 1");
    }
    if (ev.data.flowHash !== ctx.run.flow_hash) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `run_planned flowHash '${ev.data.flowHash}' disagrees with pinned flow_hash '${ctx.run.flow_hash}'`
      );
    }
    if (ev.data.flowRef !== ctx.pinnedFlow.flow) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `run_planned flowRef '${ev.data.flowRef}' disagrees with pinned flow '${ctx.pinnedFlow.flow}'`
      );
    }
  },

  flow_approved(ctx, ev) {
    if (!ctx.hasPlanned || ctx.hasApproved) {
      throw new IllegalFlowTransitionError(ctx.runId, "flow_approved requires run_planned and cannot be repeated");
    }
    if (ev.data.flowHash !== ctx.run.flow_hash) {
      throw new IllegalFlowTransitionError(ctx.runId, "flow_approved flowHash does not match pinned flow_hash");
    }
  },

  run_started(ctx, ev) {
    if (!ctx.hasApproved) {
      throw new IllegalFlowTransitionError(ctx.runId, "run_started requires flow_approved first");
    }
    if (ctx.hasStarted) {
      throw new IllegalFlowTransitionError(ctx.runId, "run_started cannot be repeated once the run has started");
    }
    // Major 3: Budget MUST match the pinned approved flow definition exactly (never caller-substituted)
    const pinnedBudget = resolvePinnedBudget(ctx.pinnedFlow);
    if (ev.data.budget.tokens !== pinnedBudget.tokens || ev.data.budget.steps !== pinnedBudget.steps) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `run_started budget (${ev.data.budget.tokens} tokens, ${ev.data.budget.steps} steps) disagrees with pinned flow budget (${pinnedBudget.tokens} tokens, ${pinnedBudget.steps} steps)`
      );
    }
    const declaredInputs = ctx.pinnedFlow.inputs ?? {};
    for (const inputKey of Object.keys(ev.data.inputIds)) {
      if (!Object.hasOwn(declaredInputs, inputKey)) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `run_started inputIds contains undeclared input key '${inputKey}'`
        );
      }
    }
  },

  step_started(ctx, ev) {
    if (!ctx.hasStarted) {
      throw new IllegalFlowTransitionError(ctx.runId, "step_started requires run_started first");
    }
    if (ctx.hasPendingDecide || ctx.hasPendingUnknown || ctx.openHandoff !== null) {
      throw new IllegalFlowTransitionError(ctx.runId, "step_started forbidden while waiting on decision or unknown outcome");
    }
    if (ctx.hasActiveUnsettledAttempt() || ctx.hasUnjudgedSettledAttempt()) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        "step_started forbidden while an earlier attempt is unsettled or awaiting judgement"
      );
    }
    // Major 5: Enforce step/token budget ceilings in append table so append and replay agree
    if (ctx.budgetStepsRemaining !== null && ctx.budgetStepsRemaining <= 0) {
      throw new IllegalFlowTransitionError(ctx.runId, "step_started forbidden: step budget ceiling reached");
    }
    if (ctx.budgetTokensRemaining !== null && ctx.budgetTokensRemaining < 0) {
      throw new IllegalFlowTransitionError(ctx.runId, "step_started forbidden: token budget ceiling exceeded");
    }
    const stepIdx = ctx.stepIndexById.get(ev.stepId);
    if (stepIdx === undefined) {
      throw new IllegalFlowTransitionError(ctx.runId, `step_started references undeclared step '${ev.stepId}'`);
    }
    if (ctx.expectedNextStepId !== null) {
      if (ev.stepId !== ctx.expectedNextStepId) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `step_started expected rewound step '${ctx.expectedNextStepId}', got '${ev.stepId}'`
        );
      }
    } else if (stepIdx > 0) {
      const prevStep = ctx.pinnedFlow.steps[stepIdx - 1]!;
      if (!ctx.passedStepIds.has(prevStep.id)) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `step_started '${ev.stepId}' forbidden before predecessor step '${prevStep.id}' passed`
        );
      }
    }
    const occKey = `${ev.stepId}:${ev.data.occurrence}`;
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (ctx.seenOccurrences.has(occKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Duplicate step occurrence for '${ev.stepId}' occurrence ${ev.data.occurrence}`
      );
    }
    if (ctx.startedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Duplicate attemptId '${ev.attemptId}' for step '${ev.stepId}'`
      );
    }
    // Major 4 (Round 12): Bind step_started.attemptId strictly to deterministic buildBoundedAttemptId
    // so direct step_started appends cannot smuggle caller-controlled private text into attemptId.
    const expectedAttemptId = buildBoundedAttemptId(ev.stepId, ev.data.occurrence);
    if (ev.attemptId !== expectedAttemptId) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_started attemptId '${ev.attemptId}' must match deterministic attemptId '${expectedAttemptId}'`
      );
    }
    const expectedEffectKey = buildDeterministicEffectKey(ctx.runId, ev.stepId, ev.data.occurrence);
    if (ev.data.effectKey !== expectedEffectKey) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_started effectKey '${ev.data.effectKey}' must match deterministic key '${expectedEffectKey}'`
      );
    }
  },

  artefact_recorded(ctx, ev) {
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.startedAttempts.has(attKey) || ctx.settledAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `artefact_recorded requires active started attempt '${attKey}'`);
    }
    ctx.verifyArtefactReceiptAndDisk(
      ev.data.artefactId,
      ev.stepId,
      ev.attemptId,
      ev.data.sha256,
      ev.data.sizeBytes,
    );
  },

  check_result(ctx, ev) {
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.startedAttempts.has(attKey) || ctx.settledAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `check_result requires active started attempt '${attKey}'`);
    }
    const step = ctx.stepById.get(ev.stepId);
    if (!step || step.type !== "check") {
      throw new IllegalFlowTransitionError(ctx.runId, `check_result is only legal for check steps (got '${ev.stepId}')`);
    }
    if (ctx.checkedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `Attempt '${attKey}' already has a recorded check_result`);
    }

    // Critical 2: Enforce the exact pinned check contract (declared run + against target) AND forbid
    // unrecorded 64-hex secrets in targetSha on BOTH passed and failed check results.
    const declaredChecks =
      step.run && step.run.length > 0
        ? step.run
        : step.repro
          ? ["repro"]
          : ["check_nonempty"];
    const isArtefactOnly =
      declaredChecks.every((n) => n === "check_exists" || n === "check_nonempty") && !step.repro;
    const isCommandSuite =
      !isArtefactOnly && declaredChecks.every((n) => COMMAND_CHECK_IDS.has(n));
    const requiresNonEmpty = isArtefactOnly && declaredChecks.includes("check_nonempty");

    if (isArtefactOnly) {
      const expectedCheckId = requiresNonEmpty ? "check_nonempty" : "check_exists";
      if (ev.data.checkId !== expectedCheckId) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `check_result checkId '${ev.data.checkId}' disagrees with pinned check requirement '${expectedCheckId}'`
        );
      }
    } else if (isCommandSuite) {
      const allowedCheckIds = new Set(declaredChecks);
      if (step.repro) {
        allowedCheckIds.add("repro");
      }
      if (!allowedCheckIds.has(ev.data.checkId)) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `check_result checkId '${ev.data.checkId}' is not in pinned command checks [${Array.from(allowedCheckIds).join(", ")}]`
        );
      }
    } else if (ev.data.checkId !== "check_unsupported") {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `check_result checkId '${ev.data.checkId}' disagrees with pinned check requirement 'check_unsupported'`
      );
    }

    const zeroSha = "0".repeat(64);
    if (ev.data.targetSha !== zeroSha && !ctx.publicRecordedArtefactShas.has(ev.data.targetSha)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `check_result targetSha '${ev.data.targetSha}' must be 64 zeros or a publicly recorded artefact_recorded SHA-256`
      );
    }

    const expectedTarget = ctx.resolveExpectedCheckTarget(step);
    const expectedTargetSha = expectedTarget?.sha256;
    if (expectedTargetSha === undefined) {
      if (ev.data.passed) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          "Passing check_result forbidden when no pinned against target exists"
        );
      }
      if (ev.data.targetSha !== zeroSha) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `Failed check_result targetSha '${ev.data.targetSha}' must be 64 zeros when no pinned against target exists`
        );
      }
    } else {
      if (ev.data.targetSha !== expectedTargetSha) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `check_result targetSha '${ev.data.targetSha}' does not match pinned against target '${expectedTargetSha}'`
        );
      }
      if (ev.data.passed) {
        if (!isArtefactOnly && !isCommandSuite) {
          throw new IllegalFlowTransitionError(ctx.runId, "check_unsupported cannot record passed: true");
        }
        ctx.verifyPublicArtefactShaOnDisk(ev.data.targetSha, requiresNonEmpty);
      } else if (isArtefactOnly) {
        // Critical 1: Reject forged passed: false when the pinned target actually exists and passes on disk
        let targetPassesOnDisk = false;
        try {
          ctx.verifyPublicArtefactShaOnDisk(expectedTargetSha, requiresNonEmpty);
          targetPassesOnDisk = true;
        } catch {
          targetPassesOnDisk = false;
        }
        if (targetPassesOnDisk) {
          const expectedCheckId = requiresNonEmpty ? "check_nonempty" : "check_exists";
          throw new IllegalFlowTransitionError(
            ctx.runId,
            `Cannot record check_result passed: false when pinned target '${expectedTargetSha}' passes '${expectedCheckId}' on disk`
          );
        }
      }
    }
  },

  step_result(ctx, ev) {
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.startedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `Cannot record 'step_result' for unstarted attempt '${attKey}'`);
    }
    if (ctx.settledAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Attempt '${ev.attemptId}' of step '${ev.stepId}' already has a recorded outcome`
      );
    }
    // Major 3: Enforce token budget ceiling on append so append and replay never disagree on exhaustion
    if (ctx.budgetTokensRemaining !== null && ev.data.tokensUsed > ctx.budgetTokensRemaining) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_result tokensUsed (${ev.data.tokensUsed}) exceeds remaining token budget (${ctx.budgetTokensRemaining})`
      );
    }
    const step = ctx.stepById.get(ev.stepId);
    if (step?.type === "decision" || step?.type === "handoff") {
      if (!ctx.returnedHandoffByAttempt.has(attKey)) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `${step.type} step '${ev.stepId}' cannot record step_result before handoff_returned`
        );
      }
    }
    if (step?.type === "check") {
      if (!ctx.passedCheckAttempts.has(attKey)) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `Check step '${ev.stepId}' cannot record step_result without a prior passing check_result`
        );
      }
      // Major 3 (Round 11) & Major 2 (Round 12): Deterministic check steps MUST be runner-authored
      // with 0 tokensUsed and non-contradictory passing outputs.
      if (ev.actor !== "runner" || ev.data.tokensUsed !== 0) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `Check step '${ev.stepId}' step_result requires actor 'runner' and tokensUsed === 0`
        );
      }
      const recordedCheck = ctx.passedCheckProvenanceByStep.get(ev.stepId);
      for (const [outKey, outVal] of Object.entries(ev.data.outputs)) {
        if (outVal !== "ok" && outVal !== "passed" && outVal !== "true" && outVal !== "pass" && outVal !== recordedCheck?.targetSha) {
          throw new IllegalFlowTransitionError(
            ctx.runId,
            `Check step '${ev.stepId}' step_result output '${outKey}=${outVal}' contradicts passing check_result`
          );
        }
      }
    }
    // Any 64-hex output value MUST match a publicly recorded artefact_recorded SHA-256 still verified on disk
    for (const [outKey, outVal] of Object.entries(ev.data.outputs)) {
      if (typeof outVal === "string" && FlowSha256Regex.test(outVal)) {
        if (!ctx.publicRecordedArtefactShas.has(outVal)) {
          throw new IllegalFlowTransitionError(
            ctx.runId,
            `step_result output '${outKey}' carries 64-hex digest without a public artefact_recorded event`
          );
        }
        ctx.verifyPublicArtefactShaOnDisk(outVal);
      }
    }
  },

  step_failed(ctx, ev) {
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.startedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `Cannot record 'step_failed' for unstarted attempt '${attKey}'`);
    }
    if (ctx.settledAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Attempt '${ev.attemptId}' of step '${ev.stepId}' already has a recorded outcome`
      );
    }
  },

  step_outcome_unknown(ctx, ev) {
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.startedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Cannot record 'step_outcome_unknown' for unstarted attempt '${attKey}'`
      );
    }
    if (ctx.settledAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Attempt '${ev.attemptId}' of step '${ev.stepId}' already has a recorded outcome`
      );
    }
  },

  judgement(ctx, ev) {
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.settledAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `judgement requires a recorded outcome for attempt '${attKey}'`);
    }
    if (ctx.judgedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `Attempt '${attKey}' already has a judgement`);
    }
    if (ev.data.final === "continue") {
      if (ctx.unknownAttempts.has(attKey)) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `judgement(continue) forbidden for failed or unknown attempt '${attKey}'`
        );
      }
      if (!ctx.succeededAttempts.has(attKey)) {
        const limits = resolveFlowLimits(ctx.pinnedFlow);
        const hasValidRewindReason =
          ev.data.reasonCodes.length > 0 &&
          !ev.data.reasonCodes.includes("ok") &&
          ev.data.reasonCodes.every((c) => REWIND_ELIGIBLE_REASON_CODES.has(c));
        if (!hasValidRewindReason || ctx.rewindsUsed >= limits.maxRewinds) {
          throw new IllegalFlowTransitionError(
            ctx.runId,
            `judgement(continue) forbidden for failed or unknown attempt '${attKey}'`
          );
        }
      } else if (ev.data.reasonCodes.length === 0 || !ev.data.reasonCodes.every((c) => c === "ok")) {
        // Major 2 (Round 12): judgement(continue) on a succeeded attempt cannot carry contradictory failure reasonCodes.
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `judgement(continue) requires reasonCodes ['ok'], got ${JSON.stringify(ev.data.reasonCodes)}`
        );
      }
    }
  },

  handoff_sent(ctx, ev) {
    if (!ctx.hasStarted || ctx.hasRunFinished || ctx.hasStopJudgement) {
      throw new IllegalFlowTransitionError(ctx.runId, "handoff_sent requires an active non-terminal run");
    }
    if (ctx.openHandoff !== null) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Cannot open handoff '${ev.data.handoffId}' while '${ctx.openHandoff.handoffId}' is still open`
      );
    }
    if (ctx.closedHandoffIds.has(ev.data.handoffId)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `Cannot reuse closed handoffId '${ev.data.handoffId}'`
      );
    }
    const step = ctx.stepById.get(ev.stepId);
    if (!step) {
      throw new IllegalFlowTransitionError(ctx.runId, `handoff_sent references undeclared step '${ev.stepId}'`);
    }
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.startedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(ctx.runId, `handoff_sent requires started attempt '${attKey}'`);
    }
    if (step.type === "decision" || step.type === "handoff") {
      if (ctx.settledAttempts.has(attKey) || ctx.returnedHandoffByAttempt.has(attKey)) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `handoff_sent on ${step.type} step '${ev.stepId}' must precede handoff_returned and settlement`
        );
      }
      if (step.type === "decision" && step.always === "decide" && ev.data.alwaysDecide !== true) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `Decision step '${ev.stepId}' with always: decide must set alwaysDecide: true`
        );
      }
    } else {
      if (!ctx.judgedAttempts.has(attKey) || !ctx.hasPendingDecide || ctx.pendingDecideAttemptKey !== attKey) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `handoff_sent on ${step.type} step '${ev.stepId}' requires pending judgement(decide) on attempt '${attKey}'`
        );
      }
    }
  },

  handoff_returned(ctx, ev) {
    if (ctx.openHandoff === null) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `handoff_returned '${ev.data.handoffId}' rejected: no open handoff`
      );
    }
    if (ev.data.handoffId !== ctx.openHandoff.handoffId) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `handoff_returned '${ev.data.handoffId}' does not match open handoff '${ctx.openHandoff.handoffId}'`
      );
    }
    if (ev.stepId !== ctx.openHandoff.stepId || ev.attemptId !== ctx.openHandoff.attemptId) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `handoff_returned step/attempt '${ev.stepId}:${ev.attemptId}' mismatches open handoff '${ctx.openHandoff.stepId}:${ctx.openHandoff.attemptId}'`
      );
    }
    if (ctx.openHandoff.alwaysDecide) {
      if (
        (ev.data.resolution === "answered" || ev.data.resolution === "dismissed") &&
        ev.actor !== "human"
      ) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `handoff_returned (${ev.data.resolution}) on always: decide handoff '${ev.data.handoffId}' requires actor 'human'`
        );
      }
      if (ev.data.resolution === "expired" && ev.actor === "agent") {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          `handoff_returned (expired) on always: decide handoff '${ev.data.handoffId}' forbids actor 'agent'`
        );
      }
    }
    if (ev.data.resolution === "answered" && !ctx.openHandoff.optionKeys.includes(ev.data.choiceKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `handoff_returned choiceKey '${ev.data.choiceKey}' is not in optionKeys [${ctx.openHandoff.optionKeys.join(", ")}]`
      );
    }
  },

  handoff_cancelled(ctx, ev) {
    if (ctx.openHandoff === null || ev.data.handoffId !== ctx.openHandoff.handoffId) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `handoff_cancelled '${ev.data.handoffId}' requires matching open handoff`
      );
    }
    if (ev.stepId !== ctx.openHandoff.stepId || ev.attemptId !== ctx.openHandoff.attemptId) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `handoff_cancelled step/attempt mismatches open handoff`
      );
    }
  },

  return_rejected(ctx, ev) {
    if (!ctx.hasStarted || ctx.hasRunFinished || ctx.hasStopJudgement) {
      throw new IllegalFlowTransitionError(ctx.runId, "return_rejected requires an active non-terminal run");
    }
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.startedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `return_rejected requires started attempt '${attKey}'`
      );
    }
  },

  step_rewound(ctx, ev) {
    if (!ctx.hasStarted || ctx.hasRunFinished || ctx.hasStopJudgement) {
      throw new IllegalFlowTransitionError(ctx.runId, "step_rewound requires an active non-terminal run");
    }
    if (ctx.openHandoff !== null) {
      throw new IllegalFlowTransitionError(ctx.runId, "step_rewound forbidden while a handoff is still open");
    }
    if (ev.data.fromStepId !== ev.stepId) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_rewound fromStepId '${ev.data.fromStepId}' must match envelope stepId '${ev.stepId}'`
      );
    }
    const attKey = `${ev.stepId}:${ev.attemptId}`;
    if (!ctx.judgedAttempts.has(attKey)) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_rewound requires judged attempt '${attKey}'`
      );
    }
    const fromIdx = ctx.stepIndexById.get(ev.data.fromStepId);
    const toIdx = ctx.stepIndexById.get(ev.data.toStepId);
    if (fromIdx === undefined || toIdx === undefined) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_rewound references unknown step '${ev.data.fromStepId}' -> '${ev.data.toStepId}'`
      );
    }
    if (toIdx > fromIdx) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_rewound can only target same or earlier step (got '${ev.data.fromStepId}' -> '${ev.data.toStepId}')`
      );
    }
    const expectedRewindNumber = ctx.rewindsUsed + 1;
    if (ev.data.rewindNumber !== expectedRewindNumber) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_rewound rewindNumber must be contiguous (${expectedRewindNumber}, got ${ev.data.rewindNumber})`
      );
    }
    const maxRewinds = resolveFlowLimits(ctx.pinnedFlow).maxRewinds;
    if (ev.data.rewindNumber > maxRewinds) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `step_rewound rewindNumber (${ev.data.rewindNumber}) exceeds max_rewinds (${maxRewinds})`
      );
    }
  },

  run_finished(ctx, ev) {
    if (ctx.hasActiveUnsettledAttempt() || ctx.hasUnjudgedSettledAttempt()) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `run_finished(${ev.data.outcome}) forbidden while an attempt is unsettled or awaiting judgement`
      );
    }
    if (ctx.openHandoff !== null) {
      throw new IllegalFlowTransitionError(
        ctx.runId,
        `run_finished(${ev.data.outcome}) forbidden while a handoff is still open (${ctx.openHandoff.handoffId})`
      );
    }
    if (ev.data.outcome === "done") {
      if (
        !ctx.hasStarted ||
        ctx.hasStopJudgement ||
        ctx.hasPendingDecide ||
        ctx.hasPendingUnknown ||
        (ctx.budgetTokensRemaining !== null && ctx.budgetTokensRemaining < 0)
      ) {
        throw new IllegalFlowTransitionError(
          ctx.runId,
          "run_finished(done) requires run_started, within budget, no stop judgement, and no pending decisions"
        );
      }
      const decisionEndIdx =
        ctx.terminalDecisionEnd?.outcome === "done"
          ? ctx.stepIndexById.get(ctx.terminalDecisionEnd.stepId)
          : undefined;
      const requiredMaxIdx =
        decisionEndIdx !== undefined ? decisionEndIdx : ctx.pinnedFlow.steps.length - 1;

      for (let i = 0; i <= requiredMaxIdx; i++) {
        const declaredStep = ctx.pinnedFlow.steps[i]!;
        if (!ctx.passedStepIds.has(declaredStep.id)) {
          throw new IllegalFlowTransitionError(
            ctx.runId,
            `run_finished(done) forbidden: declared step '${declaredStep.id}' has not completed with passing step_result + judgement(continue)`
          );
        }
        // Major 4 (Round 11): Every check step must have passed against its exact producer step,
        // producer occurrence/attempt, and target SHA (never rebound to a later downstream step).
        if (declaredStep.type === "check") {
          const expected = ctx.resolveExpectedCheckTarget(declaredStep);
          const recorded = ctx.passedCheckProvenanceByStep.get(declaredStep.id);
          if (
            !expected ||
            !recorded ||
            recorded.producerStepId !== expected.stepId ||
            recorded.producerAttemptId !== expected.attemptId ||
            recorded.producerOccurrence !== expected.occurrence ||
            recorded.targetSha !== expected.sha256
          ) {
            throw new IllegalFlowTransitionError(
              ctx.runId,
              `run_finished(done) forbidden: check step '${declaredStep.id}' has not verified current target '${expected?.sha256 ?? "none"}'`
            );
          }
        }
      }
    }
  },

  // Major 7: Reserved events are defined in the schema for later slices and explicitly rejected in Slice 1a
  run_released(ctx) {
    throw new IllegalFlowTransitionError(ctx.runId, "run_released is reserved for a later slice and not accepted in Slice 1a");
  },

  run_claimed(ctx) {
    throw new IllegalFlowTransitionError(ctx.runId, "run_claimed is reserved for a later slice and not accepted in Slice 1a");
  },

  child_started(ctx) {
    throw new IllegalFlowTransitionError(ctx.runId, "child_started is reserved for a later slice and not accepted in Slice 1a");
  },

  child_finished(ctx) {
    throw new IllegalFlowTransitionError(ctx.runId, "child_finished is reserved for a later slice and not accepted in Slice 1a");
  },

  operator_input(ctx) {
    throw new IllegalFlowTransitionError(ctx.runId, "operator_input is reserved for a later slice and not accepted in Slice 1a");
  },
};

/**
 * FlowsStore is intentionally NOT exported as a constructible class (Critical 2)
 * and keeps its SQLite handle in an ECMAScript private `#db` field (Major 1):
 * callers MUST obtain an instance through openFlowsStore(projectId, { dataRoot, readonly, ownerLock }).
 * Writable opens require an active, non-forgeable OwnerLock from acquireOwnerLock().
 */
class FlowsStoreImpl {
  #db: Database.Database;
  #dbKey: string;
  #projectDirFd: number;
  #closed = false;
  #inTx = false;
  #dataRoot?: string;
  #readonlyMode: boolean;
  #ownerLock?: OwnerLock;
  public readonly dbPath: string;
  public readonly projectDir: string;
  public readonly projectId: string;

  constructor(
    projectId: string,
    projectDir: string,
    flowsRoot: string,
    dataRoot: string | undefined,
    options?: { readonly?: boolean; ownerLock?: OwnerLock },
  ) {
    this.projectId = projectId;
    this.projectDir = projectDir;
    this.#dataRoot = dataRoot;
    this.#readonlyMode = options?.readonly ?? false;
    this.#ownerLock = options?.ownerLock;
    this.dbPath = assertNoSymlinkInChain(path.join(projectDir, "flows.db"), projectDir, {
      mustBeStrictDescendant: true,
    });

    checkFilesystemSafety(this.projectDir);
    checkFilesystemSafety(this.dbPath);
    if (!this.#readonlyMode) {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
    }

    // Major 1: Open and HOLD the confined projectDir descriptor for the store's lifetime
    this.#projectDirFd = openConfinedDirFd(
      this.projectDir,
      flowsRoot,
      this.#readonlyMode ? undefined : { createMode: 0o700 },
    );

    try {
      // Critical 1 & 2 + Major 1/2: Non-blocking lstat preflight strictly through #projectDirFd
      assertSafeRegularLstatInDirFd(this.#projectDirFd, "flows.db");
      assertSafeRegularLstatInDirFd(this.#projectDirFd, "flows.db-wal");
      assertSafeRegularLstatInDirFd(this.#projectDirFd, "flows.db-shm");
      assertSafeRegularLstatInDirFd(this.#projectDirFd, "flows.db-journal");

      const realProjectDir = fs.existsSync(this.projectDir)
        ? fs.realpathSync(this.projectDir)
        : path.resolve(this.projectDir);
      this.#dbKey = path.join(realProjectDir, "flows.db");

      // Only pre-create/fchmod via raw fd BEFORE opening SQLite when no same-process connection is open on this DB.
      if (!this.#readonlyMode && (openDbCounts.get(this.#dbKey) ?? 0) === 0) {
        precreateSafeFile0600InDirFd(this.#projectDirFd, "flows.db");
        assertSafeRegularFileInDirFd(this.#projectDirFd, "flows.db", { chmod0600: true });
      }
    } catch (err) {
      try {
        fs.closeSync(this.#projectDirFd);
      } catch {
        // ignore
      }
      this.#closed = true;
      throw err;
    }

    openDbCounts.set(this.#dbKey, (openDbCounts.get(this.#dbKey) ?? 0) + 1);
    try {
      // Critical 1 (Round 10): Open flows.db strictly via /proc/self/fd/<#projectDirFd>/flows.db
      // (so -wal and -shm sidecars also resolve through #projectDirFd!) and verify SQLite's actual
      // opened fd inode matches the live regular flows.db entry.
      const fdDbPath = `/proc/self/fd/${this.#projectDirFd}/flows.db`;
      const fdsBeforeOpen = snapshotProcFds();
      this.#db = new Database(fdDbPath, {
        readonly: this.#readonlyMode,
        fileMustExist: this.#readonlyMode,
        timeout: 5000,
      });
      // Major 5 (Round 11): Wrap post-open verification in try/catch so ANY throw (e.g. symlink
      // refusal in assertSafeRegularLstatInDirFd) closes this.#db immediately without leaking handles.
      try {
        const liveDbStat = assertSafeRegularLstatInDirFd(this.#projectDirFd, "flows.db");
        const sqliteDbStat = verifyOpenedSqliteFileInDirFd(
          this.#projectDirFd,
          fdsBeforeOpen,
          "flows.db",
          liveDbStat,
        );
        if (!sqliteDbStat) {
          throw new Error(`Database inode verification failed on open for '${this.dbPath}'`);
        }
      } catch (verifyErr) {
        try {
          this.#db.close();
        } catch {
          // ignore
        }
        throw verifyErr;
      }
    } catch (err) {
      const next = Math.max(0, (openDbCounts.get(this.#dbKey) ?? 1) - 1);
      if (next === 0) openDbCounts.delete(this.#dbKey);
      else openDbCounts.set(this.#dbKey, next);
      try {
        fs.closeSync(this.#projectDirFd);
      } catch {
        // ignore
      }
      this.#closed = true;
      throw err;
    }

    try {
      this.#configurePragmas();
      if (!this.#readonlyMode) {
        this.#initSchema();
      }
      this.verifyAllRuns();
    } catch (err) {
      this.close();
      throw err;
    }
  }

  #assertNotInTx(runId?: string): void {
    if (this.#inTx) {
      throw new IllegalFlowTransitionError(
        runId ?? "tx",
        "Reentrant store mutation while a SQLite transaction is open is forbidden"
      );
    }
  }

  #assertWritableAndOwned(runId?: string): void {
    if (this.#readonlyMode) {
      throw new Error(`FlowsStore for project '${this.projectId}' is read-only`);
    }
    this.#assertNotInTx(runId);
    assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
  }

  #runInTx<T>(fn: () => T, mode: "immediate" | "deferred" = "immediate"): T {
    this.#assertNotInTx();
    let result!: T;
    const tx = this.#db.transaction(() => {
      this.#inTx = true;
      try {
        result = fn();
      } finally {
        this.#inTx = false;
      }
    });
    if (mode === "immediate") {
      tx.immediate();
    } else {
      tx();
    }
    return result;
  }

  public getPragmaStatus(): { journalMode: string; synchronous: number; foreignKeys: number } {
    this.#assertNotInTx();
    return {
      journalMode: String(this.#db.pragma("journal_mode", { simple: true })).toLowerCase(),
      synchronous: Number(this.#db.pragma("synchronous", { simple: true })),
      foreignKeys: Number(this.#db.pragma("foreign_keys", { simple: true })),
    };
  }

  /**
   * Major 1 & 2: Re-verify projectDir confinement from dataRoot AND confirm our held #projectDirFd
   * still points to the exact same directory inode on disk (detects ancestor swaps / replacements).
   */
  #verifyProjectDirHandle(): string {
    const freshDir = resolveProjectDataDir(this.projectId, this.#dataRoot);
    checkFilesystemSafety(freshDir);
    checkFilesystemSafety(path.join(freshDir, "flows.db"));
    if (freshDir !== this.projectDir) {
      throw new Error(`Project directory drifted from '${this.projectDir}' to '${freshDir}'`);
    }
    const pinnedStat = fs.fstatSync(this.#projectDirFd);
    const liveStat = fs.lstatSync(freshDir);
    if (
      liveStat.isSymbolicLink() ||
      !liveStat.isDirectory() ||
      liveStat.dev !== pinnedStat.dev ||
      liveStat.ino !== pinnedStat.ino
    ) {
      throw new Error(`Project directory inode changed under store: '${freshDir}'`);
    }
    return freshDir;
  }

  #configurePragmas(): void {
    if (!this.#readonlyMode) {
      const jm = String(this.#db.pragma("journal_mode = WAL", { simple: true })).toLowerCase();
      if (jm !== "wal") {
        throw new StorePragmaError(`PRAGMA journal_mode failed to configure WAL (expected 'wal', got '${jm}')`);
      }
    } else {
      const jm = String(this.#db.pragma("journal_mode", { simple: true })).toLowerCase();
      if (jm !== "wal") {
        throw new StorePragmaError(`Read-only store requires WAL journal_mode (got '${jm}')`);
      }
    }

    // Minor 1: Set and assert PRAGMA synchronous = FULL (2) on EVERY open (writable and read-only)
    this.#db.pragma("synchronous = FULL");
    const syncVal = this.#db.pragma("synchronous", { simple: true });
    if (syncVal !== 2) {
      throw new StorePragmaError(`PRAGMA synchronous failed to configure FULL (expected 2, got ${syncVal})`);
    }

    this.#db.pragma("foreign_keys = ON");
    this.#db.pragma("busy_timeout = 5000");

    const quickCheck = this.#db.pragma("quick_check", { simple: true });
    if (quickCheck !== "ok") {
      throw new StorePragmaError(`SQLite quick_check failed on open: ${quickCheck}`);
    }
  }

  #initSchema(): void {
    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS flow_runs (
        run_id TEXT PRIMARY KEY,
        flow_hash TEXT NOT NULL,
        parent_run_id TEXT REFERENCES flow_runs(run_id),
        owner_epoch INTEGER NOT NULL DEFAULT 1,
        spec_version INTEGER NOT NULL DEFAULT 1,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        metadata TEXT
      );

      CREATE TABLE IF NOT EXISTS flow_events (
        run_id TEXT NOT NULL REFERENCES flow_runs(run_id),
        seq INTEGER NOT NULL CHECK (seq >= 1),
        step_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        phase TEXT NOT NULL,
        event_type TEXT NOT NULL,
        line TEXT NOT NULL,
        hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, seq)
      ) WITHOUT ROWID;

      CREATE TABLE IF NOT EXISTS private_details (
        run_id TEXT NOT NULL REFERENCES flow_runs(run_id),
        ref TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, ref)
      );

      CREATE TABLE IF NOT EXISTS flow_artifacts (
        artifact_id TEXT NOT NULL,
        run_id TEXT NOT NULL REFERENCES flow_runs(run_id),
        step_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL,
        name TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        media_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (run_id, artifact_id)
      );

      CREATE TABLE IF NOT EXISTS pinned_flows (
        hash TEXT PRIMARY KEY,
        bytes BLOB NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  public verifyAllRuns(): void {
    this.#assertNotInTx();
    const hasTable = this.#db
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'flow_runs'`)
      .get();
    if (!hasTable) return;

    const fkViolations = this.#db.pragma("foreign_key_check") as Array<{ table: string; parent: string }>;
    if (fkViolations.length > 0) {
      throw new HashChainCorruptionError(
        "unknown",
        0,
        `SQLite foreign_key_check failed on table '${fkViolations[0]!.table}' -> '${fkViolations[0]!.parent}'`
      );
    }

    const runs = this.#db
      .prepare(`SELECT run_id FROM flow_runs UNION SELECT DISTINCT run_id FROM flow_events`)
      .all() as Array<{ run_id: string }>;
    for (const r of runs) {
      this.#verifyHashChainInternal(r.run_id);
    }
  }

  public planRun(params: {
    runId: string;
    flowRef: string;
    flowHash: string;
    flowYamlBytes: string | Buffer;
    source: "project" | "library" | "builtin";
    expectedDecisions: string[];
    metadata?: Record<string, string>;
  }): AppendResult {
    const runId = params.runId;
    const flowRef = params.flowRef;
    const flowHash = params.flowHash;
    const rawYaml = params.flowYamlBytes;
    const source = params.source;
    const expectedDecisions = Array.from(params.expectedDecisions);
    const rawMeta = params.metadata !== undefined ? materializePlain(params.metadata) : undefined;

    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);

    let validatedMeta: string | null = null;
    if (rawMeta !== undefined) {
      const metaRes = FlowRunMetadataSchema.safeParse(rawMeta);
      if (!metaRes.success) {
        throw new Error(`Invalid flow run metadata: ${JSON.stringify(metaRes.error.issues)}`);
      }
      validatedMeta = canonicalJsonStringify(metaRes.data);
    }

    const yamlBuf = Buffer.isBuffer(rawYaml) ? Buffer.from(rawYaml) : Buffer.from(rawYaml, "utf8");
    const calculatedHash = crypto.createHash("sha256").update(yamlBuf).digest("hex");
    if (calculatedHash !== flowHash) {
      throw new Error(`Flow hash mismatch: calculated ${calculatedHash}, provided ${flowHash}`);
    }

    const now = Date.now();
    const nowIso = new Date().toISOString();
    const planItem = parseAndFreezeAppendItem(
      {
        event: {
          v: 1,
          runId,
          seq: 1,
          eventId: "ev_plan_1",
          prev: "0".repeat(64),
          at: nowIso,
          actor: "runner",
          type: "run_planned",
          data: {
            flowRef,
            flowHash,
            source,
            expectedDecisions,
          },
        },
      },
      runId,
    );

    return this.#runInTx(() => {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      this.#db
        .prepare(`INSERT OR IGNORE INTO pinned_flows (hash, bytes, created_at) VALUES (?, ?, ?)`)
        .run(flowHash, yamlBuf, now);
      this.#db
        .prepare(
          `INSERT INTO flow_runs (
             run_id, flow_hash, parent_run_id, owner_epoch, spec_version,
             status, created_at, updated_at, metadata
           ) VALUES (?, ?, NULL, 1, 1, 'planned', ?, ?, ?)`
        )
        .run(runId, flowHash, now, now, validatedMeta);

      const res = this.#appendItemsInOpenTx(runId, [planItem])[0]!;
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      return res;
    });
  }

  public approveRun(params: {
    runId: string;
    flowHash: string;
    actorId: string;
  }): AppendResult {
    const runId = params.runId;
    const flowHash = params.flowHash;
    const actorId = params.actorId;

    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);
    if (!FlowIdRegex.test(actorId)) {
      throw new Error(`Invalid actorId '${actorId}': must match ${FlowIdRegex.source}`);
    }

    return this.#runInTx(() => {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      const run = this.#getRunInternal(runId);
      if (!run) {
        throw new Error(`Flow run '${runId}' not found`);
      }
      if (flowHash !== run.flow_hash) {
        throw new IllegalFlowTransitionError(
          runId,
          `flow_approved flowHash '${flowHash}' does not match pinned flow_hash '${run.flow_hash}'`
        );
      }
      const existing = this.#getParsedEventsInternal(runId);
      if (existing.some((e) => e.type === "flow_approved")) {
        throw new IllegalFlowTransitionError(runId, `Flow run '${runId}' is already approved`);
      }
      if (run.status !== "planned" || !existing.some((e) => e.type === "run_planned")) {
        throw new IllegalFlowTransitionError(
          runId,
          `Flow run '${runId}' must be in 'planned' status before approval (got '${run.status}')`
        );
      }

      const head = this.#db
        .prepare(`SELECT seq, hash FROM flow_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(runId) as { seq: number; hash: string } | undefined;
      if (!head) {
        throw new IllegalFlowTransitionError(runId, `Flow run '${runId}' has no run_planned event`);
      }

      const approveItem = parseAndFreezeAppendItem(
        {
          event: {
            v: 1,
            runId,
            seq: head.seq + 1,
            eventId: "ev_approve_2",
            prev: head.hash,
            at: new Date().toISOString(),
            actor: "human",
            type: "flow_approved",
            data: {
              flowHash,
              actorId,
            },
          },
        },
        runId,
      );
      const res = this.#appendItemsInOpenTx(runId, [approveItem])[0]!;
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      return res;
    });
  }

  public createAndApproveRun(params: {
    runId: string;
    flowRef: string;
    flowHash: string;
    flowYamlBytes: string | Buffer;
    source: "project" | "library" | "builtin";
    expectedDecisions: string[];
    actorId: string;
    metadata?: Record<string, string>;
  }): void {
    // Major 4 (Round 10): Snapshot ALL caller-owned parameters once BEFORE ownership check & tx
    const runId = params.runId;
    const flowRef = params.flowRef;
    const flowHash = params.flowHash;
    const rawYaml = params.flowYamlBytes;
    const source = params.source;
    const expectedDecisions = Array.from(params.expectedDecisions);
    const actorId = params.actorId;
    const rawMeta = params.metadata !== undefined ? materializePlain(params.metadata) : undefined;

    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);
    if (!FlowIdRegex.test(actorId)) {
      throw new Error(`Invalid actorId '${actorId}': must match ${FlowIdRegex.source}`);
    }
    let validatedMeta: string | null = null;
    if (rawMeta !== undefined) {
      const metaRes = FlowRunMetadataSchema.safeParse(rawMeta);
      if (!metaRes.success) {
        throw new Error(`Invalid flow run metadata: ${JSON.stringify(metaRes.error.issues)}`);
      }
      validatedMeta = canonicalJsonStringify(metaRes.data);
    }
    const yamlBuf = Buffer.isBuffer(rawYaml) ? Buffer.from(rawYaml) : Buffer.from(rawYaml, "utf8");
    const calculatedHash = crypto.createHash("sha256").update(yamlBuf).digest("hex");
    if (calculatedHash !== flowHash) {
      throw new Error(`Flow hash mismatch: calculated ${calculatedHash}, provided ${flowHash}`);
    }

    const now = Date.now();
    const nowIso = new Date().toISOString();
    const planItem = parseAndFreezeAppendItem(
      {
        event: {
          v: 1,
          runId,
          seq: 1,
          eventId: "ev_plan_1",
          prev: "0".repeat(64),
          at: nowIso,
          actor: "runner",
          type: "run_planned",
          data: {
            flowRef,
            flowHash,
            source,
            expectedDecisions,
          },
        },
      },
      runId,
    );

    this.#runInTx(() => {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      this.#db
        .prepare(`INSERT OR IGNORE INTO pinned_flows (hash, bytes, created_at) VALUES (?, ?, ?)`)
        .run(flowHash, yamlBuf, now);
      this.#db
        .prepare(
          `INSERT INTO flow_runs (
             run_id, flow_hash, parent_run_id, owner_epoch, spec_version,
             status, created_at, updated_at, metadata
           ) VALUES (?, ?, NULL, 1, 1, 'planned', ?, ?, ?)`
        )
        .run(runId, flowHash, now, now, validatedMeta);

      const r1 = this.#appendItemsInOpenTx(runId, [planItem])[0]!;

      const approveItem = parseAndFreezeAppendItem(
        {
          event: {
            v: 1,
            runId,
            seq: 2,
            eventId: "ev_approve_2",
            prev: r1.hash,
            at: nowIso,
            actor: "human",
            type: "flow_approved",
            data: {
              flowHash,
              actorId,
            },
          },
        },
        runId,
      );
      this.#appendItemsInOpenTx(runId, [approveItem]);
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
    });
  }

  public createRun(params: CreateRunParams): void {
    // Major 4 (Round 10): Snapshot ALL caller-owned parameters once BEFORE ownership check & tx
    const runId = params.runId;
    const providedFlowHash = params.flowHash;
    const rawYaml = params.flowYamlBytes;
    const parentRunId = params.parentRunId;
    const ownerEpoch = params.ownerEpoch ?? 1;
    const specVersion = params.specVersion ?? 1;
    const rawMeta = params.metadata !== undefined ? materializePlain(params.metadata) : undefined;

    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);
    if (parentRunId !== undefined) {
      assertValidRunId(parentRunId);
    }

    let validatedMeta: string | null = null;
    if (rawMeta !== undefined) {
      const metaRes = FlowRunMetadataSchema.safeParse(rawMeta);
      if (!metaRes.success) {
        throw new Error(`Invalid flow run metadata: ${JSON.stringify(metaRes.error.issues)}`);
      }
      validatedMeta = canonicalJsonStringify(metaRes.data);
    }

    const now = Date.now();
    const yamlBuf = Buffer.isBuffer(rawYaml) ? Buffer.from(rawYaml) : Buffer.from(rawYaml, "utf8");

    const flowHash = crypto.createHash("sha256").update(yamlBuf).digest("hex");
    if (flowHash !== providedFlowHash) {
      throw new Error(`Flow hash mismatch: calculated ${flowHash}, provided ${providedFlowHash}`);
    }

    this.#runInTx(() => {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      this.#db
        .prepare(
          `INSERT OR IGNORE INTO pinned_flows (hash, bytes, created_at)
           VALUES (?, ?, ?)`
        )
        .run(providedFlowHash, yamlBuf, now);

      this.#db
        .prepare(
          `INSERT INTO flow_runs (
             run_id, flow_hash, parent_run_id, owner_epoch, spec_version,
             status, created_at, updated_at, metadata
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          runId,
          providedFlowHash,
          parentRunId ?? null,
          ownerEpoch,
          specVersion,
          "planned",
          now,
          now,
          validatedMeta
        );
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
    });
  }

  #getRunInternal(runId: string): FlowRunRow | null {
    assertValidRunId(runId);
    const row = this.#db.prepare(`SELECT * FROM flow_runs WHERE run_id = ?`).get(runId);
    return (row as FlowRunRow) ?? null;
  }

  public getRun(runId: string): FlowRunRow | null {
    this.#assertNotInTx(runId);
    return this.#getRunInternal(runId);
  }

  public listRuns(): FlowRunRow[] {
    this.#assertNotInTx();
    if (this.#closed) {
      throw new Error(`FlowsStore for project '${this.projectId}' is closed`);
    }
    return this.#db
      .prepare(`SELECT * FROM flow_runs ORDER BY created_at DESC, run_id DESC`)
      .all() as FlowRunRow[];
  }

  #getPinnedFlowInternal(flowHash: string): Buffer | null {
    const row = this.#db.prepare(`SELECT bytes FROM pinned_flows WHERE hash = ?`).get(flowHash) as
      | { bytes: Buffer }
      | undefined;
    return row ? row.bytes : null;
  }

  public getPinnedFlow(flowHash: string): Buffer | null {
    this.#assertNotInTx();
    return this.#getPinnedFlowInternal(flowHash);
  }

  public appendEvent(event: FlowEvent, options?: AppendOptions): AppendResult {
    // Major 3 (Round 10): Snapshot options fields ONCE before entering batchAppendEvents
    const privateDetail = options?.privateDetail;
    const deadlineMs = options?.deadlineMs;
    return this.batchAppendEvents(
      [{ event, privateDetail }],
      deadlineMs !== undefined ? { deadlineMs } : undefined,
    )[0]!;
  }

  public allocateAndAppendStepIntent(params: {
    runId: string;
    stepId: string;
    effectKey?: string;
    eventId?: string;
    at?: string;
  }): { seq: number; hash: string; occurrence: number; attemptId: string; effectKey: string; eventId: string } {
    const runId = params.runId;
    const stepId = params.stepId;
    const providedEffectKey = params.effectKey;
    const providedAt = params.at;

    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);

    return this.#runInTx(() => {
      const existing = this.#getParsedEventsInternal(runId);
      const head = this.#db
        .prepare(`SELECT seq, hash FROM flow_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(runId) as { seq: number; hash: string } | undefined;

      let maxOcc = 0;
      for (const ev of existing) {
        if (ev.type === "step_started" && ev.stepId === stepId) {
          if (ev.data.occurrence > maxOcc) maxOcc = ev.data.occurrence;
        }
      }
      const occurrence = maxOcc + 1;
      const attemptId = buildBoundedAttemptId(stepId, occurrence);
      const effectKey = buildDeterministicEffectKey(runId, stepId, occurrence);
      if (providedEffectKey !== undefined && providedEffectKey !== effectKey) {
        throw new IllegalFlowTransitionError(
          runId,
          `step_started effectKey '${providedEffectKey}' must match deterministic key '${effectKey}'`
        );
      }
      const nextSeq = (head?.seq ?? 0) + 1;
      const prev = head?.hash ?? "0".repeat(64);
      const eventId = `ev_${crypto.randomBytes(12).toString("hex")}`;

      const prepared = parseAndFreezeAppendItem(
        {
          event: {
            v: 1,
            runId,
            seq: nextSeq,
            eventId,
            prev,
            at: providedAt ?? new Date().toISOString(),
            actor: "runner",
            type: "step_started",
            stepId,
            attemptId,
            data: { occurrence, effectKey },
          },
        },
        runId,
      );

      const appended = this.#appendItemsInOpenTx(runId, [prepared]);
      return {
        seq: appended[0]!.seq,
        hash: appended[0]!.hash,
        occurrence,
        attemptId,
        effectKey,
        eventId: prepared.event.eventId,
      };
    });
  }

  public appendChainedBatch(
    runId: string,
    builders: Array<(seq: number, prev: string) => { event: FlowEvent; privateDetail?: string }>,
    options?: { deadlineMs?: number },
  ): AppendResult[] {
    // Major 3 (Round 10): Snapshot options & builders BEFORE ownership check & tx
    const snapshotBuilders = Array.from(builders);
    const deadlineMs = options?.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs))) {
      throw new Error("Invalid deadlineMs: expected finite number");
    }
    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);
    if (snapshotBuilders.length === 0) return [];

    return this.#runInTx(() => {
      const head = this.#db
        .prepare(`SELECT seq, hash FROM flow_events WHERE run_id = ? ORDER BY seq DESC LIMIT 1`)
        .get(runId) as { seq: number; hash: string } | undefined;
      let seq = head ? head.seq : 0;
      let prev = head ? head.hash : "0".repeat(64);
      const out: AppendResult[] = [];
      const builtItems: PreparedAppendItem[] = [];
      for (let idx = 0; idx < snapshotBuilders.length; idx++) {
        const build = snapshotBuilders[idx]!;
        const nextSeq = seq + 1;
        const rawBuilt = build(nextSeq, prev);
        // Critical 1 & Major 4: Parse-once-then-freeze immediately after builder returns
        const prepared = parseAndFreezeAppendItem(rawBuilt, runId);
        if ((snapshotBuilders.length > 1 || out.length > 0) && prepared.event.type === "step_started") {
          throw new IllegalFlowTransitionError(
            runId,
            "step_started intent must be committed solo, never inside a multi-event batch"
          );
        }
        // Critical 2: Re-verify active owner lock INSIDE BEGIN IMMEDIATE after untrusted builder runs
        assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
        const res = this.#appendItemsInOpenTx(runId, [prepared], deadlineMs)[0]!;
        seq = res.seq;
        prev = res.hash;
        out.push(res);
        builtItems.push(prepared);

        // K8 real production transaction rollback hooks (after check_result, step_result, OR judgement BEFORE commit)
        if (
          (process.env["FLOW_K8_KILL_MID_CHECK_BATCH"] === "1" && prepared.event.type === "check_result") ||
          (process.env["FLOW_K8_KILL_AFTER_STEP_RESULT"] === "1" && prepared.event.type === "step_result") ||
          (process.env["FLOW_K8_KILL_AFTER_JUDGEMENT"] === "1" && prepared.event.type === "judgement")
        ) {
          process.kill(process.pid, "SIGKILL");
        }
      }
      // Major 3 (Round 11): Enforce Revision 4 deterministic batching rule + content checks before commit
      assertLegalBatchShape(runId, builtItems);
      // Major 1 (Round 10): Verify owner lock BEFORE the final deadline check so deadline is LAST before COMMIT
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      if (deadlineMs !== undefined && Date.now() > deadlineMs) {
        throw new StepDeadlineExceededError(runId, deadlineMs);
      }
      return out;
    });
  }

  public batchAppendEvents(
    items: Array<{ event: FlowEvent; privateDetail?: string }>,
    options?: { deadlineMs?: number },
  ): AppendResult[] {
    this.#assertNotInTx();
    // Major 3 (Round 10): Snapshot options.deadlineMs BEFORE entering #runInTx
    const deadlineMs = options?.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs))) {
      throw new Error("Invalid deadlineMs: expected finite number");
    }
    const rawItems = Array.from(items);
    if (rawItems.length === 0) return [];

    // Critical 1 & Major 4: Materialize, provenance-check, schema-parse, and deep-freeze ALL items
    // BEFORE opening BEGIN IMMEDIATE so caller getters NEVER execute inside an open SQLite transaction
    // and NEVER get read twice.
    const preparedItems: PreparedAppendItem[] = [];
    let batchRunId: string | undefined;
    for (const rawItem of rawItems) {
      const prepared = parseAndFreezeAppendItem(rawItem, batchRunId);
      if (batchRunId === undefined) {
        batchRunId = prepared.event.runId;
      }
      preparedItems.push(prepared);
    }

    const runId = batchRunId!;
    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);

    // Major 3 (Round 11): Enforce Revision 4 deterministic batching rule + content checks
    assertLegalBatchShape(runId, preparedItems);

    return this.#runInTx(() => {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      return this.#appendItemsInOpenTx(runId, preparedItems, deadlineMs);
    });
  }

  #readArtefactViaProjectDirFd(runId: string, sha256: string): { size: number; bytes?: Buffer } | null {
    this.#verifyProjectDirHandle();
    const artifactsParentFd = openConfinedSubdirFd(this.#projectDirFd, "artifacts", { allowMissing: true });
    if (artifactsParentFd === null) return null;
    try {
      const runDirFd = openConfinedSubdirFd(artifactsParentFd, runId, { allowMissing: true });
      if (runDirFd === null) return null;
      try {
        return assertSafeRegularFileInDirFd(runDirFd, sha256, { readBytes: true });
      } finally {
        fs.closeSync(runDirFd);
      }
    } finally {
      fs.closeSync(artifactsParentFd);
    }
  }

  #appendItemsInOpenTx(
    runId: string,
    items: readonly PreparedAppendItem[],
    deadlineMs?: number,
  ): AppendResult[] {
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      throw new StepDeadlineExceededError(runId, deadlineMs);
    }

    const run = this.#getRunInternal(runId);
    if (!run) {
      throw new Error(`Cannot append event: flow run '${runId}' does not exist`);
    }

    const pinnedBytes = this.#getPinnedFlowInternal(run.flow_hash);
    if (!pinnedBytes) {
      throw new IllegalFlowTransitionError(runId, "Pinned flow definition is missing");
    }
    // Major 2: Verify pinned_flows.bytes SHA-256 matches run.flow_hash BEFORE building transition step map
    const actualPinHash = crypto.createHash("sha256").update(pinnedBytes).digest("hex");
    if (actualPinHash !== run.flow_hash) {
      throw new HashChainCorruptionError(
        runId,
        0,
        `Pinned flow bytes SHA-256 mismatch at append: expected '${run.flow_hash}', got '${actualPinHash}'`
      );
    }
    const parsedPinned = validateFlowYaml(pinnedBytes.toString("utf8"));
    if (!parsedPinned.valid) {
      throw new IllegalFlowTransitionError(runId, "Pinned flow definition is invalid");
    }
    const pinnedFlow = parsedPinned.flow;
    const stepById = new Map<string, FlowStep>();
    const stepIndexById = new Map<string, number>();
    pinnedFlow.steps.forEach((s, idx) => {
      stepById.set(s.id, s);
      stepIndexById.set(s.id, idx);
    });

    const existingRows = this.#getAllEventRowsUnfiltered(runId);
    const existingEvents = existingRows.map((r) => JSON.parse(r.line) as FlowEvent);

    let currentSeq = existingRows.length > 0 ? existingRows[existingRows.length - 1]!.seq : 0;
    let currentPrev = existingRows.length > 0 ? existingRows[existingRows.length - 1]!.hash : "0".repeat(64);
    let currentStatus = run.status;

    const receiptNameById = new Map<string, string>(
      this.#listArtifactsInternal(runId).map((r) => [r.artifact_id, r.name])
    );

    const ctx: TransitionContext = {
      runId,
      run,
      pinnedFlow,
      stepById,
      stepIndexById,
      nextSeq: currentSeq + 1,
      hasPlanned: false,
      hasApproved: false,
      hasStarted: false,
      hasRunFinished: false,
      hasStopJudgement: false,
      hasPendingDecide: false,
      hasPendingUnknown: false,
      rewindsUsed: 0,
      expectedNextStepId: null,
      openHandoff: null,
      closedHandoffIds: new Set<string>(),
      returnedHandoffByAttempt: new Map(),
      unknownAttempts: new Set<string>(),
      pendingDecideAttemptKey: null,
      terminalDecisionEnd: null,
      seenOccurrences: new Set<string>(),
      startedAttempts: new Set<string>(),
      settledAttempts: new Set<string>(),
      succeededAttempts: new Set<string>(),
      failedAttempts: new Set<string>(),
      checkedAttempts: new Set<string>(),
      passedCheckAttempts: new Set<string>(),
      judgedAttempts: new Set<string>(),
      passedStepIds: new Set<string>(),
      passedCheckProvenanceByStep: new Map(),
      passedCheckProvenanceByAttempt: new Map(),
      publicRecordedArtefactShas: new Set<string>(),
      events: [],
      budgetStepsRemaining: null,
      budgetTokensRemaining: null,
      hasActiveUnsettledAttempt: () => {
        for (const key of ctx.startedAttempts) {
          if (!ctx.settledAttempts.has(key)) return true;
        }
        return false;
      },
      hasUnjudgedSettledAttempt: () => {
        for (const key of ctx.settledAttempts) {
          if (!ctx.judgedAttempts.has(key)) return true;
        }
        return false;
      },
      resolveExpectedCheckTarget: (step: CheckStep) =>
        resolvePinnedCheckTarget(step, ctx.events, receiptNameById, ctx.pinnedFlow),
      verifyArtefactReceiptAndDisk: (artifactId, stepId, attemptId, sha256, sizeBytes) => {
        const receipt = this.#db
          .prepare(
            `SELECT 1 FROM flow_artifacts
             WHERE artifact_id = ? AND run_id = ? AND step_id = ? AND attempt_id = ?
               AND content_hash = ? AND size = ?`
          )
          .get(artifactId, runId, stepId, attemptId, sha256, sizeBytes);
        if (!receipt) {
          throw new IllegalFlowTransitionError(
            runId,
            `artefact_recorded '${artifactId}' has no matching verified receipt in flow_artifacts`
          );
        }
        const verified = this.#readArtefactViaProjectDirFd(runId, sha256);
        if (!verified || !verified.bytes || verified.size !== sizeBytes) {
          throw new ArtifactVerificationError(artifactId, "Artefact file is missing or size mismatch at append");
        }
        const artActualHash = crypto.createHash("sha256").update(verified.bytes).digest("hex");
        if (artActualHash !== sha256) {
          throw new ArtifactVerificationError(artifactId, "Artefact content hash mismatch at append");
        }
      },
      verifyPublicArtefactShaOnDisk: (sha256, requireNonEmpty = false) => {
        const verified = this.#readArtefactViaProjectDirFd(runId, sha256);
        if (!verified || !verified.bytes) {
          throw new ArtifactVerificationError(sha256, "Referenced public artefact file missing on disk");
        }
        if (requireNonEmpty && verified.bytes.length === 0) {
          throw new ArtifactVerificationError(sha256, "Referenced public artefact is empty (check_nonempty failed)");
        }
        const actual = crypto.createHash("sha256").update(verified.bytes).digest("hex");
        if (actual !== sha256) {
          throw new ArtifactVerificationError(sha256, "Referenced public artefact hash mismatch on disk");
        }
      },
    };

    const applyToCtx = (ev: FlowEvent) => {
      ctx.events.push(ev);
      if (ev.type === "run_planned") ctx.hasPlanned = true;
      else if (ev.type === "flow_approved") ctx.hasApproved = true;
      else if (ev.type === "run_started") {
        ctx.hasStarted = true;
        const pinnedBudget = resolvePinnedBudget(ctx.pinnedFlow);
        ctx.budgetStepsRemaining = pinnedBudget.steps;
        ctx.budgetTokensRemaining = pinnedBudget.tokens;
      } else if (ev.type === "run_finished") ctx.hasRunFinished = true;
      else if (ev.type === "step_started") {
        ctx.seenOccurrences.add(`${ev.stepId}:${ev.data.occurrence}`);
        ctx.startedAttempts.add(`${ev.stepId}:${ev.attemptId}`);
        ctx.expectedNextStepId = null;
        ctx.terminalDecisionEnd = null;
        if (ctx.budgetStepsRemaining !== null) ctx.budgetStepsRemaining -= 1;
        // Critical 2 (Round 10) & Major 4 (Round 11): Starting a new occurrence clears pass state
        // for this step AND every downstream step (invalidating checks whose producer re-ran,
        // without touching earlier checks when a later step starts).
        const clearProvenanceForStep = (id: string) => {
          ctx.passedCheckProvenanceByStep.delete(id);
          const prefix = `${id}:`;
          for (const key of ctx.passedCheckProvenanceByAttempt.keys()) {
            if (key.startsWith(prefix)) {
              ctx.passedCheckProvenanceByAttempt.delete(key);
            }
          }
        };
        ctx.passedStepIds.delete(ev.stepId);
        clearProvenanceForStep(ev.stepId);
        const startedIdx = ctx.stepIndexById.get(ev.stepId);
        if (startedIdx !== undefined) {
          for (let j = startedIdx + 1; j < ctx.pinnedFlow.steps.length; j++) {
            const downstreamId = ctx.pinnedFlow.steps[j]!.id;
            ctx.passedStepIds.delete(downstreamId);
            clearProvenanceForStep(downstreamId);
          }
        }
      } else if (ev.type === "artefact_recorded") {
        ctx.publicRecordedArtefactShas.add(ev.data.sha256);
      } else if (ev.type === "check_result") {
        const k = `${ev.stepId}:${ev.attemptId}`;
        ctx.checkedAttempts.add(k);
        const checkStep = ctx.stepById.get(ev.stepId);
        if (ev.data.passed && checkStep?.type === "check") {
          ctx.passedCheckAttempts.add(k);
          const resolvedTarget = ctx.resolveExpectedCheckTarget(checkStep);
          if (resolvedTarget && resolvedTarget.sha256 === ev.data.targetSha) {
            const prov = {
              producerStepId: resolvedTarget.stepId,
              producerAttemptId: resolvedTarget.attemptId,
              producerOccurrence: resolvedTarget.occurrence,
              targetSha: ev.data.targetSha,
            };
            ctx.passedCheckProvenanceByStep.set(ev.stepId, prov);
            ctx.passedCheckProvenanceByAttempt.set(k, prov);
          } else {
            ctx.passedCheckProvenanceByStep.delete(ev.stepId);
            ctx.passedCheckProvenanceByAttempt.delete(k);
          }
        } else {
          ctx.passedCheckProvenanceByStep.delete(ev.stepId);
          ctx.passedCheckProvenanceByAttempt.delete(k);
        }
      } else if (ev.type === "step_result") {
        const k = `${ev.stepId}:${ev.attemptId}`;
        ctx.settledAttempts.add(k);
        ctx.succeededAttempts.add(k);
        if (ctx.budgetTokensRemaining !== null) ctx.budgetTokensRemaining -= ev.data.tokensUsed;
      } else if (ev.type === "step_failed") {
        const k = `${ev.stepId}:${ev.attemptId}`;
        ctx.settledAttempts.add(k);
        ctx.failedAttempts.add(k);
        ctx.passedStepIds.delete(ev.stepId);
        ctx.passedCheckProvenanceByStep.delete(ev.stepId);
        ctx.passedCheckProvenanceByAttempt.delete(k);
      } else if (ev.type === "step_outcome_unknown") {
        const k = `${ev.stepId}:${ev.attemptId}`;
        ctx.settledAttempts.add(k);
        ctx.failedAttempts.add(k);
        ctx.unknownAttempts.add(k);
        ctx.passedStepIds.delete(ev.stepId);
        ctx.passedCheckProvenanceByStep.delete(ev.stepId);
        ctx.passedCheckProvenanceByAttempt.delete(k);
        ctx.hasPendingUnknown = true;
      } else if (ev.type === "judgement") {
        const k = `${ev.stepId}:${ev.attemptId}`;
        ctx.judgedAttempts.add(k);
        if (ev.data.final === "stop") {
          ctx.hasStopJudgement = true;
          ctx.hasPendingUnknown = false;
          ctx.hasPendingDecide = false;
          ctx.pendingDecideAttemptKey = null;
          ctx.passedStepIds.delete(ev.stepId);
          ctx.passedCheckProvenanceByStep.delete(ev.stepId);
          ctx.passedCheckProvenanceByAttempt.delete(k);
        } else if (ev.data.final === "decide") {
          ctx.hasPendingDecide = true;
          ctx.pendingDecideAttemptKey = k;
          ctx.passedStepIds.delete(ev.stepId);
          ctx.passedCheckProvenanceByStep.delete(ev.stepId);
        } else if (
          (ev.data.final === "continue" || ev.data.final === "notify") &&
          ctx.succeededAttempts.has(k)
        ) {
          ctx.passedStepIds.add(ev.stepId);
          const stepDef = ctx.stepById.get(ev.stepId);
          if (stepDef?.type === "decision") {
            const ret = ctx.returnedHandoffByAttempt.get(k);
            if (ret && ret.resolution === "answered") {
              const opt = stepDef.options.find((o) => o.key === ret.choiceKey);
              if (opt?.end) {
                ctx.terminalDecisionEnd = {
                  outcome: opt.end,
                  stepId: ev.stepId,
                  choiceKey: ret.choiceKey,
                };
              }
            }
          }
        } else {
          ctx.passedStepIds.delete(ev.stepId);
          ctx.passedCheckProvenanceByStep.delete(ev.stepId);
        }
      } else if (ev.type === "handoff_sent") {
        const k = `${ev.stepId}:${ev.attemptId}`;
        ctx.openHandoff = {
          handoffId: ev.data.handoffId,
          stepId: ev.stepId,
          attemptId: ev.attemptId,
          kind: ev.data.kind,
          optionKeys: [...ev.data.optionKeys],
          alwaysDecide: ev.data.alwaysDecide ?? false,
          target: ev.data.target,
        };
        ctx.hasPendingDecide = true;
        ctx.pendingDecideAttemptKey = k;
      } else if (ev.type === "handoff_returned") {
        const k = `${ev.stepId}:${ev.attemptId}`;
        ctx.openHandoff = null;
        ctx.closedHandoffIds.add(ev.data.handoffId);
        ctx.hasPendingDecide = false;
        ctx.pendingDecideAttemptKey = null;
        ctx.returnedHandoffByAttempt.set(k, {
          handoffId: ev.data.handoffId,
          choiceKey: ev.data.choiceKey,
          resolution: ev.data.resolution,
        });
        if (ctx.succeededAttempts.has(k)) {
          const stepDef = ctx.stepById.get(ev.stepId);
          if (stepDef?.type === "decision") {
            if (ev.data.resolution === "answered") {
              const opt = stepDef.options.find((o) => o.key === ev.data.choiceKey);
              if (opt?.end) {
                ctx.terminalDecisionEnd = {
                  outcome: opt.end,
                  stepId: ev.stepId,
                  choiceKey: ev.data.choiceKey,
                };
              } else if (!opt?.goto) {
                ctx.passedStepIds.add(ev.stepId);
              }
            }
          } else if (stepDef?.type === "handoff") {
            if (ev.data.resolution === "answered" && !stepDef.on_return?.[ev.data.choiceKey]?.goto) {
              ctx.passedStepIds.add(ev.stepId);
            }
          } else {
            const caseBContinue =
              (ev.data.resolution === "answered" &&
                ev.data.choiceKey !== "stop" &&
                ev.data.choiceKey !== "retry") ||
              (ev.data.resolution === "expired" &&
                (ctx.pinnedFlow.on_unanswered?.outcome === "continue" ||
                  ctx.pinnedFlow.on_unanswered?.outcome === "notify"));
            if (caseBContinue) {
              ctx.passedStepIds.add(ev.stepId);
              if (stepDef?.type === "check") {
                const attemptProv = ctx.passedCheckProvenanceByAttempt.get(k);
                if (attemptProv) {
                  ctx.passedCheckProvenanceByStep.set(ev.stepId, attemptProv);
                }
              }
            }
          }
        }
      } else if (ev.type === "handoff_cancelled") {
        ctx.openHandoff = null;
        ctx.closedHandoffIds.add(ev.data.handoffId);
        ctx.hasPendingDecide = false;
        ctx.pendingDecideAttemptKey = null;
      } else if (ev.type === "step_rewound") {
        ctx.rewindsUsed = ev.data.rewindNumber;
        ctx.hasPendingDecide = false;
        ctx.pendingDecideAttemptKey = null;
        ctx.expectedNextStepId = ev.data.toStepId;
        ctx.terminalDecisionEnd = null;
        const toIdx = ctx.stepIndexById.get(ev.data.toStepId);
        if (toIdx !== undefined) {
          for (let j = toIdx; j < ctx.pinnedFlow.steps.length; j++) {
            const targetId = ctx.pinnedFlow.steps[j]!.id;
            ctx.passedStepIds.delete(targetId);
            ctx.passedCheckProvenanceByStep.delete(targetId);
            const prefix = `${targetId}:`;
            for (const key of ctx.passedCheckProvenanceByAttempt.keys()) {
              if (key.startsWith(prefix)) {
                ctx.passedCheckProvenanceByAttempt.delete(key);
              }
            }
          }
        }
      }
    };

    for (const ev of existingEvents) {
      applyToCtx(ev);
    }

    const results: AppendResult[] = [];

    for (const item of items) {
      const validatedEvent = item.event;
      if (validatedEvent.runId !== runId) {
        throw new Error(`Batch contains mismatched runId: expected '${runId}', got '${validatedEvent.runId}'`);
      }

      const nextSeq = currentSeq + 1;
      ctx.nextSeq = nextSeq;
      if (validatedEvent.seq !== nextSeq) {
        throw new Error(`Invalid event seq: expected ${nextSeq}, got ${validatedEvent.seq}`);
      }
      if (validatedEvent.prev !== currentPrev) {
        throw new Error(`Invalid event prev hash: expected ${currentPrev}, got ${validatedEvent.prev}`);
      }

      // Global monotonic guards + declarative TRANSITION_TABLE dispatch
      if (nextSeq === 1 && validatedEvent.type !== "run_planned") {
        throw new IllegalFlowTransitionError(
          runId,
          `First event (seq 1) must be 'run_planned', got '${validatedEvent.type}'`
        );
      }
      if (ctx.hasRunFinished) {
        throw new IllegalFlowTransitionError(runId, `Cannot append '${validatedEvent.type}' after run_finished`);
      }
      if (
        ctx.hasStopJudgement &&
        validatedEvent.type !== "run_finished" &&
        validatedEvent.type !== "run_released"
      ) {
        throw new IllegalFlowTransitionError(runId, `Cannot append '${validatedEvent.type}' after judgement(stop)`);
      }

      const rule = TRANSITION_TABLE[validatedEvent.type] as TransitionRule;
      rule(ctx, validatedEvent);

      // Major 2: Re-check wall-clock deadline AFTER synchronous disk rereads inside rule() and BEFORE INSERT!
      if (deadlineMs !== undefined && Date.now() > deadlineMs) {
        throw new StepDeadlineExceededError(runId, deadlineMs);
      }

      const now = Date.now();
      if (item.privateDetail !== undefined && item.privateRef) {
        this.#db
          .prepare(`INSERT INTO private_details (run_id, ref, content, created_at) VALUES (?, ?, ?, ?)`)
          .run(runId, item.privateRef, item.privateDetail, now);
      }

      const line = canonicalJsonStringify(validatedEvent);
      const hash = crypto.createHash("sha256").update(line, "utf8").digest("hex");
      const stepId = "stepId" in validatedEvent ? validatedEvent.stepId : "flow";
      const attemptId = "attemptId" in validatedEvent ? validatedEvent.attemptId : "0";

      this.#db
        .prepare(
          `INSERT INTO flow_events (
             run_id, seq, step_id, attempt_id, phase, event_type,
             line, hash, prev_hash, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(runId, validatedEvent.seq, stepId, attemptId, validatedEvent.type, validatedEvent.type, line, hash, validatedEvent.prev, now);

      // K5 real production transaction rollback hook: SIGKILL after BOTH private_details and flow_events inserts, BEFORE commit
      if (process.env["FLOW_K5_KILL_MID_TX"] === "1" && item.privateDetail !== undefined) {
        process.kill(process.pid, "SIGKILL");
      }

      applyToCtx(validatedEvent);
      if (validatedEvent.type === "run_planned") currentStatus = "planned";
      else if (validatedEvent.type === "flow_approved") currentStatus = "approved";
      else if (validatedEvent.type === "run_started") currentStatus = "running";
      else if (validatedEvent.type === "step_outcome_unknown") currentStatus = "waiting_decision";
      else if (validatedEvent.type === "handoff_sent") currentStatus = "waiting_decision";
      else if (
        validatedEvent.type === "handoff_returned" ||
        validatedEvent.type === "handoff_cancelled" ||
        validatedEvent.type === "step_rewound"
      ) {
        currentStatus = "running";
      } else if (validatedEvent.type === "judgement") {
        if (validatedEvent.data.final === "stop") currentStatus = "stopped";
        else if (validatedEvent.data.final === "decide") currentStatus = "waiting_decision";
      } else if (validatedEvent.type === "run_finished") {
        currentStatus = validatedEvent.data.outcome === "done" ? "finished" : "stopped";
      }

      this.#db
        .prepare(`UPDATE flow_runs SET status = ?, updated_at = ? WHERE run_id = ?`)
        .run(currentStatus, now, runId);

      currentSeq = nextSeq;
      currentPrev = hash;
      results.push({ seq: validatedEvent.seq, hash, privateRef: item.privateRef });
    }

    // Major 1 (Round 10): Verify owner lock BEFORE the final deadline check so elapsed time
    // is literally the LAST check executed before SQLite COMMIT.
    assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      throw new StepDeadlineExceededError(runId, deadlineMs);
    }
    return results;
  }

  #getAllEventRowsUnfiltered(runId: string): FlowEventRow[] {
    return this.#db
      .prepare(`SELECT * FROM flow_events WHERE run_id = ? ORDER BY seq ASC`)
      .all(runId) as FlowEventRow[];
  }

  public getEvents(runId: string, sinceSeq = 0): FlowEventRow[] {
    this.#assertNotInTx(runId);
    assertValidRunId(runId);
    return this.#db
      .prepare(`SELECT * FROM flow_events WHERE run_id = ? AND seq > ? ORDER BY seq ASC`)
      .all(runId, sinceSeq) as FlowEventRow[];
  }

  #getParsedEventsInternal(runId: string): FlowEvent[] {
    assertValidRunId(runId);
    return this.#getAllEventRowsUnfiltered(runId).map((r) => JSON.parse(r.line) as FlowEvent);
  }

  public getParsedEvents(runId: string): FlowEvent[] {
    this.#assertNotInTx(runId);
    return this.#getParsedEventsInternal(runId);
  }

  public getPrivateDetail(runId: string, ref: string): string | null {
    this.#assertNotInTx(runId);
    assertValidRunId(runId);
    const row = this.#db
      .prepare(`SELECT content FROM private_details WHERE run_id = ? AND ref = ?`)
      .get(runId, ref) as { content: string } | undefined;
    return row ? row.content : null;
  }

  public exportProjectionLines(runId: string): string[] {
    this.#assertNotInTx(runId);
    assertValidRunId(runId);
    return this.#runInTx(() => this.#verifyHashChainInternal(runId).lines, "deferred");
  }

  public recordArtifact(params: {
    artifactId: string;
    runId: string;
    stepId: string;
    attemptId: string;
    name: string;
    contentHash: string;
    mediaType: string;
    size: number;
    deadlineMs?: number;
  }): void {
    // Major 4 (Round 10): Snapshot ALL caller-owned parameters once BEFORE ownership check & tx
    const artifactId = params.artifactId;
    const runId = params.runId;
    const stepId = params.stepId;
    const attemptId = params.attemptId;
    const name = params.name;
    const contentHash = params.contentHash;
    const mediaType = params.mediaType;
    const size = params.size;
    const deadlineMs = params.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs))) {
      throw new Error("Invalid deadlineMs: expected finite number");
    }

    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      throw new StepDeadlineExceededError(runId, deadlineMs);
    }
    if (!FlowIdRegex.test(artifactId)) {
      throw new ArtifactVerificationError(artifactId, "Invalid artifactId");
    }
    if (!FlowSha256Regex.test(contentHash)) {
      throw new ArtifactVerificationError(artifactId, "Invalid contentHash");
    }
    const verified = this.#readArtefactViaProjectDirFd(runId, contentHash);
    if (!verified || !verified.bytes) {
      throw new ArtifactVerificationError(artifactId, `Artifact file missing on disk for hash '${contentHash}'`);
    }
    if (verified.size !== size) {
      throw new ArtifactVerificationError(
        artifactId,
        `Artifact size mismatch: expected ${size}, actual ${verified.size}`
      );
    }
    const actualHash = crypto.createHash("sha256").update(verified.bytes).digest("hex");
    if (actualHash !== contentHash) {
      throw new ArtifactVerificationError(
        artifactId,
        `Artifact content hash mismatch: expected ${contentHash}, actual ${actualHash}`
      );
    }

    const now = Date.now();
    this.#runInTx(() => {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      this.#db
        .prepare(
          `INSERT INTO flow_artifacts (
             artifact_id, run_id, step_id, attempt_id, name,
             content_hash, media_type, size, created_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          artifactId,
          runId,
          stepId,
          attemptId,
          name,
          actualHash,
          mediaType,
          verified.size,
          now
        );
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      if (deadlineMs !== undefined && Date.now() > deadlineMs) {
        throw new StepDeadlineExceededError(runId, deadlineMs);
      }
    });
  }

  public writeAndRecordArtifact(params: {
    artifactId: string;
    runId: string;
    stepId: string;
    attemptId: string;
    name: string;
    mediaType: string;
    bytes: Buffer;
    deadlineMs?: number;
  }): { contentHash: string; size: number; filePath: string } {
    // Major 4 (Round 10): Snapshot ALL caller-owned parameters once BEFORE ownership check & disk I/O
    const artifactId = params.artifactId;
    const runId = params.runId;
    const stepId = params.stepId;
    const attemptId = params.attemptId;
    const name = params.name;
    const mediaType = params.mediaType;
    const bytes = Buffer.from(params.bytes);
    const deadlineMs = params.deadlineMs;
    if (deadlineMs !== undefined && (typeof deadlineMs !== "number" || !Number.isFinite(deadlineMs))) {
      throw new Error("Invalid deadlineMs: expected finite number");
    }

    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      throw new StepDeadlineExceededError(runId, deadlineMs);
    }
    if (!FlowIdRegex.test(artifactId)) {
      throw new ArtifactVerificationError(artifactId, "Invalid artifactId");
    }
    // Major 2: Verify run exists in flow_runs BEFORE creating any directories or files on disk!
    if (!this.#getRunInternal(runId)) {
      throw new ArtifactVerificationError(artifactId, `Cannot write artefact for nonexistent run '${runId}'`);
    }

    const verifiedDir = this.#verifyProjectDirHandle();
    const contentHash = crypto.createHash("sha256").update(bytes).digest("hex");
    const size = bytes.length;
    const filePath = path.join(verifiedDir, "artifacts", runId, contentHash);
    const tmpName = `${contentHash}.tmp.${crypto.randomBytes(4).toString("hex")}`;

    // Major 1: Walk strictly through held #projectDirFd -> artifacts -> runId via /proc/self/fd/<fd>/<segment>
    // with O_DIRECTORY | O_NOFOLLOW (zero qualified-pathname opens after check).
    const artifactsParentFd = openConfinedSubdirFd(this.#projectDirFd, "artifacts", { createMode: 0o700 });
    if (artifactsParentFd === null) {
      throw new Error(`Failed to open confined artifacts directory under '${verifiedDir}'`);
    }
    let dirFd: number | null = null;
    try {
      dirFd = openConfinedSubdirFd(artifactsParentFd, runId, { createMode: 0o700 });
      if (dirFd === null) {
        throw new Error(`Failed to open confined run artefact directory for '${runId}'`);
      }

      const fdDir = `/proc/self/fd/${dirFd}`;
      const fdTargetPath = `${fdDir}/${contentHash}`;
      const fdTmpPath = `${fdDir}/${tmpName}`;

      const existingTarget = fs.lstatSync(fdTargetPath, { throwIfNoEntry: false });
      if (existingTarget) {
        if (existingTarget.isSymbolicLink()) {
          throw new Error(`Symlink file forbidden: ${filePath}`);
        }
        if (!existingTarget.isFile()) {
          throw new Error(`Expected regular file (non-regular inode forbidden): ${filePath}`);
        }
        if (existingTarget.nlink > 1) {
          throw new Error(`Hard-linked file forbidden (nlink=${existingTarget.nlink}): ${filePath}`);
        }
      }

      const openFlags =
        fs.constants.O_CREAT |
        fs.constants.O_EXCL |
        fs.constants.O_WRONLY |
        (fs.constants.O_NOFOLLOW ?? 0);
      const fd = fs.openSync(fdTmpPath, openFlags, 0o600);
      try {
        try {
          fs.fchmodSync(fd, 0o600);
        } catch {
          // Ignore on filesystems without chmod support.
        }
        fs.writeSync(fd, bytes, 0, bytes.length, 0);
        fs.fsyncSync(fd);
      } catch (err) {
        try {
          fs.closeSync(fd);
        } catch {
          // ignore
        }
        try {
          fs.unlinkSync(fdTmpPath);
        } catch {
          // ignore
        }
        throw err;
      }
      fs.closeSync(fd);

      try {
        fs.renameSync(fdTmpPath, fdTargetPath);
      } catch (err) {
        try {
          fs.unlinkSync(fdTmpPath);
        } catch {
          // ignore
        }
        throw err;
      }

      const verifyFlags =
        fs.constants.O_RDONLY |
        (fs.constants.O_NOFOLLOW ?? 0) |
        (fs.constants.O_NONBLOCK ?? 0);
      const vfd = fs.openSync(fdTargetPath, verifyFlags);
      try {
        const vst = fs.fstatSync(vfd);
        if (!vst.isFile()) {
          throw new Error(`Expected regular file (non-regular inode forbidden): ${filePath}`);
        }
        if (vst.nlink > 1) {
          throw new Error(`Hard-linked file forbidden (nlink=${vst.nlink}): ${filePath}`);
        }
        try {
          fs.fchmodSync(vfd, 0o600);
        } catch {
          // Ignore on filesystems without chmod support.
        }
      } finally {
        fs.closeSync(vfd);
      }
      fs.fsyncSync(dirFd);
    } finally {
      if (dirFd !== null) fs.closeSync(dirFd);
      fs.closeSync(artifactsParentFd);
    }

    // K2 real production orphan boundary hook: SIGKILL after durable file write, BEFORE SQL receipt insert
    if (process.env["FLOW_K2_KILL_AFTER_FILE_BEFORE_RECEIPT"] === "1") {
      process.kill(process.pid, "SIGKILL");
    }

    // Major 1 (Round 11): If file write/rename/fsync overran deadlineMs, refuse SQL receipt commit!
    if (deadlineMs !== undefined && Date.now() > deadlineMs) {
      throw new StepDeadlineExceededError(runId, deadlineMs);
    }

    this.recordArtifact({
      artifactId,
      runId,
      stepId,
      attemptId,
      name,
      contentHash,
      mediaType,
      size,
      deadlineMs,
    });

    return { contentHash, size, filePath };
  }

  /**
   * Major 4: Scoped strictly by (runId, artifactId) so cross-run ambiguity is impossible.
   */
  public getArtifact(runId: string, artifactId: string): FlowArtifactRow | null {
    this.#assertNotInTx(runId);
    assertValidRunId(runId);
    const row = this.#db
      .prepare(`SELECT * FROM flow_artifacts WHERE run_id = ? AND artifact_id = ?`)
      .get(runId, artifactId);
    return (row as FlowArtifactRow) ?? null;
  }

  #listArtifactsInternal(runId: string): FlowArtifactRow[] {
    assertValidRunId(runId);
    return this.#db
      .prepare(`SELECT * FROM flow_artifacts WHERE run_id = ? ORDER BY created_at ASC`)
      .all(runId) as FlowArtifactRow[];
  }

  public listArtifacts(runId: string): FlowArtifactRow[] {
    this.#assertNotInTx(runId);
    return this.#listArtifactsInternal(runId);
  }

  public verifyHashChain(runId: string): { valid: boolean; headSeq: number; headHash: string; lines: string[]; error?: string } {
    this.#assertNotInTx(runId);
    return this.#verifyHashChainInternal(runId);
  }

  #verifyHashChainInternal(runId: string): { valid: boolean; headSeq: number; headHash: string; lines: string[]; error?: string } {
    assertValidRunId(runId);
    const events = this.#getAllEventRowsUnfiltered(runId);
    if (events.length === 0) {
      return { valid: true, headSeq: 0, headHash: "0".repeat(64), lines: [] };
    }

    let expectedPrev = "0".repeat(64);
    for (let i = 0; i < events.length; i++) {
      const row = events[i]!;
      const expectedSeq = i + 1;

      if (row.seq !== expectedSeq) {
        throw new HashChainCorruptionError(runId, row.seq, `Sequence non-contiguous: expected ${expectedSeq}, got ${row.seq}`);
      }
      if (row.prev_hash !== expectedPrev) {
        throw new HashChainCorruptionError(runId, row.seq, `Previous hash mismatch: expected ${expectedPrev}, got ${row.prev_hash}`);
      }
      const calculatedHash = crypto.createHash("sha256").update(row.line, "utf8").digest("hex");
      if (row.hash !== calculatedHash) {
        throw new HashChainCorruptionError(runId, row.seq, `Stored hash mismatch: stored ${row.hash}, calculated ${calculatedHash}`);
      }

      let parsedRaw: unknown;
      try {
        parsedRaw = JSON.parse(row.line);
      } catch {
        throw new HashChainCorruptionError(runId, row.seq, "Event line is not valid JSON");
      }
      const parsedResult = FlowEventSchema.safeParse(parsedRaw);
      if (!parsedResult.success) {
        throw new HashChainCorruptionError(runId, row.seq, "Event line fails schema validation");
      }
      const env = parsedResult.data;

      if (row.line !== canonicalJsonStringify(env)) {
        throw new HashChainCorruptionError(runId, row.seq, "Stored event line does not match canonical JSON serialization");
      }
      if (env.runId !== runId) {
        throw new HashChainCorruptionError(runId, row.seq, `Envelope runId mismatch: SQL run_id '${runId}', envelope runId '${env.runId}'`);
      }
      if (env.seq !== row.seq) {
        throw new HashChainCorruptionError(runId, row.seq, `Envelope seq mismatch: SQL seq ${row.seq}, envelope seq ${env.seq}`);
      }
      if (env.prev !== row.prev_hash) {
        throw new HashChainCorruptionError(runId, row.seq, `Envelope prev mismatch: SQL prev_hash '${row.prev_hash}', envelope prev '${env.prev}'`);
      }
      if (env.type !== row.event_type) {
        throw new HashChainCorruptionError(runId, row.seq, `Envelope type mismatch: SQL event_type '${row.event_type}', envelope type '${env.type}'`);
      }
      if (env.type !== row.phase) {
        throw new HashChainCorruptionError(runId, row.seq, `Envelope phase mismatch: SQL phase '${row.phase}', envelope type '${env.type}'`);
      }
      const envStepId = "stepId" in env ? env.stepId : "flow";
      const envAttemptId = "attemptId" in env ? env.attemptId : "0";
      if (envStepId !== row.step_id) {
        throw new HashChainCorruptionError(runId, row.seq, `Envelope stepId mismatch: SQL step_id '${row.step_id}', envelope stepId '${envStepId}'`);
      }
      if (envAttemptId !== row.attempt_id) {
        throw new HashChainCorruptionError(runId, row.seq, `Envelope attemptId mismatch: SQL attempt_id '${row.attempt_id}', envelope attemptId '${envAttemptId}'`);
      }

      expectedPrev = row.hash;
    }

    const lastEvent = events[events.length - 1]!;
    return { valid: true, headSeq: lastEvent.seq, headHash: lastEvent.hash, lines: events.map((e) => e.line) };
  }

  public checkpointPassive(): void {
    this.#assertWritableAndOwned();
    this.#db.pragma("wal_checkpoint(PASSIVE)");
  }

  public purgeRun(runId: string): void {
    this.#assertWritableAndOwned(runId);
    assertValidRunId(runId);
    const verifiedDir = this.#verifyProjectDirHandle();
    const artifactsDir = path.join(verifiedDir, "artifacts", runId);
    assertNoSymlinkInChain(artifactsDir, verifiedDir, { mustBeStrictDescendant: true });

    this.#db.pragma("secure_delete = ON");
    const secureVal = this.#db.pragma("secure_delete", { simple: true });
    if (secureVal !== 1) {
      throw new PurgeIncompleteError(runId, `Failed to enable PRAGMA secure_delete = ON (got ${secureVal})`);
    }

    this.#runInTx(() => {
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
      this.#db.prepare(`DELETE FROM private_details WHERE run_id = ?`).run(runId);
      this.#db.prepare(`DELETE FROM flow_artifacts WHERE run_id = ?`).run(runId);
      this.#db.prepare(`DELETE FROM flow_events WHERE run_id = ?`).run(runId);
      this.#db.prepare(`DELETE FROM flow_runs WHERE run_id = ?`).run(runId);
      assertActiveOwnerLock(this.#ownerLock, this.projectId, this.projectDir);
    });

    const cpRows = (() => {
      this.#db.pragma("busy_timeout = 50");
      try {
        return this.#db.pragma("wal_checkpoint(TRUNCATE)") as Array<{
          busy: number;
          log: number;
          checkpointed: number;
        }>;
      } finally {
        this.#db.pragma("busy_timeout = 5000");
      }
    })();
    const cp = cpRows[0];
    if (!cp || cp.busy !== 0 || cp.log !== cp.checkpointed) {
      throw new PurgeIncompleteError(
        runId,
        `WAL checkpoint(TRUNCATE) could not clear WAL frames (busy=${cp?.busy}, log=${cp?.log}, checkpointed=${cp?.checkpointed})`
      );
    }

    // Major 1: Walk strictly through held #projectDirFd -> artifacts -> runId via /proc/self/fd/<fd>/<segment>
    // with O_DIRECTORY | O_NOFOLLOW (zero qualified-pathname opens after check).
    this.#verifyProjectDirHandle();
    const artifactsParentFd = openConfinedSubdirFd(this.#projectDirFd, "artifacts", { allowMissing: true });
    if (artifactsParentFd !== null) {
      try {
        const dirFd = openConfinedSubdirFd(artifactsParentFd, runId, { allowMissing: true });
        if (dirFd !== null) {
          try {
            const fdDir = `/proc/self/fd/${dirFd}`;
            for (const entry of fs.readdirSync(fdDir)) {
              if (entry.includes("/") || entry === "." || entry === "..") {
                throw new Error(`Refusing to purge unexpected artefact entry: ${entry}`);
              }
              const fdEntry = `${fdDir}/${entry}`;
              const entryStat = fs.lstatSync(fdEntry, { throwIfNoEntry: false });
              if (entryStat?.isFile() && !entryStat.isSymbolicLink()) {
                fs.unlinkSync(fdEntry);
              } else if (entryStat) {
                throw new Error(`Refusing to purge unexpected non-file artefact entry: ${entry}`);
              }
            }
            fs.fsyncSync(dirFd);
          } finally {
            fs.closeSync(dirFd);
          }
          const fdRunDir = `/proc/self/fd/${artifactsParentFd}/${runId}`;
          const runDirStat = fs.lstatSync(fdRunDir, { throwIfNoEntry: false });
          if (runDirStat && !runDirStat.isSymbolicLink() && runDirStat.isDirectory()) {
            fs.rmdirSync(fdRunDir);
            fs.fsyncSync(artifactsParentFd);
          }
        }
      } finally {
        fs.closeSync(artifactsParentFd);
      }
    }
  }

  public close(): void {
    // Major 3 (Round 10): Prevent re-entrant close() while a SQLite transaction is open
    this.#assertNotInTx();
    if (this.#closed) return;
    this.#closed = true;
    const next = Math.max(0, (openDbCounts.get(this.#dbKey) ?? 1) - 1);
    if (next === 0) openDbCounts.delete(this.#dbKey);
    else openDbCounts.set(this.#dbKey, next);
    try {
      this.#db.close();
    } catch {
      // ignore if already closed
    }
    try {
      fs.closeSync(this.#projectDirFd);
    } catch {
      // ignore
    }
  }
}

export type FlowsStore = FlowsStoreImpl;

export function openFlowsStore(
  projectId: string,
  options?: { dataRoot?: string; readonly?: boolean; ownerLock?: OwnerLock }
): FlowsStore {
  const flowsRoot = resolveFlowsRootDir(options?.dataRoot);
  const projectDir = resolveProjectDataDir(projectId, options?.dataRoot);
  return new FlowsStoreImpl(projectId, projectDir, flowsRoot, options?.dataRoot, {
    readonly: options?.readonly,
    ownerLock: options?.ownerLock,
  });
}
