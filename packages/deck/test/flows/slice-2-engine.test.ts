import { describe, expect, it } from "vitest";
import {
  applyMonotonicFloor,
  evaluateStepJudgement,
  matchesProtectedPath,
  maxOutcome,
  OUTCOME_RANK,
  resolveFlowLimits,
  type FlowJudgementOutcome,
} from "../../app/lib/flows/engine.js";
import type { AgentStep, CheckStep, FlowDefinition, FlowRuleEntry, FlowStep } from "../../app/lib/flows/types.js";

function makeBaseFlow(overrides?: Partial<FlowDefinition>): FlowDefinition {
  const buildStep: AgentStep = {
    id: "build",
    type: "agent",
    role: "builder",
    outputs: ["out"],
  };
  const verifyStep: CheckStep = {
    id: "verify",
    type: "check",
    against: "out",
    run: ["check_nonempty"],
    on_fail: { goto: "build" },
  };
  return {
    flow: "slice-2-engine-test",
    version: 1,
    limits: {
      max_attempts: 3,
      max_rewinds: 6,
      same_check_fail_limit: 3,
      step_timeout_min: 30,
      budget: { tokens: 1000, steps: 10 },
    },
    protected_paths: ["src/auth/**", "*.lock", ".github/workflows/*.yml", "config/prod?.json"],
    steps: [buildStep, verifyStep],
    ...overrides,
  };
}

describe("Deck Flows Slice 2 - Pure Decision Engine", () => {
  it("resolves flow limits with v1 spec defaults and overrides", () => {
    const bareFlow: FlowDefinition = {
      flow: "bare",
      version: 1,
      steps: [{ id: "s1", type: "agent" }],
    };
    const defaults = resolveFlowLimits(bareFlow);
    expect(defaults.maxAttempts).toBe(3);
    expect(defaults.maxRewinds).toBe(6);
    expect(defaults.sameCheckFailLimit).toBe(3);
    expect(defaults.stepTimeoutMin).toBe(30);
    expect(defaults.budget.tokens).toBeGreaterThan(0);
    expect(defaults.budget.steps).toBeGreaterThan(0);

    const custom = resolveFlowLimits(
      makeBaseFlow({
        limits: {
          max_attempts: 5,
          max_rewinds: 9,
          same_check_fail_limit: 4,
          step_timeout_min: 15,
          budget: { tokens: 2500, steps: 20 },
        },
      }),
    );
    expect(custom).toEqual({
      maxAttempts: 5,
      maxRewinds: 9,
      sameCheckFailLimit: 4,
      stepTimeoutMin: 15,
      budget: { tokens: 2500, steps: 20 },
    });
  });

  it("matches protected_paths globs (**, *, ?, leading ./) accurately", () => {
    const patterns = [
      "src/auth/**",
      "package-lock.json",
      ".github/workflows/*.yml",
      "config/prod?.json",
      "./infra/**/*.tf",
    ];
    expect(matchesProtectedPath("src/auth/login.ts", patterns)).toBe(true);
    expect(matchesProtectedPath("./src/auth/nested/jwt.ts", patterns)).toBe(true);
    expect(matchesProtectedPath("src/other/login.ts", patterns)).toBe(false);
    expect(matchesProtectedPath("package-lock.json", patterns)).toBe(true);
    expect(matchesProtectedPath(".github/workflows/ci.yml", patterns)).toBe(true);
    expect(matchesProtectedPath(".github/workflows/deep/ci.yml", patterns)).toBe(false);
    expect(matchesProtectedPath("config/prod1.json", patterns)).toBe(true);
    expect(matchesProtectedPath("config/prod12.json", patterns)).toBe(false);
    expect(matchesProtectedPath("infra/vpc/main.tf", patterns)).toBe(true);
    expect(matchesProtectedPath("infra/main.tf", patterns)).toBe(true);
    expect(matchesProtectedPath("src/app.ts", [])).toBe(false);
    expect(matchesProtectedPath("src/app.ts", undefined)).toBe(false);
  });

  it("property/matrix: monotonic outcome floor never lowers a safety, limit, or rule outcome", () => {
    const outcomes: FlowJudgementOutcome[] = ["continue", "notify", "decide", "stop"];
    for (const base of outcomes) {
      for (const floorA of outcomes) {
        for (const floorB of outcomes) {
          const combined = applyMonotonicFloor(base, floorA, floorB);
          expect(OUTCOME_RANK[combined]).toBeGreaterThanOrEqual(OUTCOME_RANK[base]);
          expect(OUTCOME_RANK[combined]).toBeGreaterThanOrEqual(OUTCOME_RANK[floorA]);
          expect(OUTCOME_RANK[combined]).toBeGreaterThanOrEqual(OUTCOME_RANK[floorB]);
          expect(combined).toBe(maxOutcome(base, floorA, floorB));
        }
      }
    }

    // Permissive step.rules ("continue" / "notify") NEVER lower safety or limit floors
    const permissiveRules: FlowRuleEntry[] = [
      { secret_found: "continue" },
      { test_weakened: "continue" },
      { protected_path_touched: "notify" },
      { dependency_changed: "continue" },
      { same_check_repeat: "continue" },
      { loop_count: "continue" },
      { files_changed_over: "notify" },
      { budget_near: "continue" },
    ];
    const step: AgentStep = {
      id: "build",
      type: "agent",
      role: "builder",
      outputs: ["out"],
      rules: permissiveRules,
    };
    const flow = makeBaseFlow({ steps: [step] });

    const cases: Array<{
      name: string;
      input: Partial<Parameters<typeof evaluateStepJudgement>[0]>;
      minExpected: FlowJudgementOutcome;
    }> = [
      { name: "unknown", input: { outcome: "unknown" }, minExpected: "stop" },
      { name: "budget exceeded", input: { budgetUsed: { tokens: 1001, steps: 1 } }, minExpected: "stop" },
      { name: "secret found", input: { signals: { secretFound: true } }, minExpected: "stop" },
      { name: "test weakened", input: { signals: { testWeakened: true } }, minExpected: "stop" },
      { name: "same check repeat", input: { sameCheckFailCount: 3 }, minExpected: "decide" },
      { name: "max attempts on failure", input: { outcome: "failed", occurrence: 3 }, minExpected: "decide" },
      { name: "max rewinds on failure", input: { outcome: "failed", rewindsUsed: 6 }, minExpected: "decide" },
      { name: "protected path", input: { signals: { changedFiles: ["src/auth/token.ts"] } }, minExpected: "decide" },
      { name: "dependency changed", input: { signals: { dependencyChanged: true } }, minExpected: "decide" },
      { name: "files changed over", input: { signals: { filesChangedCount: 16 } }, minExpected: "decide" },
      { name: "budget near 80%", input: { budgetUsed: { tokens: 800, steps: 2 } }, minExpected: "notify" },
    ];

    for (const c of cases) {
      const res = evaluateStepJudgement({
        flow,
        step,
        occurrence: c.input.occurrence ?? 1,
        rewindsUsed: c.input.rewindsUsed ?? 0,
        outcome: c.input.outcome ?? "passed",
        budgetUsed: c.input.budgetUsed ?? { tokens: 100, steps: 1 },
        sameCheckFailCount: c.input.sameCheckFailCount ?? 0,
        signals: c.input.signals,
      });
      expect(OUTCOME_RANK[res.final], `case: ${c.name}`).toBeGreaterThanOrEqual(
        OUTCOME_RANK[c.minExpected],
      );
    }

    // Conversely, strict rules CAN raise a notify outcome to decide or stop
    const raisedStep: AgentStep = {
      id: "build",
      type: "agent",
      outputs: ["out"],
      rules: [{ budget_near: "decide" }],
    };
    const raised = evaluateStepJudgement({
      flow: makeBaseFlow({ steps: [raisedStep] }),
      step: raisedStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 850, steps: 1 },
    });
    expect(raised.final).toBe("decide");
    expect(raised.reasonCodes).toContain("budget_near");
  });

  it("covers all Scenarios 1 through 20 deterministically", () => {
    const flow = makeBaseFlow();
    const buildStep = flow.steps[0] as FlowStep;
    const verifyStep = flow.steps[1] as CheckStep;

    // Scenario 1: Single check failure with on_fail.goto rewinds under limits
    const s1 = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "failed",
      errorCode: "check_failed",
      budgetUsed: { tokens: 100, steps: 1 },
      sameCheckFailCount: 1,
    });
    expect(s1.final).toBe("continue");
    expect(s1.shouldRewind).toBe(true);
    expect(s1.rewindTargetStepId).toBe("build");
    expect(s1.reasonCodes).toContain("on_fail_rewind");

    // Scenario 2: Same check fails N times in a row -> decide
    const s2 = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 2,
      outcome: "failed",
      errorCode: "check_failed",
      budgetUsed: { tokens: 300, steps: 4 },
      sameCheckFailCount: 3,
    });
    expect(s2.final).toBe("decide");
    expect(s2.shouldRewind).toBe(false);
    expect(s2.reasonCodes).toContain("same_check_repeat");

    // Scenario 3: Loop count hits max_attempts OR max_rewinds -> decide
    const s3Attempts = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 3,
      rewindsUsed: 2,
      outcome: "failed",
      errorCode: "check_failed",
      budgetUsed: { tokens: 300, steps: 4 },
      sameCheckFailCount: 1,
    });
    expect(s3Attempts.final).toBe("decide");
    expect(s3Attempts.reasonCodes).toContain("max_attempts_reached");

    const s3Rewinds = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 6,
      outcome: "failed",
      errorCode: "check_failed",
      budgetUsed: { tokens: 300, steps: 4 },
      sameCheckFailCount: 1,
    });
    expect(s3Rewinds.final).toBe("decide");
    expect(s3Rewinds.reasonCodes).toContain("max_rewinds_reached");

    // Scenario 4: Test deleted/weakened -> stop
    const s4 = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { testWeakened: true },
    });
    expect(s4.final).toBe("stop");
    expect(s4.reasonCodes).toContain("test_weakened");

    // Scenario 5: Protected path touched -> decide
    const s5 = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { changedFiles: ["src/auth/session.ts"] },
    });
    expect(s5.final).toBe("decide");
    expect(s5.reasonCodes).toContain("protected_path_touched");

    // Scenario 6: New dependency added -> decide
    const s6 = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { dependencyChanged: true },
    });
    expect(s6.final).toBe("decide");
    expect(s6.reasonCodes).toContain("dependency_changed");

    // Scenario 7: Token or step budget >= 80% -> notify
    const s7Tokens = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 800, steps: 2 },
    });
    expect(s7Tokens.final).toBe("notify");
    expect(s7Tokens.reasonCodes).toContain("budget_near");

    const s7Steps = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 8 },
    });
    expect(s7Steps.final).toBe("notify");
    expect(s7Steps.reasonCodes).toContain("budget_near");

    // Scenario 8: Budget > 100% -> stop
    const s8 = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 1001, steps: 3 },
    });
    expect(s8.final).toBe("stop");
    expect(s8.reasonCodes).toContain("budget_exceeded");

    // Scenario 9: Step times out -> stop by default (Slice 1a compat), decide when declared
    const s9Default = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "failed",
      errorCode: "timeout",
      budgetUsed: { tokens: 100, steps: 1 },
    });
    expect(s9Default.final).toBe("stop");
    expect(s9Default.reasonCodes).toContain("timeout");

    const decideTimeoutStep: AgentStep = {
      id: "build",
      type: "agent",
      rules: [{ step_timeout: "decide" }],
    };
    const s9Decide = evaluateStepJudgement({
      flow: makeBaseFlow({ steps: [decideTimeoutStep] }),
      step: decideTimeoutStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "failed",
      errorCode: "timeout",
      budgetUsed: { tokens: 100, steps: 1 },
    });
    expect(s9Decide.final).toBe("decide");
    expect(s9Decide.reasonCodes).toContain("timeout");

    // Scenario 10: Ambiguous ticket -> decide
    const s10 = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { ticketCriteriaMissing: true },
    });
    expect(s10.final).toBe("decide");
    expect(s10.reasonCodes).toContain("ambiguous_ticket");

    // Scenario 11: Agent asks a question -> decide
    const s11 = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { agentQuestion: true },
    });
    expect(s11.final).toBe("decide");
    expect(s11.reasonCodes).toContain("question_to_human");

    // Scenario 12: Merge conflict (in_scope -> notify, out_of_scope -> decide)
    const s12In = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { mergeConflict: "in_scope" },
    });
    expect(s12In.final).toBe("notify");
    expect(s12In.reasonCodes).toContain("merge_conflict");

    const s12Out = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { mergeConflict: "out_of_scope" },
    });
    expect(s12Out.final).toBe("decide");
    expect(s12Out.reasonCodes).toContain("merge_conflict_out_of_scope");

    // Scenario 13: Secret found -> stop
    const s13 = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { secretFound: true },
    });
    expect(s13.final).toBe("stop");
    expect(s13.reasonCodes).toContain("secret_found");

    // Scenario 14: Flaky flip (1 -> notify, >=2 -> decide)
    const s14One = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { flakyFlipCount: 1 },
    });
    expect(s14One.final).toBe("notify");
    expect(s14One.reasonCodes).toContain("flaky_suspected");

    const s14Two = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { flakyFlipCount: 2 },
    });
    expect(s14Two.final).toBe("decide");
    expect(s14Two.reasonCodes).toContain("flaky_repeated");

    // Scenario 15: Scope drift / > max_files_changed (15) -> decide
    const s15Files = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { filesChangedCount: 16 },
    });
    expect(s15Files.final).toBe("decide");
    expect(s15Files.reasonCodes).toContain("files_changed_over");

    const s15Drift = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { scopeDrift: true },
    });
    expect(s15Drift.final).toBe("decide");
    expect(s15Drift.reasonCodes).toContain("scope_drift");

    // Scenario 16: Claimed output missing (1 -> continue rewind, >=2 -> decide)
    const s16Once = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "failed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { claimedOutputMissingCount: 1 },
    });
    expect(s16Once.final).toBe("continue");
    expect(s16Once.shouldRewind).toBe(true);
    expect(s16Once.rewindTargetStepId).toBe("build");
    expect(s16Once.reasonCodes).toContain("claimed_output_missing");

    const s16Twice = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 2,
      rewindsUsed: 1,
      outcome: "failed",
      budgetUsed: { tokens: 200, steps: 2 },
      signals: { claimedOutputMissingCount: 2 },
    });
    expect(s16Twice.final).toBe("decide");
    expect(s16Twice.shouldRewind).toBe(false);
    expect(s16Twice.reasonCodes).toContain("claimed_output_missing");

    // Scenario 17: Stale SHA -> continue + shouldRerunCheck under limits; decide when exhausted
    const s17 = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { staleSha: true },
    });
    expect(s17.final).toBe("continue");
    expect(s17.shouldRerunCheck).toBe(true);
    expect(s17.shouldRewind).toBe(true);
    expect(s17.reasonCodes).toContain("stale_sha");

    const s17ExhaustedAttempts = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 3,
      rewindsUsed: 2,
      outcome: "passed",
      budgetUsed: { tokens: 300, steps: 3 },
      signals: { staleSha: true },
    });
    expect(s17ExhaustedAttempts.final).toBe("decide");
    expect(s17ExhaustedAttempts.shouldRerunCheck).toBe(false);
    expect(s17ExhaustedAttempts.shouldRewind).toBe(false);
    expect(s17ExhaustedAttempts.reasonCodes).toContain("stale_sha");

    const s17ExhaustedRewinds = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 6,
      outcome: "passed",
      budgetUsed: { tokens: 600, steps: 6 },
      signals: { staleSha: true },
    });
    expect(s17ExhaustedRewinds.final).toBe("decide");
    expect(s17ExhaustedRewinds.shouldRerunCheck).toBe(false);
    expect(s17ExhaustedRewinds.shouldRewind).toBe(false);
    expect(s17ExhaustedRewinds.reasonCodes).toContain("stale_sha");

    // Scenario 18: Clean pass + unknown outcome crash recovery
    const s18Pass = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
    });
    expect(s18Pass.final).toBe("continue");
    expect(s18Pass.shouldRewind).toBe(false);
    expect(s18Pass.ruleHits).toEqual(["step_passed"]);
    expect(s18Pass.reasonCodes).toEqual(["ok"]);

    const s18Crash = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "unknown",
      budgetUsed: { tokens: 100, steps: 1 },
    });
    expect(s18Crash.final).toBe("stop");
    expect(s18Crash.ruleHits).toContain("recovery_unknown_outcome");
    expect(s18Crash.reasonCodes).toContain("crash_during_execution");

    // Scenario 19: Review comment arrived -> notify
    const s19 = evaluateStepJudgement({
      flow,
      step: buildStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { reviewComment: "changes_requested" },
    });
    expect(s19.final).toBe("notify");
    expect(s19.reasonCodes).toContain("review_comment");

    // Scenario 20: Human acceptance criteria present -> decide
    const s20 = evaluateStepJudgement({
      flow,
      step: verifyStep,
      occurrence: 1,
      rewindsUsed: 0,
      outcome: "passed",
      budgetUsed: { tokens: 100, steps: 1 },
      signals: { hasHumanCriteria: true },
    });
    expect(s20.final).toBe("decide");
    expect(s20.reasonCodes).toContain("human_gate");
  });
});
