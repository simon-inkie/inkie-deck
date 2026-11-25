/**
 * Pure type definitions and runtime schemas for Deck structured task flows.
 *
 * All types in this file are pure TypeScript representations of flow
 * definitions, execution event envelopes, and replayed run states.
 * No environment, filesystem, or network imports are permitted here.
 */

import { z } from "zod";

export const FlowActorSchema = z.enum(["system", "runner", "agent", "human"]);
export type FlowActor = z.infer<typeof FlowActorSchema>;

// Strict identifiers and hashes
export const FlowIdRegex = /^[a-z0-9_-]{1,64}$/;
export const FlowSha256Regex = /^[a-f0-9]{64}$/;
export const FlowSafeValueRegex = /^[a-z0-9_.-]{1,64}$/;
export const FlowPrivateRefRegex = /^priv_[a-f0-9]{32}$/;
export const FlowEffectKeyRegex = /^eff_[a-f0-9]{24}$/;
export const FlowIsoTimestampRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$/;

export const FlowIdSchema = z.string().regex(FlowIdRegex, "Must be a valid identifier (/^[a-z0-9_-]{1,64}$/)");
export const FlowSha256Schema = z.string().regex(FlowSha256Regex, "Must be a 64-character hex SHA-256 string");
export const FlowSafeValueSchema = z.string().regex(FlowSafeValueRegex, "Must be a bounded safe identifier (max 64 chars)");
export const FlowPrivateRefSchema = z.string().regex(FlowPrivateRefRegex, "Must be an opaque CSPRNG private ref (priv_<32 hex>)");
export const FlowEffectKeySchema = z.string().regex(FlowEffectKeyRegex, "Must be a deterministic effect key (eff_<24 hex>)");
export const FlowIsoTimestampSchema = z.string().regex(FlowIsoTimestampRegex, "Must be a strict ISO-8601 UTC timestamp");
export const FlowBuiltInCheckIdSchema = z.enum(["check_exists", "check_nonempty", "check_unsupported"]);
export type FlowBuiltInCheckId = z.infer<typeof FlowBuiltInCheckIdSchema>;
export const FlowPublicOutputValueSchema = z
  .enum(["ok", "passed", "failed", "skipped", "approve", "continue", "stop", "yes", "no", "true", "false"])
  .or(FlowSha256Schema);
export const FlowRunMetadataSchema = z
  .record(FlowIdSchema, FlowSafeValueSchema)
  .refine((obj) => Object.keys(obj).length <= 16, "Metadata may contain at most 16 entries");

export const FlowRunPlannedDataSchema = z
  .object({
    flowRef: FlowIdSchema,
    flowHash: FlowSha256Schema,
    source: z.enum(["project", "library", "builtin"]),
    expectedDecisions: z.array(FlowIdSchema),
  })
  .strict();

export const FlowApprovedDataSchema = z
  .object({
    flowHash: FlowSha256Schema,
    actorId: FlowIdSchema,
  })
  .strict();

// Major 4 (Round 12): Strict semver-only runnerVersion so callers cannot smuggle private text via version strings.
export const FlowRunnerVersionSchema = z
  .string()
  .regex(/^\d{1,4}\.\d{1,4}\.\d{1,4}(?:-[a-z0-9.]{1,16})?$/);

export const FlowRunStartedDataSchema = z
  .object({
    runnerVersion: FlowRunnerVersionSchema,
    inputIds: z.record(FlowIdSchema, FlowIdSchema),
    budget: z
      .object({
        tokens: z.number().int().nonnegative(),
        steps: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const FlowStepStartedDataSchema = z
  .object({
    occurrence: z.number().int().positive(),
    effectKey: FlowEffectKeySchema,
  })
  .strict();

export const FlowArtefactRecordedDataSchema = z
  .object({
    artefactId: FlowIdSchema,
    sha256: FlowSha256Schema,
    sizeBytes: z.number().int().nonnegative(),
  })
  .strict();

export const FlowCheckResultDataSchema = z
  .object({
    checkId: FlowBuiltInCheckIdSchema,
    targetSha: FlowSha256Schema,
    passed: z.boolean(),
    privateDetailRef: FlowPrivateRefSchema.optional(),
  })
  .strict();

export const FlowStepResultOutputsSchema = z
  .object({
    status: FlowPublicOutputValueSchema.optional(),
    check: FlowPublicOutputValueSchema.optional(),
    result: FlowPublicOutputValueSchema.optional(),
    verdict: FlowPublicOutputValueSchema.optional(),
    ok: FlowPublicOutputValueSchema.optional(),
    output_file: FlowPublicOutputValueSchema.optional(),
    artifact: FlowPublicOutputValueSchema.optional(),
  })
  .strict();

export const FlowStepResultDataSchema = z
  .object({
    outputs: FlowStepResultOutputsSchema,
    tokensUsed: z.number().int().nonnegative(),
    wallTimeMs: z.number().int().nonnegative(),
  })
  .strict();

export const FlowStepFailedDataSchema = z
  .object({
    errorCode: z.enum(["timeout", "execution_error", "budget_exceeded", "check_failed"]),
    privateErrorRef: FlowPrivateRefSchema.optional(),
  })
  .strict();

export const FlowStepOutcomeUnknownDataSchema = z
  .object({
    reasonCode: z.enum(["dispatch_interrupted", "result_unrecorded", "crash_during_execution"]),
  })
  .strict();

export const FlowRuleHitSchema = z.enum([
  "step_passed",
  "check_passed",
  "check_failed",
  "step_timeout",
  "step_failed_recovery",
  "recovery_unknown_outcome",
  "retry_step",
  "stop_rule",
]);

export const FlowReasonCodeSchema = z.enum([
  "ok",
  "timeout",
  "execution_error",
  "budget_exceeded",
  "check_failed",
  "crash_during_execution",
  "dispatch_interrupted",
  "result_unrecorded",
  "retry",
  "halted",
]);

export const FlowJudgementDataSchema = z
  .object({
    final: z.enum(["continue", "notify", "decide", "stop"]),
    ruleHits: z.array(FlowRuleHitSchema),
    reasonCodes: z.array(FlowReasonCodeSchema),
    engineTokens: z.number().int().nonnegative(),
  })
  .strict();

export const FlowRunReleasedDataSchema = z
  .object({
    epoch: z.number().int().positive(),
  })
  .strict();

export const FlowRunClaimedDataSchema = z
  .object({
    epoch: z.number().int().positive(),
    machine: FlowIdSchema,
  })
  .strict();

export const FlowChildStartedDataSchema = z
  .object({
    childRunId: FlowIdSchema,
    flowHash: FlowSha256Schema,
    budget: z
      .object({
        tokens: z.number().int().nonnegative(),
        steps: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const FlowChildFinishedDataSchema = z
  .object({
    childRunId: FlowIdSchema,
    outcome: z.enum(["done", "stopped", "dropped"]),
    headSeq: z.number().int().positive(),
    headHash: FlowSha256Schema,
  })
  .strict();

export const FlowOperatorInputDataSchema = z
  .object({
    attemptId: FlowIdSchema,
    privateRef: FlowPrivateRefSchema.optional(),
  })
  .strict();

export const FlowRunFinishedDataSchema = z
  .object({
    outcome: z.enum(["done", "stopped", "dropped"]),
    reasonCode: z.enum(["completed", "ceiling_reached", "manual_stop", "unrecoverable_failure"]),
  })
  .strict();

// Common base event envelope schema (step-level events require stepId & attemptId;
// run-level events strictly FORBID stepId & attemptId to prevent caller private-text smuggling)
const RunLevelEnvelopeSchema = z
  .object({
    v: z.literal(1),
    runId: FlowIdSchema,
    seq: z.number().int().positive(),
    eventId: FlowIdSchema,
    prev: FlowSha256Schema,
    at: FlowIsoTimestampSchema,
    actor: FlowActorSchema,
    privateRef: FlowPrivateRefSchema.optional(),
  })
  .strict();

const StepLevelEnvelopeSchema = RunLevelEnvelopeSchema.extend({
  stepId: FlowIdSchema,
  attemptId: FlowIdSchema,
}).strict();

export const FlowRunPlannedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("run_planned"),
  data: FlowRunPlannedDataSchema,
}).strict();

export const FlowApprovedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("flow_approved"),
  data: FlowApprovedDataSchema,
}).strict();

export const FlowRunStartedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("run_started"),
  data: FlowRunStartedDataSchema,
}).strict();

export const FlowStepStartedEventSchema = StepLevelEnvelopeSchema.extend({
  type: z.literal("step_started"),
  data: FlowStepStartedDataSchema,
}).strict();

export const FlowArtefactRecordedEventSchema = StepLevelEnvelopeSchema.extend({
  type: z.literal("artefact_recorded"),
  data: FlowArtefactRecordedDataSchema,
}).strict();

export const FlowCheckResultEventSchema = StepLevelEnvelopeSchema.extend({
  type: z.literal("check_result"),
  data: FlowCheckResultDataSchema,
}).strict();

export const FlowStepResultEventSchema = StepLevelEnvelopeSchema.extend({
  type: z.literal("step_result"),
  data: FlowStepResultDataSchema,
}).strict();

export const FlowStepFailedEventSchema = StepLevelEnvelopeSchema.extend({
  type: z.literal("step_failed"),
  data: FlowStepFailedDataSchema,
}).strict();

export const FlowStepOutcomeUnknownEventSchema = StepLevelEnvelopeSchema.extend({
  type: z.literal("step_outcome_unknown"),
  data: FlowStepOutcomeUnknownDataSchema,
}).strict();

export const FlowJudgementEventSchema = StepLevelEnvelopeSchema.extend({
  type: z.literal("judgement"),
  data: FlowJudgementDataSchema,
}).strict();

export const FlowRunReleasedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("run_released"),
  data: FlowRunReleasedDataSchema,
}).strict();

export const FlowRunClaimedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("run_claimed"),
  data: FlowRunClaimedDataSchema,
}).strict();

export const FlowChildStartedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("child_started"),
  data: FlowChildStartedDataSchema,
}).strict();

export const FlowChildFinishedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("child_finished"),
  data: FlowChildFinishedDataSchema,
}).strict();

export const FlowOperatorInputEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("operator_input"),
  data: FlowOperatorInputDataSchema,
}).strict();

export const FlowRunFinishedEventSchema = RunLevelEnvelopeSchema.extend({
  type: z.literal("run_finished"),
  data: FlowRunFinishedDataSchema,
}).strict();

export const FlowEventSchema = z.discriminatedUnion("type", [
  FlowRunPlannedEventSchema,
  FlowApprovedEventSchema,
  FlowRunStartedEventSchema,
  FlowStepStartedEventSchema,
  FlowArtefactRecordedEventSchema,
  FlowCheckResultEventSchema,
  FlowStepResultEventSchema,
  FlowStepFailedEventSchema,
  FlowStepOutcomeUnknownEventSchema,
  FlowJudgementEventSchema,
  FlowRunReleasedEventSchema,
  FlowRunClaimedEventSchema,
  FlowChildStartedEventSchema,
  FlowChildFinishedEventSchema,
  FlowOperatorInputEventSchema,
  FlowRunFinishedEventSchema,
]);

export type FlowEvent = z.infer<typeof FlowEventSchema>;
export type FlowEventType = FlowEvent["type"];

export type FlowRunPlannedEvent = z.infer<typeof FlowRunPlannedEventSchema>;
export type FlowApprovedEvent = z.infer<typeof FlowApprovedEventSchema>;
export type FlowRunStartedEvent = z.infer<typeof FlowRunStartedEventSchema>;
export type FlowStepStartedEvent = z.infer<typeof FlowStepStartedEventSchema>;
export type FlowArtefactRecordedEvent = z.infer<typeof FlowArtefactRecordedEventSchema>;
export type FlowCheckResultEvent = z.infer<typeof FlowCheckResultEventSchema>;
export type FlowStepResultEvent = z.infer<typeof FlowStepResultEventSchema>;
export type FlowStepFailedEvent = z.infer<typeof FlowStepFailedEventSchema>;
export type FlowStepOutcomeUnknownEvent = z.infer<typeof FlowStepOutcomeUnknownEventSchema>;
export type FlowJudgementEvent = z.infer<typeof FlowJudgementEventSchema>;
export type FlowRunReleasedEvent = z.infer<typeof FlowRunReleasedEventSchema>;
export type FlowRunClaimedEvent = z.infer<typeof FlowRunClaimedEventSchema>;
export type FlowChildStartedEvent = z.infer<typeof FlowChildStartedEventSchema>;
export type FlowChildFinishedEvent = z.infer<typeof FlowChildFinishedEventSchema>;
export type FlowOperatorInputEvent = z.infer<typeof FlowOperatorInputEventSchema>;
export type FlowRunFinishedEvent = z.infer<typeof FlowRunFinishedEventSchema>;

export interface FlowLimits {
  max_attempts?: number;
  max_rewinds?: number;
  same_check_fail_limit?: number;
  step_timeout_min?: number;
  budget?: { tokens: number; steps: number };
}

export interface FlowOption {
  key: string;
  label?: string;
  goto?: string;
  end?: "done" | "stopped" | "dropped";
  note?: string;
}

export interface FlowRuleEntry {
  [ruleName: string]: "continue" | "notify" | "decide" | "stop";
}

export interface BaseStep {
  id: string;
  title?: string;
  rules?: FlowRuleEntry[];
}

export interface AgentStep extends BaseStep {
  type: "agent";
  role?: string;
  prompt?: string;
  outputs?: string[];
}

export interface CheckStep extends BaseStep {
  type: "check";
  against?: string;
  run?: string[];
  repro?: {
    test: { from: string };
    fail_on?: string;
    pass_on?: string;
  };
  on_fail?: { goto: string };
}

export interface HandoffStep extends BaseStep {
  type: "handoff";
  to?: string;
  returns?: Record<string, string[]>;
  on_return?: Record<string, { goto: string }>;
}

export interface DecisionStep extends BaseStep {
  type: "decision";
  always?: "decide";
  options: FlowOption[];
}

export interface SubflowStep extends BaseStep {
  type: "flow";
  flow: string;
}

export type FlowStep = AgentStep | CheckStep | HandoffStep | DecisionStep | SubflowStep;

export interface FlowDefinition {
  flow: string;
  version: 1;
  title?: string;
  trigger?: { kind: string };
  output?: { kind: string };
  inputs?: Record<string, { kind: string; required?: boolean }>;
  workspace?: { kind: string; base?: string };
  roles?: Record<string, { runtime: string; differs_from?: string }>;
  limits?: FlowLimits;
  protected_paths?: string[];
  on_unanswered?: { after_hours: number; outcome: "continue" | "notify" | "decide" | "stop" };
  steps: FlowStep[];
}

export interface AttemptState {
  occurrence: number;
  status: "pending" | "running" | "passed" | "failed" | "unknown";
  tokensUsed: number;
  wallTimeMs: number;
  outputs: Record<string, string>;
  lastJudgement?: {
    final: "continue" | "notify" | "decide" | "stop";
    reasonCodes: string[];
  };
}

export interface StepState {
  occurrence: number;
  status: "pending" | "running" | "passed" | "failed" | "unknown";
  outputs: Record<string, string>;
  lastJudgement?: {
    final: "continue" | "notify" | "decide" | "stop";
    reasonCodes: string[];
  };
  attempts: Record<string, AttemptState>;
}

export interface FlowRunState {
  runId: string;
  status:
    | "planned"
    | "approved"
    | "running"
    | "waiting_decision"
    | "finished"
    | "stopped"
    | "corrupted";
  currentStepId: string | null;
  currentAttemptId: string | null;
  activeDecision: {
    stepId: string;
    reasonCode: string;
    options: FlowOption[];
  } | null;
  stepStates: Record<string, StepState>;
  budgetUsed: { tokens: number; steps: number };
  budgetRemaining: { tokens: number; steps: number };
  recordedArtefacts: Record<string, { sha256: string; sizeBytes: number; stepId?: string }>;
  runPlanned: {
    flowRef: string;
    flowHash: string;
    source: "project" | "library" | "builtin";
    expectedDecisions: string[];
  } | null;
  terminalOutcome: "done" | "stopped" | "dropped" | null;
  terminalReason: string | null;
}
