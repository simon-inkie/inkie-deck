import { getHandoffOptionKeys, type FlowJudgementOutcome } from "./engine.js";
import {
  FlowIdRegex,
  type ActiveHandoffState,
  type FlowDefinition,
  type FlowEvent,
  type FlowPreanswerGivenEvent,
  type FlowReasonCode,
  type FlowStep,
} from "./types.js";

function getDecisionOptions(step: FlowStep, outcome: "passed" | "failed" | "unknown") {
  if (step.type === "decision") {
    return step.options.map((option) => ({
      key: option.key,
      label: option.label ?? option.key,
      detail: option.end
        ? `Ends run (${option.end})`
        : option.goto
          ? `Rewind to ${option.goto}`
          : option.label ?? option.key,
    }));
  }
  return outcome === "failed"
    ? [
        { key: "retry", label: "Retry", detail: "Rewind and retry step" },
        { key: "stop", label: "Stop", detail: "Stop run" },
      ]
    : [
        { key: "continue", label: "Continue", detail: "Approve and continue flow" },
        { key: "retry", label: "Retry", detail: "Rewind and retry step" },
        { key: "stop", label: "Stop", detail: "Stop run" },
      ];
}

export function getHandoffSpecForStep(
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
    const options = getDecisionOptions(step, outcome);
    return {
      kind: "decision",
      target: "operator",
      reasonCode: "decision_required",
      optionKeys: options.map((option) => option.key),
      alwaysDecide: step.always === "decide" ? true : undefined,
      expiresAt,
      options,
    };
  }

  if (step.type === "handoff") {
    const optionKeys = getHandoffOptionKeys(step);
    return {
      kind: "handoff",
      target: step.to && FlowIdRegex.test(step.to) ? step.to : "reviewer",
      reasonCode: "handoff_required",
      optionKeys,
      expiresAt,
      options: optionKeys.map((k) => ({
        key: k,
        label: k.charAt(0).toUpperCase() + k.slice(1).replace(/[-_]/g, " "),
        detail: step.on_return?.[k]?.goto ? `Rewind to ${step.on_return[k]!.goto}` : `Return ${k}`,
      })),
    };
  }

  const escalatedOptions = getDecisionOptions(step, outcome);

  return {
    kind: "decision",
    target: "operator",
    reasonCode,
    optionKeys: escalatedOptions.map((o) => o.key),
    expiresAt,
    options: escalatedOptions,
  };
}

export function getPlanningDecision(step: FlowStep) {
  // Agent and check failures can ask at the attempt or rewind limits, even
  // when the definition uses the default limits and declares no rules.
  const hasLimitExit = step.type === "agent" || step.type === "check";
  const hasRuleExit = step.type !== "handoff" && step.type !== "flow" &&
    step.rules?.some((rule) => Object.values(rule).includes("decide"));
  if (step.type !== "decision" && !hasRuleExit && !hasLimitExit) return undefined;

  return {
    stepId: step.id,
    title: step.title ?? step.id,
    options: getDecisionOptions(step, "passed"),
    liveOnly: step.type === "decision" && step.always === "decide",
    conditional: step.type !== "decision",
  };
}

export function collectPlanningDecisions(flow: FlowDefinition) {
  return flow.steps.flatMap((step) => getPlanningDecision(step) ?? []);
}

function normaliseTimestamp(timestamp: string): string {
  return timestamp.replace(/(?:\.(\d{1,6}))?Z$/, (_, fraction: string = "") => `.${fraction.padEnd(6, "0")}Z`);
}

export function selectPreanswer(params: {
  step: FlowStep;
  handoff: Pick<ActiveHandoffState, "stepId" | "attemptId" | "kind" | "alwaysDecide" | "optionKeys" | "expiresAt">;
  now: string;
  events: readonly FlowEvent[];
  budgetRemaining: { steps: number; tokens: number };
  rewindsRemaining: number;
}): FlowPreanswerGivenEvent | undefined {
  const { step, handoff, now, events, budgetRemaining } = params;
  if (handoff.expiresAt && normaliseTimestamp(now) >= normaliseTimestamp(handoff.expiresAt)) return undefined;
  if (handoff.kind !== "decision" || step.id !== handoff.stepId) return undefined;
  if (handoff.alwaysDecide || (step.type === "decision" && step.always === "decide")) return undefined;
  if (budgetRemaining.steps <= 0 || budgetRemaining.tokens <= 0) return undefined;

  let saved: FlowPreanswerGivenEvent | undefined;
  let occurrence: number | undefined;
  let outcome: FlowJudgementOutcome | undefined;
  let failed = false;
  for (const event of events) {
    if (event.type === "preanswer_given" && event.data.stepId === step.id) saved = event;
    if (!("attemptId" in event) || event.stepId !== step.id || event.attemptId !== handoff.attemptId) continue;
    if (event.type === "step_started") occurrence = event.data.occurrence;
    if (event.type === "judgement") outcome = event.data.final;
    if (event.type === "step_failed") failed = true;
  }
  if (occurrence !== 1) return undefined;
  if (step.type !== "decision" && outcome !== "decide") return undefined;
  if (!saved || !handoff.optionKeys.includes(saved.data.choiceKey)) return undefined;
  const choiceKey = saved.data.choiceKey;
  const willRewind = step.type === "decision"
    ? step.options.some((option) => option.key === choiceKey && option.goto !== undefined)
    : choiceKey === "retry";
  if (willRewind && params.rewindsRemaining <= 0) return undefined;
  const pinnedOptions = getDecisionOptions(step, failed ? "failed" : "passed");
  return pinnedOptions.some((option) => option.key === choiceKey) ? saved : undefined;
}
