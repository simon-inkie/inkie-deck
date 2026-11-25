/**
 * Pure structural validator for Deck flow YAML definitions.
 *
 * Enforces structural invariants defined in deck-flows-SPEC-DRAFT:
 * - Version must be 1.
 * - No unknown top-level or step keys.
 * - Unique step IDs matching /^[a-z0-9_-]+$/.
 * - Goto must target strictly earlier steps (no forward goto, no self goto).
 * - No operator or interpolation syntax (${...} or {{...}}) in keys or values.
 * - Cycle-safe recursive traversal preventing RangeError on YAML anchors.
 * - Options cannot specify both goto and end.
 * - Option with key 'stop' must specify end.
 * - Rule names must belong to the fixed rule library.
 */

import { createHash } from "node:crypto";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import type { FlowDefinition } from "./types.js";
import { FlowIdRegex } from "./types.js";

export const ALLOWED_RULE_NAMES = [
  "loop_count",
  "same_check_repeat",
  "protected_path_touched",
  "dependency_changed",
  "files_changed_over",
  "test_weakened",
  "stale_sha",
  "claimed_output_missing",
  "secret_found",
  "step_timeout",
  "budget_near",
] as const;

export interface ValidationError {
  path: string;
  code: string;
  message: string;
}

export type ValidationResult =
  | { valid: true; flow: FlowDefinition; hash: string }
  | { valid: false; errors: ValidationError[] };

const OptionSchema = z
  .object({
    key: z.string().regex(FlowIdRegex, "Option key must be a valid identifier (/^[a-z0-9_-]+$/)"),
    label: z.string().optional(),
    goto: z.string().min(1, "Goto target cannot be empty").optional(),
    end: z.enum(["done", "stopped", "dropped"]).optional(),
    note: z.string().optional(),
  })
  .strict();

const BaseStepSchema = z.object({
  id: z.string().regex(FlowIdRegex, "Step id must be a valid identifier (/^[a-z0-9_-]+$/)"),
  title: z.string().optional(),
  rules: z.array(z.record(z.string(), z.enum(["continue", "notify", "decide", "stop"]))).optional(),
});

const AgentStepSchema = BaseStepSchema.extend({
  type: z.literal("agent"),
  role: z.string().optional(),
  prompt: z.string().optional(),
  outputs: z.array(z.string().regex(FlowIdRegex)).optional(),
}).strict();

const CheckStepSchema = BaseStepSchema.extend({
  type: z.literal("check"),
  against: z.string().optional(),
  run: z.array(z.string()).optional(),
  repro: z
    .object({
      test: z.object({ from: z.string() }).strict(),
      fail_on: z.string().optional(),
      pass_on: z.string().optional(),
    })
    .strict()
    .optional(),
  on_fail: z.object({ goto: z.string().min(1) }).strict().optional(),
}).strict();

const HandoffStepSchema = BaseStepSchema.extend({
  type: z.literal("handoff"),
  to: z.string().optional(),
  returns: z.record(z.string().regex(FlowIdRegex), z.array(z.string().regex(FlowIdRegex))).optional(),
  on_return: z.record(z.string().regex(FlowIdRegex), z.object({ goto: z.string().min(1) }).strict()).optional(),
}).strict();

const DecisionStepSchema = BaseStepSchema.extend({
  type: z.literal("decision"),
  always: z.literal("decide").optional(),
  options: z.array(OptionSchema).min(1),
}).strict();

const StepSchema = z.discriminatedUnion("type", [
  AgentStepSchema,
  CheckStepSchema,
  HandoffStepSchema,
  DecisionStepSchema,
]);

const FlowSchema = z
  .object({
    flow: z.string().regex(FlowIdRegex, "Flow name must be a valid identifier (/^[a-z0-9_-]+$/)"),
    version: z.literal(1),
    title: z.string().optional(),
    trigger: z.object({ kind: z.string() }).strict().optional(),
    output: z.object({ kind: z.string() }).strict().optional(),
    inputs: z
      .record(
        z.string().regex(FlowIdRegex),
        z.object({
          kind: z.string(),
          required: z.boolean().optional(),
        }).strict()
      )
      .optional(),
    workspace: z.object({ kind: z.string(), base: z.string().optional() }).strict().optional(),
    roles: z
      .record(
        z.string().regex(FlowIdRegex),
        z.object({
          runtime: z.string(),
          differs_from: z.string().optional(),
        }).strict()
      )
      .optional(),
    limits: z
      .object({
        max_attempts: z.number().int().positive().optional(),
        max_rewinds: z.number().int().positive().optional(),
        same_check_fail_limit: z.number().int().positive().optional(),
        step_timeout_min: z.number().positive().optional(),
        budget: z
          .object({
            tokens: z.number().int().positive(),
            steps: z.number().int().positive(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
    protected_paths: z.array(z.string()).optional(),
    on_unanswered: z
      .object({
        after_hours: z.number().positive(),
        outcome: z.enum(["continue", "notify", "decide", "stop"]),
      })
      .strict()
      .optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict();

function checkForOperatorSyntax(
  obj: unknown,
  errors: ValidationError[],
  path = "",
  visited = new Set<unknown>()
): void {
  if (typeof obj === "string") {
    if (obj.includes("${") || obj.includes("{{")) {
      errors.push({
        path,
        code: "operator_syntax_forbidden",
        message: "Operator or template interpolation syntax (${...} or {{...}}) is not permitted in flows.",
      });
    }
    return;
  }

  if (obj === null || typeof obj !== "object") {
    return;
  }

  if (visited.has(obj)) {
    return; // Cycle-safe
  }
  visited.add(obj);

  if (Array.isArray(obj)) {
    for (let index = 0; index < obj.length; index++) {
      checkForOperatorSyntax(obj[index], errors, `${path}[${index}]`, visited);
    }
  } else {
    for (const [key, value] of Object.entries(obj)) {
      if (key === "__proto__" || key === "constructor" || key === "prototype") {
        errors.push({
          path: path ? `${path}.${key}` : key,
          code: "forbidden_property_name",
          message: `Property name '${key}' is forbidden.`,
        });
        continue;
      }
      if (typeof key === "string" && (key.includes("${") || key.includes("{{"))) {
        errors.push({
          path: path ? `${path}.${key}` : key,
          code: "operator_syntax_forbidden",
          message: "Operator or template interpolation syntax (${...} or {{...}}) is not permitted in keys.",
        });
      }
      checkForOperatorSyntax(value, errors, path ? `${path}.${key}` : key, visited);
    }
  }
}

export function parseFlowYamlOrThrow(rawYaml: string): { flow: FlowDefinition; hash: string } {
  const result = validateFlowYaml(rawYaml);
  if (!result.valid) {
    throw new Error(`Flow YAML validation failed: ${result.errors.map((e) => `${e.path}: ${e.message}`).join(", ")}`);
  }
  return { flow: result.flow, hash: result.hash };
}

export function validateFlowYaml(rawYaml: string): ValidationResult {
  const hash = createHash("sha256").update(rawYaml, "utf8").digest("hex");
  let parsed: unknown;
  try {
    parsed = parseYaml(rawYaml);
  } catch (err) {
    return {
      valid: false,
      errors: [
        {
          path: "",
          code: "yaml_parse_error",
          message: err instanceof Error ? err.message : "Malformed YAML content",
        },
      ],
    };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return {
      valid: false,
      errors: [
        {
          path: "",
          code: "invalid_document",
          message: "Flow document must be a YAML mapping",
        },
      ],
    };
  }

  const errors: ValidationError[] = [];

  // Check 1: Operator syntax scan (cycle-safe, scans keys and values)
  checkForOperatorSyntax(parsed, errors);

  // Check 2: Zod structural schema
  const parsedResult = FlowSchema.safeParse(parsed);
  if (!parsedResult.success) {
    for (const issue of parsedResult.error.issues) {
      errors.push({
        path: issue.path.join("."),
        code: issue.code,
        message: issue.message,
      });
    }
    return { valid: false, errors };
  }

  const flow = parsedResult.data as FlowDefinition;

  // Check 3: Unique step IDs
  const stepIdSet = new Set<string>();
  const seenStepIds: string[] = [];
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (!step) continue;
    if (stepIdSet.has(step.id)) {
      errors.push({
        path: `steps[${i}].id`,
        code: "duplicate_step_id",
        message: `Duplicate step ID: '${step.id}'`,
      });
    }
    stepIdSet.add(step.id);
  }

  // Check 4: Rule names, Option keys, and Goto validation
  for (let i = 0; i < flow.steps.length; i++) {
    const step = flow.steps[i];
    if (!step) continue;

    // Validate rules
    if (step.rules) {
      for (let r = 0; r < step.rules.length; r++) {
        const ruleMap = step.rules[r];
        if (!ruleMap) continue;
        for (const ruleKey of Object.keys(ruleMap)) {
          if (!ALLOWED_RULE_NAMES.includes(ruleKey as (typeof ALLOWED_RULE_NAMES)[number])) {
            errors.push({
              path: `steps[${i}].rules[${r}]`,
              code: "unknown_rule_name",
              message: `Unknown rule name: '${ruleKey}'. Allowed rules: ${ALLOWED_RULE_NAMES.join(", ")}`,
            });
          }
        }
      }
    }

    // Validate check step on_fail
    if (step.type === "check" && step.on_fail) {
      const target = step.on_fail.goto;
      if (!seenStepIds.includes(target)) {
        errors.push({
          path: `steps[${i}].on_fail.goto`,
          code: "invalid_goto_target",
          message: `Goto target '${target}' must point to a strictly earlier step. Seen steps: [${seenStepIds.join(", ")}]`,
        });
      }
    }

    // Validate handoff on_return
    if (step.type === "handoff" && step.on_return) {
      for (const [key, targetObj] of Object.entries(step.on_return)) {
        if (!seenStepIds.includes(targetObj.goto)) {
          errors.push({
            path: `steps[${i}].on_return.${key}.goto`,
            code: "invalid_goto_target",
            message: `Goto target '${targetObj.goto}' must point to a strictly earlier step.`,
          });
        }
      }
    }

    // Validate decision options
    if (step.type === "decision") {
      const optKeySet = new Set<string>();
      for (let optIdx = 0; optIdx < step.options.length; optIdx++) {
        const option = step.options[optIdx];
        if (!option) continue;

        if (optKeySet.has(option.key)) {
          errors.push({
            path: `steps[${i}].options[${optIdx}].key`,
            code: "duplicate_option_key",
            message: `Duplicate option key: '${option.key}'`,
          });
        }
        optKeySet.add(option.key);

        if (option.goto && option.end) {
          errors.push({
            path: `steps[${i}].options[${optIdx}]`,
            code: "both_goto_and_end",
            message: `Option '${option.key}' cannot specify both 'goto' and 'end'.`,
          });
        }
        if (option.goto && !seenStepIds.includes(option.goto)) {
          errors.push({
            path: `steps[${i}].options[${optIdx}].goto`,
            code: "invalid_goto_target",
            message: `Goto target '${option.goto}' must point to a strictly earlier step.`,
          });
        }
        if (option.key === "stop" && !option.end) {
          errors.push({
            path: `steps[${i}].options[${optIdx}]`,
            code: "stop_without_end",
            message: "Option with key 'stop' must specify an 'end' target (e.g. 'end: stopped').",
          });
        }
      }
    }

    seenStepIds.push(step.id);
  }

  if (errors.length > 0) {
    return { valid: false, errors };
  }

  return { valid: true, flow, hash };
}
