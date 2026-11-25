/**
 * Pure state reducer for Deck structured task flows.
 *
 * Enforces replay rules:
 * - Pure, deterministic fold over verified facts (events, flow, verified artefacts).
 * - Zero I/O, zero network, zero model or tool calls.
 * - Consumes recorded judgements; never rejudges or re-evaluates rules.
 * - Monotonic budget tracking (steps and tokens) with ceiling enforcement.
 * - Preserves execution provenance: runPlanned, step attempts, artefacts, and terminal reason.
 * - Strict halt transitions: once waiting_decision, stopped, or finished, no further execution allowed.
 */

import {
  FlowSha256Regex,
  type CheckStep,
  type FlowDefinition,
  type FlowEvent,
  type FlowRunState,
  type StepState,
  type AttemptState,
} from "./types.js";

export interface ResolvedCheckTarget {
  artefactId: string;
  stepId: string;
  attemptId: string;
  occurrence: number;
  sha256: string;
  sizeBytes: number;
}

/**
 * Authoritative pinned budget derived solely from the approved flow definition.
 * Neither append nor replay may let run_started.data.budget replace this ceiling.
 */
export function resolvePinnedBudget(flow: FlowDefinition): { tokens: number; steps: number } {
  return {
    tokens: flow.limits?.budget?.tokens ?? 1000000,
    steps: flow.limits?.budget?.steps ?? 100,
  };
}

/**
 * ONE authoritative pinned check-target resolver shared by BOTH store.server.ts and runner.server.ts.
 *
 * Enforces:
 * - Strict event-log ordering (never Object.entries numeric-key reordering).
 * - Strictly bound to the latest SUCCEEDED occurrence (`step_result`) of the producing step
 *   (failed, unsettled, or superseded occurrences can NEVER be certified).
 * - Named targets match strictly by producing stepId + SQL receipt output name.
 */
export function resolvePinnedCheckTarget(
  step: CheckStep,
  events: readonly FlowEvent[],
  receiptNameById: ReadonlyMap<string, string>,
  flow?: FlowDefinition,
): ResolvedCheckTarget | undefined {
  const latestSucceededAttemptByStep = new Map<string, string>();
  const occurrenceByAttempt = new Map<string, number>();
  const recorded: ResolvedCheckTarget[] = [];

  for (const ev of events) {
    if (ev.type === "step_started") {
      latestSucceededAttemptByStep.delete(ev.stepId);
      occurrenceByAttempt.set(`${ev.stepId}:${ev.attemptId}`, ev.data.occurrence);
    } else if (ev.type === "step_failed" || ev.type === "step_outcome_unknown") {
      latestSucceededAttemptByStep.delete(ev.stepId);
    } else if (ev.type === "step_result") {
      latestSucceededAttemptByStep.set(ev.stepId, ev.attemptId);
    } else if (ev.type === "artefact_recorded") {
      recorded.push({
        artefactId: ev.data.artefactId,
        stepId: ev.stepId,
        attemptId: ev.attemptId,
        occurrence: occurrenceByAttempt.get(`${ev.stepId}:${ev.attemptId}`) ?? 0,
        sha256: ev.data.sha256,
        sizeBytes: ev.data.sizeBytes,
      });
    }
  }

  let eligible = recorded.filter(
    (r) => latestSucceededAttemptByStep.get(r.stepId) === r.attemptId,
  );
  // Major 3 (Round 12): Scope BOTH explicit (e.g. unqualified `against: output_file`) AND implicit
  // check targets strictly to steps preceding this check in flow.steps so a later step
  // (e.g. generate -> verify -> package both declaring output_file) NEVER rebinds verify at finish!
  if (flow) {
    const checkIdx = flow.steps.findIndex((s) => s.id === step.id);
    if (checkIdx !== -1) {
      const stepIdxById = new Map(flow.steps.map((s, idx) => [s.id, idx]));
      eligible = eligible.filter((r) => {
        const prodIdx = stepIdxById.get(r.stepId);
        return prodIdx !== undefined && prodIdx < checkIdx;
      });
    }
  }
  if (eligible.length === 0) return undefined;

  if (step.against) {
    if (FlowSha256Regex.test(step.against)) {
      for (let i = eligible.length - 1; i >= 0; i--) {
        if (eligible[i]!.sha256 === step.against) return eligible[i];
      }
      return undefined;
    }
    const dotIdx = step.against.indexOf(".");
    const expectedStepId = dotIdx !== -1 ? step.against.slice(0, dotIdx) : undefined;
    const expectedName = dotIdx !== -1 ? step.against.slice(dotIdx + 1) : step.against;
    for (let i = eligible.length - 1; i >= 0; i--) {
      const r = eligible[i]!;
      if (expectedStepId && r.stepId !== expectedStepId) continue;
      if (receiptNameById.get(r.artefactId) === expectedName) {
        return r;
      }
    }
    return undefined;
  }

  return eligible[eligible.length - 1];
}

export function reduceFlowRun(
  flow: FlowDefinition,
  events: FlowEvent[],
  verifiedArtefacts: Map<string, number> | Set<string>
): FlowRunState {
  const initialBudget = resolvePinnedBudget(flow);

  const state: FlowRunState = {
    runId: events[0]?.runId ?? "uninitialized",
    status: "planned",
    currentStepId: null,
    currentAttemptId: null,
    activeDecision: null,
    activeHandoff: null,
    closedHandoffIds: [],
    rewindsUsed: 0,
    lastRewind: null,
    nextStepId: null,
    stepStates: Object.create(null) as Record<string, StepState>,
    budgetUsed: { tokens: 0, steps: 0 },
    budgetRemaining: { ...initialBudget },
    recordedArtefacts: Object.create(null) as FlowRunState["recordedArtefacts"],
    runPlanned: null,
    terminalOutcome: null,
    terminalReason: null,
  };

  let runStartedSeen = false;

  function hasVerifiedArtefact(artefactId: string, sha: string, size?: number): boolean {
    if (verifiedArtefacts instanceof Map) {
      const boundKey = `${artefactId}:${sha}`;
      if (verifiedArtefacts.has(boundKey)) {
        return size === undefined ? true : verifiedArtefacts.get(boundKey) === size;
      }
      // Fallback for legacy/pure sha-only map callers when no bound keys are used
      const hasBoundEntries = Array.from(verifiedArtefacts.keys()).some((k) => k.includes(":"));
      if (hasBoundEntries) return false;
      if (!verifiedArtefacts.has(sha)) return false;
      return size === undefined ? true : verifiedArtefacts.get(sha) === size;
    }
    return verifiedArtefacts.has(`${artefactId}:${sha}`) || verifiedArtefacts.has(sha);
  }

  for (const event of events) {
    // If run is already terminal or halted at a decision, execution events cannot proceed
    if (state.status === "finished" || state.status === "stopped" || state.status === "waiting_decision") {
      // Once halted, neither run_started nor any step execution event can reopen execution
      if (
        event.type === "run_started" ||
        event.type === "step_started" ||
        event.type === "artefact_recorded" ||
        event.type === "step_result" ||
        event.type === "step_failed" ||
        event.type === "check_result"
      ) {
        // Disallowed execution continuation after halt
        continue;
      }
      if (
        (state.status === "finished" || state.status === "stopped") &&
        (event.type === "judgement" ||
          event.type === "handoff_sent" ||
          event.type === "handoff_returned" ||
          event.type === "handoff_cancelled" ||
          event.type === "step_rewound")
      ) {
        continue;
      }
    }

    switch (event.type) {
      case "run_planned": {
        state.status = "planned";
        state.runPlanned = {
          flowRef: event.data.flowRef,
          flowHash: event.data.flowHash,
          source: event.data.source,
          expectedDecisions: [...event.data.expectedDecisions],
        };
        break;
      }

      case "flow_approved": {
        state.status = "approved";
        break;
      }

      case "run_started": {
        // Major 3: budget comes ONLY from the pinned approved flow definition, never run_started.data.budget
        if (runStartedSeen) break;
        runStartedSeen = true;
        state.status = "running";
        break;
      }

      case "step_started": {
        // Major 2: a 1-step budget allows 1 step to execute and finish; only exceeding it halts with ceiling_reached
        if (state.budgetRemaining.steps <= 0) {
          state.status = "stopped";
          state.terminalOutcome = "stopped";
          state.terminalReason = "ceiling_reached";
          return state;
        }

        state.status = "running";
        state.currentStepId = event.stepId ?? null;
        state.currentAttemptId = event.attemptId ?? null;
        state.nextStepId = null;

        const stepId = event.stepId ?? "unknown";
        const attemptId = event.attemptId ?? `${stepId}/${event.data.occurrence}`;

        const existingStep = Object.hasOwn(state.stepStates, stepId)
          ? state.stepStates[stepId]!
          : {
              occurrence: 0,
              status: "pending" as const,
              outputs: Object.create(null) as Record<string, string>,
              attempts: Object.create(null) as Record<string, AttemptState>,
            };

        const attemptRecord: AttemptState = {
          occurrence: event.data.occurrence,
          status: "running",
          tokensUsed: 0,
          wallTimeMs: 0,
          outputs: Object.create(null) as Record<string, string>,
        };

        const nextAttempts = Object.assign(
          Object.create(null) as Record<string, AttemptState>,
          existingStep.attempts,
        );
        nextAttempts[attemptId] = attemptRecord;

        state.stepStates[stepId] = {
          ...existingStep,
          occurrence: event.data.occurrence,
          status: "running",
          lastJudgement: undefined,
          attempts: nextAttempts,
        };

        // Critical 2 (Round 10): Starting a new occurrence of a step invalidates all downstream
        // steps (e.g. checks that previously passed against an earlier superseded occurrence).
        const startedIdx = flow.steps.findIndex((s) => s.id === stepId);
        if (startedIdx !== -1) {
          for (let j = startedIdx + 1; j < flow.steps.length; j++) {
            const downstreamId = flow.steps[j]!.id;
            if (Object.hasOwn(state.stepStates, downstreamId)) {
              state.stepStates[downstreamId] = {
                ...state.stepStates[downstreamId]!,
                status: "pending",
                lastJudgement: undefined,
              };
            }
          }
        }

        // Charge step budget
        state.budgetUsed.steps += 1;
        state.budgetRemaining.steps -= 1;
        break;
      }

      case "artefact_recorded": {
        const { artefactId, sha256, sizeBytes } = event.data;

        // Invariant: declared artefact MUST exist in verifiedArtefacts bound to artefactId with matching size
        if (!hasVerifiedArtefact(artefactId, sha256, sizeBytes)) {
          state.status = "waiting_decision";
          state.activeDecision = {
            stepId: event.stepId ?? "unknown",
            reasonCode: "artefact_missing",
            options: [
              { key: "retry", label: "Retry step" },
              { key: "stop", label: "Stop run", end: "stopped" },
            ],
          };
          return state;
        }

        state.recordedArtefacts[artefactId] = { sha256, sizeBytes, stepId: event.stepId };
        break;
      }

      case "check_result": {
        // Check result records verification evidence; step/attempt settles on step_result or step_failed.
        break;
      }

      case "step_result": {
        const stepId = event.stepId ?? "unknown";
        const attemptId = event.attemptId;
        const step = Object.hasOwn(state.stepStates, stepId) ? state.stepStates[stepId] : undefined;
        const cleanOutputs = Object.create(null) as Record<string, string>;
        for (const [k, v] of Object.entries(event.data.outputs)) {
          if (typeof v === "string") cleanOutputs[k] = v;
        }
        if (step) {
          step.status = "passed";
          step.outputs = Object.assign(Object.create(null) as Record<string, string>, step.outputs, cleanOutputs);
          if (attemptId && Object.hasOwn(step.attempts, attemptId)) {
            step.attempts[attemptId]!.status = "passed";
            step.attempts[attemptId]!.outputs = Object.assign(Object.create(null) as Record<string, string>, cleanOutputs);
            step.attempts[attemptId]!.tokensUsed = event.data.tokensUsed;
            step.attempts[attemptId]!.wallTimeMs = event.data.wallTimeMs;
          }
        }

        // Charge token budget (only exceeding budget triggers immediate ceiling_reached; exact usage allows 1-step finish)
        if (event.data.tokensUsed > 0) {
          const remainingBefore = state.budgetRemaining.tokens;
          state.budgetUsed.tokens += event.data.tokensUsed;
          state.budgetRemaining.tokens = Math.max(0, remainingBefore - event.data.tokensUsed);
          if (event.data.tokensUsed > remainingBefore) {
            state.status = "stopped";
            state.terminalOutcome = "stopped";
            state.terminalReason = "ceiling_reached";
            return state;
          }
        }
        break;
      }

      case "step_failed": {
        const stepId = event.stepId ?? "unknown";
        const attemptId = event.attemptId;
        const step = state.stepStates[stepId];
        if (step) {
          step.status = "failed";
          if (attemptId && step.attempts[attemptId]) {
            step.attempts[attemptId]!.status = "failed";
          }
        }
        break;
      }

      case "step_outcome_unknown": {
        state.status = "waiting_decision";
        state.activeDecision = {
          stepId: event.stepId ?? "unknown",
          reasonCode: event.data.reasonCode,
          options: [
            { key: "retry", label: "Retry attempt" },
            { key: "stop", label: "Stop run", end: "stopped" },
          ],
        };
        const stepId = event.stepId ?? "unknown";
        const attemptId = event.attemptId;
        const step = state.stepStates[stepId];
        if (step) {
          step.status = "unknown";
          if (attemptId && step.attempts[attemptId]) {
            step.attempts[attemptId]!.status = "unknown";
          }
        }
        // Halt execution at unknown outcome (line 59 blocks any step/run continuation,
        // while allowing a subsequent decision/judgement/run_finished to close the run).
        break;
      }

      case "judgement": {
        const stepId = event.stepId ?? "unknown";
        const attemptId = event.attemptId;
        const step = state.stepStates[stepId];
        if (step) {
          step.lastJudgement = {
            final: event.data.final,
            reasonCodes: event.data.reasonCodes,
          };
          if (attemptId && step.attempts[attemptId]) {
            step.attempts[attemptId]!.lastJudgement = {
              final: event.data.final,
              reasonCodes: event.data.reasonCodes,
            };
          }
        }

        if (event.data.final === "decide") {
          state.status = "waiting_decision";
          state.activeDecision = {
            stepId,
            reasonCode: event.data.reasonCodes[0] ?? "judgement_decide",
            options: [
              { key: "continue", label: "Continue" },
              { key: "stop", label: "Stop", end: "stopped" },
            ],
          };
        } else if (event.data.final === "stop") {
          state.status = "stopped";
          state.terminalOutcome = "stopped";
          state.terminalReason = event.data.reasonCodes[0] ?? "judgement_stop";
        }
        break;
      }

      case "handoff_sent": {
        const stepDef = flow.steps.find((s) => s.id === event.stepId);
        const options =
          stepDef?.type === "decision"
            ? stepDef.options.filter((o) => event.data.optionKeys.includes(o.key))
            : event.data.optionKeys.map((k) => ({
                key: k,
                label: k.charAt(0).toUpperCase() + k.slice(1).replace(/[-_]/g, " "),
                ...(k === "stop" ? { end: "stopped" as const } : {}),
              }));
        state.status = "waiting_decision";
        state.activeHandoff = {
          handoffId: event.data.handoffId,
          stepId: event.stepId,
          attemptId: event.attemptId,
          kind: event.data.kind,
          target: event.data.target,
          reasonCode: event.data.reasonCode,
          optionKeys: [...event.data.optionKeys],
          alwaysDecide: event.data.alwaysDecide ?? false,
          ...(event.data.expiresAt ? { expiresAt: event.data.expiresAt } : {}),
        };
        state.activeDecision = {
          stepId: event.stepId,
          reasonCode: event.data.reasonCode,
          options,
        };
        break;
      }

      case "handoff_returned": {
        if (state.activeHandoff && state.activeHandoff.handoffId === event.data.handoffId) {
          state.activeHandoff = null;
        }
        if (!state.closedHandoffIds.includes(event.data.handoffId)) {
          state.closedHandoffIds.push(event.data.handoffId);
        }
        state.activeDecision = null;
        state.status = "running";
        break;
      }

      case "handoff_cancelled": {
        if (state.activeHandoff && state.activeHandoff.handoffId === event.data.handoffId) {
          state.activeHandoff = null;
        }
        if (!state.closedHandoffIds.includes(event.data.handoffId)) {
          state.closedHandoffIds.push(event.data.handoffId);
        }
        state.activeDecision = null;
        state.status = "running";
        break;
      }

      case "return_rejected": {
        break;
      }

      case "step_rewound": {
        state.rewindsUsed = event.data.rewindNumber;
        state.lastRewind = {
          fromStepId: event.data.fromStepId,
          toStepId: event.data.toStepId,
          rewindNumber: event.data.rewindNumber,
          reasonCode: event.data.reasonCode,
        };
        state.nextStepId = event.data.toStepId;
        state.activeDecision = null;
        state.activeHandoff = null;
        state.status = "running";

        const toIdx = flow.steps.findIndex((s) => s.id === event.data.toStepId);
        if (toIdx !== -1) {
          for (let j = toIdx; j < flow.steps.length; j++) {
            const targetId = flow.steps[j]!.id;
            if (Object.hasOwn(state.stepStates, targetId)) {
              state.stepStates[targetId] = {
                ...state.stepStates[targetId]!,
                status: "pending",
                lastJudgement: undefined,
              };
            }
          }
        }
        break;
      }

      case "run_released":
      case "run_claimed":
      case "child_started":
      case "child_finished":
      case "operator_input": {
        // Reserved events do not alter core replay state in slice 1a/2
        break;
      }

      case "run_finished": {
        // Major 1: NEVER allow run_finished(done) to reverse an already-stopped run
        if (state.status === "stopped" && event.data.outcome === "done") {
          return state;
        }
        state.status = event.data.outcome === "done" ? "finished" : "stopped";
        state.terminalOutcome = event.data.outcome;
        state.terminalReason = event.data.reasonCode;
        state.activeDecision = null;
        state.activeHandoff = null;
        state.nextStepId = null;
        state.currentStepId = null;
        state.currentAttemptId = null;
        return state;
      }
    }
  }

  return state;
}
