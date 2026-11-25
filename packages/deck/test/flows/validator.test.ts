import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { validateFlowYaml } from "../../app/lib/flows/validator.js";

const fixturesDir = resolve(__dirname, "fixtures");

describe("Flow Validator (Structural)", () => {
  it("accepts the golden two-step stub flow", () => {
    const content = readFileSync(resolve(fixturesDir, "two-step-stub.yaml"), "utf8");
    const result = validateFlowYaml(content);

    expect(result.valid).toBe(true);
    if (!result.valid) return;

    expect(result.flow.flow).toBe("test-two-step");
    expect(result.flow.version).toBe(1);
    expect(result.flow.steps).toHaveLength(2);
    expect(result.flow.steps[0]!.id).toBe("generate");
    expect(result.flow.steps[1]!.id).toBe("verify");
    expect(result.hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it("handles cyclic YAML references safely without RangeError", () => {
    // Cyclic YAML anchor
    const cyclicYaml = `
flow: cyclic-anchor
version: 1
steps:
  - id: step1
    type: agent
    prompt: &anchor
      nested: *anchor
`;
    // Must not throw RangeError (stack overflow)
    const result = validateFlowYaml(cyclicYaml);
    expect(result).toBeDefined();
    // Prompt is an object instead of string, so Zod schema returns valid: false
    expect(result.valid).toBe(false);
  });

  it("refuses operator syntax in mapping keys", () => {
    const yamlWithKeyInterpolation = `
flow: bad-key
version: 1
inputs:
  \${SECRET_KEY}:
    kind: string
steps:
  - id: step1
    type: agent
`;
    const result = validateFlowYaml(yamlWithKeyInterpolation);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "operator_syntax_forbidden")).toBe(true);
  });

  it("refuses forbidden prototype property names", () => {
    const yamlWithProto = `
flow: proto-pollution
version: 1
steps:
  - id: step1
    type: agent
    __proto__:
      polluted: true
`;
    const result = validateFlowYaml(yamlWithProto);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "forbidden_property_name" || e.code === "unrecognized_keys")).toBe(true);
  });

  it("refuses duplicate option keys in decision step", () => {
    const yamlWithDuplicateOptions = `
flow: dup-options
version: 1
steps:
  - id: step1
    type: decision
    options:
      - key: retry
        label: Retry once
      - key: retry
        label: Retry again
`;
    const result = validateFlowYaml(yamlWithDuplicateOptions);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "duplicate_option_key")).toBe(true);
  });

  it("refuses empty string goto", () => {
    const yamlWithEmptyGoto = `
flow: empty-goto
version: 1
steps:
  - id: step1
    type: decision
    options:
      - key: back
        goto: ""
`;
    const result = validateFlowYaml(yamlWithEmptyGoto);
    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "too_small" || e.code === "invalid_goto_target")).toBe(true);
  });

  it("refuses unknown top-level keys", () => {
    const content = readFileSync(resolve(fixturesDir, "refusal-cases/unknown-keys.yaml"), "utf8");
    const result = validateFlowYaml(content);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "unrecognized_keys")).toBe(true);
  });

  it("refuses missing version", () => {
    const content = readFileSync(resolve(fixturesDir, "refusal-cases/missing-version.yaml"), "utf8");
    const result = validateFlowYaml(content);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.path.includes("version"))).toBe(true);
  });

  it("refuses forward goto", () => {
    const content = readFileSync(resolve(fixturesDir, "refusal-cases/forward-goto.yaml"), "utf8");
    const result = validateFlowYaml(content);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "invalid_goto_target")).toBe(true);
  });

  it("refuses operator and interpolation syntax (${...})", () => {
    const content = readFileSync(resolve(fixturesDir, "refusal-cases/operator-syntax.yaml"), "utf8");
    const result = validateFlowYaml(content);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "operator_syntax_forbidden")).toBe(true);
  });

  it("refuses options with both goto and end", () => {
    const content = readFileSync(resolve(fixturesDir, "refusal-cases/both-goto-end.yaml"), "utf8");
    const result = validateFlowYaml(content);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "both_goto_and_end")).toBe(true);
  });

  it("refuses duplicate step IDs", () => {
    const content = readFileSync(resolve(fixturesDir, "refusal-cases/duplicate-id.yaml"), "utf8");
    const result = validateFlowYaml(content);

    expect(result.valid).toBe(false);
    if (result.valid) return;
    expect(result.errors.some((e) => e.code === "duplicate_step_id")).toBe(true);
  });

  describe("Guard-Removal Negatives", () => {
    it("fails safety guard if operator syntax check is bypassed", () => {
      const sneakyFlow = `
flow: sneaky-interpolation
version: 1
steps:
  - id: step1
    type: agent
    prompt: "Hello {{USER_INJECTION}}"
`;
      const result = validateFlowYaml(sneakyFlow);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors.some((e) => e.code === "operator_syntax_forbidden")).toBe(true);
    });

    it("fails safety guard if a stop option omits end target", () => {
      const badStopFlow = `
flow: bad-stop
version: 1
steps:
  - id: step1
    type: decision
    options:
      - key: stop
`;
      const result = validateFlowYaml(badStopFlow);
      expect(result.valid).toBe(false);
      if (result.valid) return;
      expect(result.errors.some((e) => e.code === "stop_without_end")).toBe(true);
    });
  });
});
