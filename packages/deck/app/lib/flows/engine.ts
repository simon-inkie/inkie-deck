/**
 * engine.ts - Pure rules-only decision engine for Deck Flows Slice 2.
 *
 * ZERO .server or Node imports - safe for both client and server bundles.
 * Implements:
 * - Monotonic outcome lattice: continue < notify < decide < stop.
 * - Flow limit resolution (maxAttempts, maxRewinds, sameCheckFailLimit, stepTimeoutMin, budget).
 * - Protected-path glob matcher (**, *, ?).
 * - Deterministic 4-stage rule evaluation covering Scenarios 1-20.
 *
 * ASCII only - no em-dashes.
 */

import { resolvePinnedBudget } from "./replay.js";
import type {
  FlowDefinition,
  FlowReasonCode,
  FlowRuleHit,
  FlowStep,
  HandoffStep,
} from "./types.js";

export type FlowJudgementOutcome = "continue" | "notify" | "decide" | "stop";

export const OUTCOME_RANK: Readonly<Record<FlowJudgementOutcome, number>> = {
  continue: 0,
  notify: 1,
  decide: 2,
  stop: 3,
};

export const DEFAULT_MAX_FILES_CHANGED = 15;

export function getHandoffOptionKeys(step: HandoffStep): string[] {
  const declared = Object.values(step.returns ?? {}).flat();
  const keys = declared.length > 0 ? declared : ["approve", "changes", "comment"];
  return [...new Set(keys)].slice(0, 16);
}

export interface ResolvedFlowLimits {
  maxAttempts: number;
  maxRewinds: number;
  sameCheckFailLimit: number;
  stepTimeoutMin: number;
  budget: { tokens: number; steps: number };
}

export interface StepSignals {
  /** Scenario 4: test deleted, skipped, or assertion count lowered */
  testWeakened?: boolean;
  /** Scenario 13: leak scan or security finding */
  secretFound?: boolean;
  /** Scenario 5: changed file paths checked against flow.protected_paths */
  changedFiles?: readonly string[];
  /** Scenario 6: dependency added or bumped in manifest/lockfile */
  dependencyChanged?: boolean;
  /** Scenario 15: files changed count (falls back to changedFiles.length) */
  filesChangedCount?: number;
  /** Scenario 15: override max files changed threshold (default 15) */
  maxFilesChanged?: number;
  /** Scenario 15: changes outside ticket area */
  scopeDrift?: boolean;
  /** Scenario 10: ticket lacks repro steps or acceptance criteria */
  ticketCriteriaMissing?: boolean;
  /** Scenario 11: agent asks a question or emits a decision event */
  agentQuestion?: boolean;
  /** Scenario 12: merge/rebase conflict with base */
  mergeConflict?: "none" | "in_scope" | "out_of_scope";
  /** Scenario 14: number of flaky flips detected (1 -> notify, >=2 -> decide) */
  flakyFlipCount?: number;
  /** Scenario 16: consecutive count of claimed output missing (1 -> rewind, >=2 -> decide) */
  claimedOutputMissingCount?: number;
  /** Scenario 17: pass result is for a stale SHA rather than head_sha */
  staleSha?: boolean;
  /** Scenario 19: review comment arrived */
  reviewComment?: "none" | "comment" | "changes_requested";
  /** Scenario 20: flow includes human acceptance criteria gate */
  hasHumanCriteria?: boolean;
  /** Optional explicit step timeout signal */
  stepTimedOut?: boolean;
  /** Optional override for same-check repeat failure count */
  sameCheckFailCount?: number;
}

export interface EvaluateStepJudgementInput {
  flow: FlowDefinition;
  step: FlowStep;
  occurrence: number;
  rewindsUsed: number;
  outcome: "passed" | "failed" | "unknown";
  errorCode?: "timeout" | "execution_error" | "budget_exceeded" | "check_failed";
  budgetUsed: { tokens: number; steps: number };
  sameCheckFailCount?: number;
  signals?: StepSignals;
}

export interface StepJudgementDecision {
  final: FlowJudgementOutcome;
  ruleHits: FlowRuleHit[];
  reasonCodes: FlowReasonCode[];
  engineTokens: number;
  shouldRewind: boolean;
  shouldRerunCheck: boolean;
  rewindTargetStepId?: string;
}

/**
 * Return the highest-severity outcome in the monotonic lattice
 * continue < notify < decide < stop.
 */
export function maxOutcome(
  ...outcomes: Array<FlowJudgementOutcome | undefined>
): FlowJudgementOutcome {
  let best: FlowJudgementOutcome = "continue";
  for (const candidate of outcomes) {
    if (candidate && OUTCOME_RANK[candidate] > OUTCOME_RANK[best]) {
      best = candidate;
    }
  }
  return best;
}

/**
 * Enforce a monotonic floor over a candidate outcome so nothing
 * (including permissive step rules or future classifiers) can lower an outcome.
 */
export function applyMonotonicFloor(
  candidate: FlowJudgementOutcome,
  ...floors: Array<FlowJudgementOutcome | undefined>
): FlowJudgementOutcome {
  return maxOutcome(candidate, ...floors);
}

/**
 * Resolve flow-level execution limits with v1 spec defaults.
 */
export function resolveFlowLimits(flow: FlowDefinition): ResolvedFlowLimits {
  return {
    maxAttempts: flow.limits?.max_attempts ?? 3,
    maxRewinds: flow.limits?.max_rewinds ?? 6,
    sameCheckFailLimit: flow.limits?.same_check_fail_limit ?? 3,
    stepTimeoutMin: flow.limits?.step_timeout_min ?? 30,
    budget: resolvePinnedBudget(flow),
  };
}

function normalizePosixPath(rawPath: string): string {
  let normalized = rawPath.replace(/\\/g, "/").replace(/\/+/g, "/");
  while (normalized.startsWith("./")) {
    normalized = normalized.slice(2);
  }
  if (normalized.startsWith("/")) {
    normalized = normalized.slice(1);
  }
  return normalized;
}

function compileGlobRegex(pattern: string): RegExp {
  const norm = normalizePosixPath(pattern);
  let regexStr = "^";
  let i = 0;
  while (i < norm.length) {
    const ch = norm[i]!;
    if (ch === "*") {
      if (norm[i + 1] === "*") {
        if (norm[i + 2] === "/") {
          regexStr += "(?:.*/)?";
          i += 3;
        } else {
          regexStr += ".*";
          i += 2;
        }
      } else {
        regexStr += "[^/]*";
        i += 1;
      }
    } else if (ch === "?") {
      regexStr += "[^/]";
      i += 1;
    } else {
      regexStr += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i += 1;
    }
  }
  regexStr += "$";
  return new RegExp(regexStr);
}

/**
 * Match a repository-relative file path against protected_paths glob patterns
 * supporting `**`, `*`, `?`, and leading `./` normalization.
 */
export function matchesProtectedPath(
  filePath: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false;
  const normalizedFile = normalizePosixPath(filePath);
  if (!normalizedFile) return false;
  for (const pattern of patterns) {
    if (!pattern) continue;
    const re = compileGlobRegex(pattern);
    if (re.test(normalizedFile)) {
      return true;
    }
  }
  return false;
}

function getConfiguredRuleOutcome(
  step: FlowStep,
  ruleName: string,
): FlowJudgementOutcome | undefined {
  if (!step.rules) return undefined;
  let configured: FlowJudgementOutcome | undefined;
  for (const entry of step.rules) {
    if (Object.hasOwn(entry, ruleName)) {
      const val = entry[ruleName];
      if (val === "continue" || val === "notify" || val === "decide" || val === "stop") {
        configured = configured ? maxOutcome(configured, val) : val;
      }
    }
  }
  return configured;
}

function addUnique<T>(list: T[], item: T): void {
  if (!list.includes(item)) {
    list.push(item);
  }
}

/**
 * Pure deterministic rules-only judgement evaluator.
 *
 * Evaluation order:
 * 1) Safety & ceiling floor (unknown -> stop, budget exceeded -> stop, secretFound -> stop, testWeakened -> stop)
 * 2) Limits (sameCheckFailCount >= sameCheckFailLimit -> decide, maxAttempts / maxRewinds on failure -> decide, budget >= 80% -> notify)
 * 3) Step `rules:` configured floor, combined strictly via maxOutcome (never lowers safety/limit outcomes)
 * 4) Deterministic scenario triggers for Scenarios 1-20
 */
export function evaluateStepJudgement(
  input: EvaluateStepJudgementInput,
): StepJudgementDecision {
  const { flow, step, occurrence, rewindsUsed, outcome, errorCode, budgetUsed } = input;
  const signals = input.signals ?? {};
  const limits = resolveFlowLimits(flow);
  const sameCheckFailCount = signals.sameCheckFailCount ?? input.sameCheckFailCount ?? 0;

  let safetyAndLimitFloor: FlowJudgementOutcome = "continue";
  let triggeredOutcome: FlowJudgementOutcome = "continue";
  const ruleHits: FlowRuleHit[] = [];
  const reasonCodes: FlowReasonCode[] = [];

  const applyTriggeredRule = (
    ruleName: string,
    builtInOutcome: FlowJudgementOutcome,
    hit: FlowRuleHit,
    reason: FlowReasonCode,
    isSafetyOrLimit = false,
  ) => {
    const ruleFloor = getConfiguredRuleOutcome(step, ruleName);
    const effective = maxOutcome(builtInOutcome, ruleFloor);
    if (isSafetyOrLimit) {
      safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, builtInOutcome);
    }
    triggeredOutcome = maxOutcome(triggeredOutcome, effective);
    addUnique(ruleHits, hit);
    addUnique(reasonCodes, reason);
  };

  // -------------------------------------------------------------------------
  // 1) Safety & ceiling floor
  // -------------------------------------------------------------------------
  if (outcome === "unknown") {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "stop");
    triggeredOutcome = maxOutcome(triggeredOutcome, "stop");
    addUnique(ruleHits, "recovery_unknown_outcome");
    addUnique(reasonCodes, "crash_during_execution");
  }

  const budgetExceeded =
    errorCode === "budget_exceeded" ||
    budgetUsed.tokens > limits.budget.tokens ||
    budgetUsed.steps > limits.budget.steps;
  if (budgetExceeded) {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "stop");
    triggeredOutcome = maxOutcome(triggeredOutcome, "stop");
    addUnique(ruleHits, "budget_exceeded");
    addUnique(reasonCodes, "budget_exceeded");
  }

  if (signals.secretFound) {
    applyTriggeredRule("secret_found", "stop", "secret_found", "secret_found", true);
  }

  if (signals.testWeakened) {
    applyTriggeredRule("test_weakened", "stop", "test_weakened", "test_weakened", true);
  }

  // -------------------------------------------------------------------------
  // 2) Limits
  // -------------------------------------------------------------------------
  if (sameCheckFailCount >= limits.sameCheckFailLimit) {
    applyTriggeredRule(
      "same_check_repeat",
      "decide",
      "same_check_repeat",
      "same_check_repeat",
      true,
    );
  }

  if (outcome === "failed") {
    if (occurrence >= limits.maxAttempts) {
      applyTriggeredRule("loop_count", "decide", "loop_count", "max_attempts_reached", true);
    }
    if (rewindsUsed >= limits.maxRewinds) {
      applyTriggeredRule("loop_count", "decide", "loop_count", "max_rewinds_reached", true);
    }
  }

  const budgetNear =
    !budgetExceeded &&
    ((limits.budget.tokens > 0 && budgetUsed.tokens >= limits.budget.tokens * 0.8) ||
      (limits.budget.steps > 0 && budgetUsed.steps >= limits.budget.steps * 0.8));
  if (budgetNear) {
    applyTriggeredRule("budget_near", "notify", "budget_near", "budget_near", true);
  }

  // -------------------------------------------------------------------------
  // 3) Step timeout (Scenario 9: decide when { step_timeout: decide } declared, else stop)
  // -------------------------------------------------------------------------
  if (errorCode === "timeout" || signals.stepTimedOut) {
    const configuredTimeout = getConfiguredRuleOutcome(step, "step_timeout");
    const timeoutOutcome: FlowJudgementOutcome =
      configuredTimeout === "decide" ? "decide" : "stop";
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, timeoutOutcome);
    triggeredOutcome = maxOutcome(triggeredOutcome, timeoutOutcome);
    addUnique(ruleHits, "step_timeout");
    addUnique(reasonCodes, "timeout");
  }

  // -------------------------------------------------------------------------
  // 4) Deterministic scenario triggers (Scenarios 5, 6, 10-20)
  // -------------------------------------------------------------------------
  if (
    signals.changedFiles &&
    signals.changedFiles.some((f) => matchesProtectedPath(f, flow.protected_paths))
  ) {
    applyTriggeredRule(
      "protected_path_touched",
      "decide",
      "protected_path_touched",
      "protected_path_touched",
    );
  }

  if (signals.dependencyChanged) {
    applyTriggeredRule(
      "dependency_changed",
      "decide",
      "dependency_changed",
      "dependency_changed",
    );
  }

  if (signals.ticketCriteriaMissing) {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "decide");
    triggeredOutcome = maxOutcome(triggeredOutcome, "decide");
    addUnique(ruleHits, "ticket_ambiguous");
    addUnique(reasonCodes, "ambiguous_ticket");
  }

  if (signals.agentQuestion) {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "decide");
    triggeredOutcome = maxOutcome(triggeredOutcome, "decide");
    addUnique(ruleHits, "agent_question");
    addUnique(reasonCodes, "question_to_human");
  }

  if (signals.mergeConflict === "in_scope") {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "notify");
    triggeredOutcome = maxOutcome(triggeredOutcome, "notify");
    addUnique(ruleHits, "merge_conflict");
    addUnique(reasonCodes, "merge_conflict");
  } else if (signals.mergeConflict === "out_of_scope") {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "decide");
    triggeredOutcome = maxOutcome(triggeredOutcome, "decide");
    addUnique(ruleHits, "merge_conflict");
    addUnique(reasonCodes, "merge_conflict_out_of_scope");
  }

  const flakyFlipCount = signals.flakyFlipCount ?? 0;
  if (flakyFlipCount >= 2) {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "decide");
    triggeredOutcome = maxOutcome(triggeredOutcome, "decide");
    addUnique(ruleHits, "flaky_suspected");
    addUnique(reasonCodes, "flaky_repeated");
  } else if (flakyFlipCount === 1) {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "notify");
    triggeredOutcome = maxOutcome(triggeredOutcome, "notify");
    addUnique(ruleHits, "flaky_suspected");
    addUnique(reasonCodes, "flaky_suspected");
  }

  const maxFiles = signals.maxFilesChanged ?? DEFAULT_MAX_FILES_CHANGED;
  const filesCount = signals.filesChangedCount ?? signals.changedFiles?.length ?? 0;
  if (filesCount > maxFiles || signals.scopeDrift) {
    const reason: FlowReasonCode = signals.scopeDrift ? "scope_drift" : "files_changed_over";
    applyTriggeredRule("files_changed_over", "decide", "files_changed_over", reason);
  }

  let shouldRewind = false;
  let shouldRerunCheck = false;
  let rewindTargetStepId: string | undefined;

  const missingCount = signals.claimedOutputMissingCount ?? 0;
  if (missingCount >= 2) {
    applyTriggeredRule(
      "claimed_output_missing",
      "decide",
      "claimed_output_missing",
      "claimed_output_missing",
      true,
    );
  } else if (missingCount === 1) {
    if (occurrence >= limits.maxAttempts || rewindsUsed >= limits.maxRewinds) {
      applyTriggeredRule(
        "claimed_output_missing",
        "decide",
        "claimed_output_missing",
        "claimed_output_missing",
        true,
      );
    } else {
      applyTriggeredRule(
        "claimed_output_missing",
        "continue",
        "claimed_output_missing",
        "claimed_output_missing",
      );
      shouldRewind = true;
      rewindTargetStepId = step.id;
    }
  }

  if (signals.staleSha) {
    if (occurrence >= limits.maxAttempts || rewindsUsed >= limits.maxRewinds) {
      applyTriggeredRule("stale_sha", "decide", "stale_sha", "stale_sha", true);
    } else {
      applyTriggeredRule("stale_sha", "continue", "stale_sha", "stale_sha");
      shouldRerunCheck = true;
      shouldRewind = true;
      rewindTargetStepId = step.id;
    }
  }

  if (signals.reviewComment === "comment" || signals.reviewComment === "changes_requested") {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "notify");
    triggeredOutcome = maxOutcome(triggeredOutcome, "notify");
    addUnique(ruleHits, "review_comment");
    addUnique(reasonCodes, "review_comment");
  }

  if (outcome === "passed" && signals.hasHumanCriteria) {
    safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "decide");
    triggeredOutcome = maxOutcome(triggeredOutcome, "decide");
    addUnique(ruleHits, "human_gate");
    addUnique(reasonCodes, "human_gate");
  }

  // Handle ordinary failure (Scenario 1 check on_fail rewind vs Slice 1a stop without on_fail)
  if (outcome === "failed" && errorCode !== "timeout" && !budgetExceeded) {
    const canRewindCheck =
      step.type === "check" &&
      Boolean(step.on_fail?.goto) &&
      occurrence < limits.maxAttempts &&
      rewindsUsed < limits.maxRewinds &&
      sameCheckFailCount < limits.sameCheckFailLimit;

    if (canRewindCheck && step.type === "check" && step.on_fail?.goto) {
      addUnique(ruleHits, "check_failed");
      addUnique(reasonCodes, "on_fail_rewind");
      if (OUTCOME_RANK[applyMonotonicFloor(triggeredOutcome, safetyAndLimitFloor)] < OUTCOME_RANK["decide"]) {
        shouldRewind = true;
        rewindTargetStepId = step.on_fail.goto;
      }
    } else if (missingCount === 0 && OUTCOME_RANK[applyMonotonicFloor(triggeredOutcome, safetyAndLimitFloor)] < OUTCOME_RANK["decide"]) {
      // Slice 1a default when a step fails without an on_fail rewind path
      safetyAndLimitFloor = maxOutcome(safetyAndLimitFloor, "stop");
      triggeredOutcome = maxOutcome(triggeredOutcome, "stop");
      addUnique(ruleHits, step.type === "check" ? "check_failed" : "step_failed_recovery");
      addUnique(reasonCodes, errorCode ?? "execution_error");
    }
  }

  const final = applyMonotonicFloor(triggeredOutcome, safetyAndLimitFloor);
  if (OUTCOME_RANK[final] >= OUTCOME_RANK["decide"]) {
    shouldRewind = false;
    shouldRerunCheck = false;
    rewindTargetStepId = undefined;
  }

  if (final === "continue" && !shouldRewind && !shouldRerunCheck) {
    ruleHits.length = 0;
    reasonCodes.length = 0;
    ruleHits.push(step.type === "check" ? "check_passed" : "step_passed");
    reasonCodes.push("ok");
  } else if (ruleHits.length === 0) {
    ruleHits.push(step.type === "check" ? "check_passed" : "step_passed");
    reasonCodes.push("ok");
  }

  return {
    final,
    ruleHits,
    reasonCodes,
    engineTokens: 0,
    shouldRewind,
    shouldRerunCheck,
    ...(rewindTargetStepId !== undefined ? { rewindTargetStepId } : {}),
  };
}
