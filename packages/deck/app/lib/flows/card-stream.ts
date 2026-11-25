/**
 * Pure projection types and builder for Deck Flows Slice 1b card stream.
 *
 * ZERO .server or Node imports - safe for both client and server bundles.
 * Strict allowlist projection: never emits privateRef, privateDetailRef,
 * privateErrorRef, or private detail content.
 *
 * ASCII only - no em-dashes.
 */

import { resolvePinnedBudget } from "./replay.js";
import type {
  FlowDefinition,
  FlowEvent,
  FlowRunState,
  StepState,
} from "./types.js";

export type FlowStepCardState = "done" | "current" | "pending" | "failed";

export interface FlowPlanningCard {
  flowRef: string;
  flowHash: string;
  source: "project" | "library" | "builtin";
  approved: boolean;
  expectedDecisions: string[];
}

export interface FlowStepEvidence {
  artefacts: Array<{ artefactId: string; sha256: string; sizeBytes: number }>;
  outputs: Record<string, string>;
  lastJudgement?: { final: string; reasonCodes: string[] };
}

export interface FlowStepCard {
  stepId: string;
  stepType: string;
  cardState: FlowStepCardState;
  stepStatus: string;
  occurrence: number;
  maxAttempts: number | null;
  rewindLabel: string | null;
  tokensUsed: number;
  wallTimeMs: number;
  summary: string;
  evidence: FlowStepEvidence;
}

export interface FlowRunSummary {
  runId: string;
  status: string;
  waitingOn: string | null;
  flowHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface FlowBudgetSummary {
  tokensUsed: number;
  tokensTotal: number;
  stepsUsed: number;
  stepsTotal: number;
}

export interface FlowCardStreamView {
  projectId: string;
  runId: string;
  flowName: string;
  flowVersion: number;
  runStatus: string;
  waitingOn: string | null;
  headSeq: number;
  eventCount: number;
  terminalOutcome: string | null;
  terminalReason: string | null;
  budget: FlowBudgetSummary;
  planningCard: FlowPlanningCard;
  stepCards: FlowStepCard[];
  activeDecision: {
    handoffId?: string;
    stepId: string;
    reasonCode: string;
    options: Array<{ key: string; label: string }>;
  } | null;
}

export interface FlowLaunchCatalogEntry {
  flowRef: string;
  source: "project" | "library" | "builtin";
  title?: string;
  hash: string;
  yaml: string;
  stepCount: number;
  hasWorkspace: boolean;
}

export interface FlowLaunchDraftEntry {
  draftName: string;
  flowRef: string;
  source: "draft";
  title?: string;
  hash: string;
  yaml: string;
  stepCount: number;
  diffFromTemplate?: string;
}

export interface FlowLaunchCatalog {
  flows: FlowLaunchCatalogEntry[];
  drafts: FlowLaunchDraftEntry[];
}

export function deriveWaitingOn(status: string): string | null {
  if (status === "waiting_decision" || status === "planned") {
    return "operator";
  }
  return null;
}

function resolveCardState(
  stepId: string,
  stepStatus: string,
  state: FlowRunState,
): FlowStepCardState {
  if (stepStatus === "passed") {
    return "done";
  }
  if (stepStatus === "failed" || stepStatus === "unknown") {
    return "failed";
  }
  if (stepStatus === "running") {
    if (state.status === "stopped" || state.status === "corrupted") {
      return "failed";
    }
    return "current";
  }
  if (
    state.currentStepId === stepId &&
    state.status !== "finished" &&
    state.status !== "stopped" &&
    state.status !== "corrupted"
  ) {
    return "current";
  }
  return "pending";
}

function buildPublicOutputs(stepState: StepState | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!stepState) return out;
  for (const [key, value] of Object.entries(stepState.outputs)) {
    if (
      key === "privateRef" ||
      key === "privateDetailRef" ||
      key === "privateErrorRef" ||
      key === "__proto__" ||
      key === "constructor" ||
      key === "prototype"
    ) {
      continue;
    }
    if (typeof value === "string") {
      out[key] = value;
    }
  }
  return out;
}

function buildStepSummary(
  stepId: string,
  stepType: string,
  stepStatus: string,
  tokensUsed: number,
  wallTimeMs: number,
  rewindLabel: string | null,
  stepState: StepState | undefined,
  state: FlowRunState,
): string {
  if (stepStatus === "passed") {
    return `${stepId} (${stepType}) passed (${tokensUsed} tokens, ${wallTimeMs}ms)`;
  }
  if (stepStatus === "failed") {
    const reasons = stepState?.lastJudgement?.reasonCodes ?? [];
    const suffix = reasons.length > 0 ? `: ${reasons.join(", ")}` : "";
    return `${stepId} (${stepType}) failed${suffix}`;
  }
  if (stepStatus === "unknown") {
    const reason = state.activeDecision?.stepId === stepId ? state.activeDecision.reasonCode : "unknown";
    return `${stepId} (${stepType}) outcome unknown (${reason})`;
  }
  if (stepStatus === "running") {
    return rewindLabel
      ? `${stepId} (${stepType}) running (${rewindLabel})`
      : `${stepId} (${stepType}) running`;
  }
  return `${stepId} (${stepType}) pending`;
}

export function projectFlowCardStream(params: {
  projectId: string;
  runId: string;
  flowHash: string;
  flow: FlowDefinition;
  events: readonly FlowEvent[];
  state: FlowRunState;
}): FlowCardStreamView {
  const { projectId, runId, flowHash, flow, events, state } = params;
  const pinnedBudget = resolvePinnedBudget(flow);
  const approved = events.some((ev) => ev.type === "flow_approved");
  const headSeq = events.length > 0 ? events[events.length - 1]!.seq : 0;
  const maxAttempts = flow.limits?.max_attempts ?? null;

  const artefactsByStep = new Map<
    string,
    Array<{ artefactId: string; sha256: string; sizeBytes: number }>
  >();
  for (const [artefactId, art] of Object.entries(state.recordedArtefacts)) {
    const stepKey = art.stepId;
    if (!stepKey) continue;
    const list = artefactsByStep.get(stepKey) ?? [];
    list.push({
      artefactId,
      sha256: art.sha256,
      sizeBytes: art.sizeBytes,
    });
    artefactsByStep.set(stepKey, list);
  }

  const stepCards: FlowStepCard[] = flow.steps.map((step) => {
    const stepState = Object.hasOwn(state.stepStates, step.id)
      ? state.stepStates[step.id]
      : undefined;
    const stepStatus = stepState?.status ?? "pending";
    const occurrence = stepState?.occurrence ?? 0;
    const rewindLabel =
      occurrence > 1
        ? maxAttempts !== null
          ? `attempt ${occurrence} of ${maxAttempts}`
          : `attempt ${occurrence}`
        : null;

    let tokensUsed = 0;
    let wallTimeMs = 0;
    if (stepState) {
      for (const att of Object.values(stepState.attempts)) {
        tokensUsed += att.tokensUsed;
        wallTimeMs += att.wallTimeMs;
      }
    }

    const cardState = resolveCardState(step.id, stepStatus, state);
    const evidence: FlowStepEvidence = {
      artefacts: artefactsByStep.get(step.id) ?? [],
      outputs: buildPublicOutputs(stepState),
      ...(stepState?.lastJudgement
        ? {
            lastJudgement: {
              final: stepState.lastJudgement.final,
              reasonCodes: [...stepState.lastJudgement.reasonCodes],
            },
          }
        : {}),
    };

    return {
      stepId: step.id,
      stepType: step.type,
      cardState,
      stepStatus,
      occurrence,
      maxAttempts,
      rewindLabel,
      tokensUsed,
      wallTimeMs,
      summary: buildStepSummary(
        step.id,
        step.type,
        stepStatus,
        tokensUsed,
        wallTimeMs,
        rewindLabel,
        stepState,
        state,
      ),
      evidence,
    };
  });

  const planningCard: FlowPlanningCard = {
    flowRef: state.runPlanned?.flowRef ?? flow.flow,
    flowHash: state.runPlanned?.flowHash ?? flowHash,
    source: state.runPlanned?.source ?? "builtin",
    approved,
    expectedDecisions: state.runPlanned ? [...state.runPlanned.expectedDecisions] : [],
  };

  const activeDecision = state.activeDecision
    ? {
        ...(state.activeHandoff ? { handoffId: state.activeHandoff.handoffId } : {}),
        stepId: state.activeDecision.stepId,
        reasonCode: state.activeDecision.reasonCode,
        options: state.activeDecision.options.map((opt) => ({
          key: opt.key,
          label: opt.label ?? opt.key,
        })),
      }
    : null;

  return {
    projectId,
    runId,
    flowName: flow.flow,
    flowVersion: flow.version,
    runStatus: state.status,
    waitingOn: state.activeHandoff?.target ?? deriveWaitingOn(state.status),
    headSeq,
    eventCount: events.length,
    terminalOutcome: state.terminalOutcome,
    terminalReason: state.terminalReason,
    budget: {
      tokensUsed: state.budgetUsed.tokens,
      tokensTotal: pinnedBudget.tokens,
      stepsUsed: state.budgetUsed.steps,
      stepsTotal: pinnedBudget.steps,
    },
    planningCard,
    stepCards,
    activeDecision,
  };
}
