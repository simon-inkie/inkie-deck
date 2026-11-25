import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  computeUnifiedDiff,
  FlowNotFoundError,
  FlowValidationError,
  listAvailableFlows,
  loadFlowDefinition,
  loadFlowDraft,
  promoteFlowDraft,
  saveFlowDraft,
} from "../../app/lib/flows/library.server.js";
import { loadRunState, PathConfinementError, SymlinkNotAllowedError } from "../../app/lib/flows/load-run.server.js";
import { approveRun, planRun, runFlow } from "../../app/lib/flows/runner.server.js";
import { IllegalFlowTransitionError } from "../../app/lib/flows/store.server.js";
import { FlowStepResultOutputsSchema } from "../../app/lib/flows/types.js";
import { validateFlowYaml } from "../../app/lib/flows/validator.js";

const SIMPLE_FLOW_YAML = `flow: sample-flow
version: 1
title: Sample Builtin Flow
steps:
  - id: step_a
    type: agent
    outputs:
      - output_file
`;

const LIBRARY_OVERRIDE_YAML = `flow: sample-flow
version: 1
title: Sample Library Override
steps:
  - id: step_a
    type: agent
    outputs:
      - output_file
`;

const PROJECT_OVERRIDE_YAML = `flow: sample-flow
version: 1
title: Sample Project Override
steps:
  - id: step_a
    type: agent
    outputs:
      - output_file
`;

const DECISION_AND_RULE_FLOW_YAML = `flow: planned-check
version: 1
title: Split Plan Approve Flow
steps:
  - id: intake
    type: decision
    title: Confirm scope
    options:
      - key: start
        label: Start
      - key: stop
        label: Stop
        end: stopped
  - id: work
    type: agent
    outputs:
      - output_file
    rules:
      - protected_path_touched: decide
`;

describe("Deck Flows Slice 3 - Library, Drafts, Diff, and Split Plan/Approve", () => {
  let scratchRoot: string;
  let dataRoot: string;
  let projectRoot: string;
  let builtinsDir: string;

  beforeEach(() => {
    scratchRoot = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-s3-lib-"));
    dataRoot = path.join(scratchRoot, "data");
    projectRoot = path.join(scratchRoot, "project");
    builtinsDir = path.join(scratchRoot, "builtins");
    fs.mkdirSync(dataRoot, { recursive: true });
    fs.mkdirSync(projectRoot, { recursive: true });
    fs.mkdirSync(builtinsDir, { recursive: true });
  });

  afterEach(() => {
    if (scratchRoot && fs.existsSync(scratchRoot)) {
      fs.rmSync(scratchRoot, { recursive: true, force: true });
    }
  });

  it("validates built-in flows/library/ticket-to-pr.yaml cleanly via single validateFlowYaml boundary", () => {
    const loaded = loadFlowDefinition("ticket-to-pr", { dataRoot });
    expect(loaded.source).toBe("builtin");
    expect(loaded.flowRef).toBe("ticket-to-pr");
    expect(loaded.flow.flow).toBe("ticket-to-pr");
    expect(loaded.flow.workspace).toEqual({ kind: "git-worktree", base: "main" });
    expect(loaded.flow.roles?.["reviewer"]?.differs_from).toBe("builder");
    expect(loaded.flow.steps.map((s) => s.id)).toEqual([
      "intake",
      "build",
      "verify",
      "review",
      "ready",
    ]);

    const directValidation = validateFlowYaml(loaded.yaml);
    expect(directValidation.valid).toBe(true);
    if (directValidation.valid) {
      expect(directValidation.hash).toBe(loaded.hash);
    }
  });

  it("enforces strict lookup precedence: project > library > builtin", () => {
    fs.writeFileSync(path.join(builtinsDir, "sample-flow.yaml"), SIMPLE_FLOW_YAML, "utf8");

    const fromBuiltin = loadFlowDefinition("sample-flow", { projectRoot, dataRoot, builtinsDir });
    expect(fromBuiltin.source).toBe("builtin");
    expect(fromBuiltin.flow.title).toBe("Sample Builtin Flow");

    const libDir = path.join(dataRoot, "flows", "library");
    fs.mkdirSync(libDir, { recursive: true });
    fs.writeFileSync(path.join(libDir, "sample-flow.yaml"), LIBRARY_OVERRIDE_YAML, "utf8");

    const fromLibrary = loadFlowDefinition("sample-flow", { projectRoot, dataRoot, builtinsDir });
    expect(fromLibrary.source).toBe("library");
    expect(fromLibrary.flow.title).toBe("Sample Library Override");

    const projFlowsDir = path.join(projectRoot, ".deck", "flows");
    fs.mkdirSync(projFlowsDir, { recursive: true });
    fs.writeFileSync(path.join(projFlowsDir, "sample-flow.yaml"), PROJECT_OVERRIDE_YAML, "utf8");

    const fromProject = loadFlowDefinition("sample-flow", { projectRoot, dataRoot, builtinsDir });
    expect(fromProject.source).toBe("project");
    expect(fromProject.flow.title).toBe("Sample Project Override");

    const listed = listAvailableFlows({ projectRoot, dataRoot, builtinsDir });
    const entry = listed.flows.find((f) => f.flowRef === "sample-flow");
    expect(entry?.source).toBe("project");
    expect(entry?.title).toBe("Sample Project Override");
  });

  it("rejects path traversal, invalid flow names, and symlink escapes", () => {
    expect(() => loadFlowDefinition("../escape", { projectRoot, dataRoot, builtinsDir })).toThrow(
      PathConfinementError,
    );
    expect(() => loadFlowDefinition("nested/flow", { projectRoot, dataRoot, builtinsDir })).toThrow(
      PathConfinementError,
    );
    expect(() => loadFlowDefinition("missing-flow", { projectRoot, dataRoot, builtinsDir })).toThrow(
      FlowNotFoundError,
    );

    const outsideFile = path.join(scratchRoot, "outside.yaml");
    fs.writeFileSync(outsideFile, SIMPLE_FLOW_YAML, "utf8");
    const projFlowsDir = path.join(projectRoot, ".deck", "flows");
    fs.mkdirSync(projFlowsDir, { recursive: true });
    fs.symlinkSync(outsideFile, path.join(projFlowsDir, "linked-flow.yaml"));

    expect(() =>
      loadFlowDefinition("linked-flow", { projectRoot, dataRoot, builtinsDir }),
    ).toThrow(SymlinkNotAllowedError);
  });

  it("validates drafts before writing, computes unified diff from template, and promotes drafts", () => {
    fs.writeFileSync(path.join(builtinsDir, "sample-flow.yaml"), SIMPLE_FLOW_YAML, "utf8");

    // Invalid YAML is rejected BEFORE any file is created on disk
    expect(() =>
      saveFlowDraft({
        projectRoot,
        draftName: "bad-draft",
        yaml: "flow: bad-draft\nversion: 2\nsteps: []\n",
      }),
    ).toThrow(FlowValidationError);
    expect(
      fs.existsSync(path.join(projectRoot, ".deck", "flows", "drafts", "bad-draft.yaml")),
    ).toBe(false);

    const draftYaml = SIMPLE_FLOW_YAML.replace("Sample Builtin Flow", "Custom Draft Flow");
    const saved = saveFlowDraft({
      projectRoot,
      draftName: "custom-draft",
      yaml: draftYaml,
      baseTemplateRef: "sample-flow",
      dataRoot,
      builtinsDir,
    });
    expect(saved.flow.title).toBe("Custom Draft Flow");
    expect(saved.diffFromTemplate).toContain("--- builtin/sample-flow.yaml");
    expect(saved.diffFromTemplate).toContain("+++ drafts/custom-draft.yaml");
    expect(saved.diffFromTemplate).toContain("-title: Sample Builtin Flow");
    expect(saved.diffFromTemplate).toContain("+title: Custom Draft Flow");

    const loadedDraft = loadFlowDraft({ projectRoot, draftName: "custom-draft" });
    expect(loadedDraft.hash).toBe(saved.hash);

    const listing = listAvailableFlows({ projectRoot, dataRoot, builtinsDir });
    expect(listing.drafts.map((d) => d.draftName)).toContain("custom-draft");

    // Promote to library and project
    const promotedLib = promoteFlowDraft({
      projectRoot,
      draftName: "custom-draft",
      target: "library",
      dataRoot,
    });
    expect(promotedLib.source).toBe("library");
    expect(
      loadFlowDefinition("custom-draft", { dataRoot, builtinsDir }).source,
    ).toBe("library");

    const promotedProj = promoteFlowDraft({
      projectRoot,
      draftName: "custom-draft",
      target: "project",
      dataRoot,
    });
    expect(promotedProj.source).toBe("project");
    expect(
      loadFlowDefinition("custom-draft", { projectRoot, dataRoot, builtinsDir }).source,
    ).toBe("project");

    // Deterministic pure diff with identical inputs has no hunks
    const noDiff = computeUnifiedDiff(draftYaml, draftYaml, "a.yaml", "b.yaml");
    expect(noDiff).toBe("--- a.yaml\n+++ b.yaml\n");
  });

  it("enforces split planRun and approveRun invariants (unapproved refused, wrong hash refused, duplicate refused)", async () => {
    const projectId = "proj-split-approve";
    const runId = "run-split-1";

    const planned = planRun({
      projectId,
      runId,
      flowYaml: DECISION_AND_RULE_FLOW_YAML,
      source: "project",
      dataRoot,
    });
    expect(planned.runId).toBe(runId);
    expect(planned.expectedDecisions).toEqual(["intake", "work"]);

    const loadedBefore = loadRunState(projectId, runId, { dataRoot });
    expect(loadedBefore.state.status).toBe("planned");
    expect(loadedBefore.events).toHaveLength(1);
    expect(loadedBefore.events[0]!.type).toBe("run_planned");

    // Unapproved run MUST NOT execute
    await expect(runFlow(projectId, runId, { dataRoot })).rejects.toThrow(/not approved/i);

    // Mismatched hash MUST be refused
    expect(() =>
      approveRun({
        projectId,
        runId,
        flowHash: "f".repeat(64),
        actorId: "operator-1",
        dataRoot,
      }),
    ).toThrow(IllegalFlowTransitionError);

    // Invalid actorId MUST be refused
    expect(() =>
      approveRun({
        projectId,
        runId,
        flowHash: planned.flowHash,
        actorId: "bad actor id with spaces",
        dataRoot,
      }),
    ).toThrow(/Invalid actorId/);

    // Exact hash approval succeeds
    approveRun({
      projectId,
      runId,
      flowHash: planned.flowHash,
      actorId: "operator-1",
      dataRoot,
    });

    // Duplicate approval MUST be refused
    expect(() =>
      approveRun({
        projectId,
        runId,
        flowHash: planned.flowHash,
        actorId: "operator-1",
        dataRoot,
      }),
    ).toThrow(IllegalFlowTransitionError);

    const loadedApproved = loadRunState(projectId, runId, { dataRoot });
    expect(loadedApproved.state.status).toBe("approved");
    expect(loadedApproved.events).toHaveLength(2);
    expect(loadedApproved.events[1]!.type).toBe("flow_approved");

    // Approved run now executes up to intake decision gate
    const res = await runFlow(projectId, runId, { dataRoot });
    expect(res.finalStatus).toBe("waiting_decision");
  }, 15_000);

  it("enforces strict public output schemas for Slice 3 outputs without permitting free text", () => {
    const valid = FlowStepResultOutputsSchema.safeParse({
      status: "ok",
      branch: "flow-run1-build_1",
      head_sha: "a".repeat(40),
      base_sha: "b".repeat(40),
      repro_test: "test/repro-bug.test.mjs",
    });
    expect(valid.success).toBe(true);

    // Reject free text / spaces in branch, invalid SHA, traversal in repro_test, unknown keys
    expect(
      FlowStepResultOutputsSchema.safeParse({ branch: "branch with spaces" }).success,
    ).toBe(false);
    expect(
      FlowStepResultOutputsSchema.safeParse({ head_sha: "not-a-40-hex-sha" }).success,
    ).toBe(false);
    expect(
      FlowStepResultOutputsSchema.safeParse({ repro_test: "../escape.test.mjs" }).success,
    ).toBe(false);
    expect(
      FlowStepResultOutputsSchema.safeParse({ repro_test: "/abs/path.test.mjs" }).success,
    ).toBe(false);
    expect(
      FlowStepResultOutputsSchema.safeParse({ extra_free_text: "hello" }).success,
    ).toBe(false);
  });

  it("R1-7: skips malformed yaml in .deck/flows and drafts while still failing closed on symlinks", () => {
    const projFlowsDir = path.join(projectRoot, ".deck", "flows");
    const draftsDir = path.join(projFlowsDir, "drafts");
    fs.mkdirSync(draftsDir, { recursive: true });
    fs.writeFileSync(path.join(projFlowsDir, "good-flow.yaml"), SIMPLE_FLOW_YAML, "utf8");
    fs.writeFileSync(path.join(projFlowsDir, "broken-flow.yaml"), "flow: [unclosed\n", "utf8");
    fs.writeFileSync(path.join(draftsDir, "broken-draft.yaml"), "flow: bad\nversion: 99\n", "utf8");

    const listed = listAvailableFlows({ projectRoot, dataRoot });
    expect(listed.flows.map((f) => f.flowRef)).toContain("ticket-to-pr");
    expect(listed.flows.map((f) => f.flowRef)).toContain("good-flow");
    expect(listed.flows.map((f) => f.flowRef)).not.toContain("broken-flow");
    expect(listed.drafts.map((d) => d.draftName)).not.toContain("broken-draft");

    // Symlink escape inside .deck/flows STILL fails closed
    const outside = path.join(scratchRoot, "outside-scan.yaml");
    fs.writeFileSync(outside, SIMPLE_FLOW_YAML, "utf8");
    fs.symlinkSync(outside, path.join(projFlowsDir, "symlink-flow.yaml"));
    expect(() => listAvailableFlows({ projectRoot, dataRoot })).toThrow(SymlinkNotAllowedError);
  });
});
