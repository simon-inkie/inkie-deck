/**
 * e2e/flows/flows-1b.spec.ts - Playwright E2E tests for Deck Flows Slice 1b
 * (read-only card stream over live SQLite DB).
 *
 * ASCII only - no em-dashes.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { acquireOwnerLock } from "../../app/lib/flows/owner.server.js";
import {
  buildBoundedAttemptId,
  buildDeterministicEffectKey,
  openFlowsStore,
} from "../../app/lib/flows/store.server.js";
import type { FlowEvent } from "../../app/lib/flows/types.js";
import { assertGitClean } from "./helpers.js";

const GENESIS_PREV = "0".repeat(64);

const FLOW_YAML = [
  "flow: e2e-two-step",
  "version: 1",
  "title: E2E two-step flow",
  "limits:",
  "  max_attempts: 3",
  "  budget:",
  "    tokens: 5000",
  "    steps: 10",
  "steps:",
  "  - id: generate",
  "    type: agent",
  "    role: builder",
  "    prompt: Generate output",
  "    outputs:",
  "      - output_file",
  "  - id: verify",
  "    type: check",
  "    against: generate.output_file",
  "    run:",
  "      - check_nonempty",
  "    on_fail:",
  "      goto: generate",
].join("\n");

const FLOW_HASH = crypto
  .createHash("sha256")
  .update(FLOW_YAML, "utf8")
  .digest("hex");

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function makeIso(seq: number): string {
  return new Date(Date.UTC(2026, 10, 24, 14, 0, seq)).toISOString();
}

function getDataRoot(): string {
  const dataRoot = process.env["DATA_ROOT"];
  if (!dataRoot) {
    throw new Error("DATA_ROOT not set - globalSetup did not run");
  }
  return dataRoot;
}

function resetFlowsRoot(): void {
  const flowsDir = path.join(getDataRoot(), "flows");
  fs.rmSync(flowsDir, { recursive: true, force: true });
}

test.beforeEach(() => {
  resetFlowsRoot();
});

test.afterAll(() => {
  resetFlowsRoot();
  assertGitClean(path.resolve("."));
});

test("renders empty state when no flow runs exist and exposes Flows nav link", async ({
  page,
}) => {
  await page.goto("/flows");
  await expect(page.getByRole("link", { name: "Flows" })).toBeVisible();
  await expect(page.getByTestId("flows-empty")).toBeVisible();
});

test("renders card stream from live SQLite DB, expands evidence, and updates live via polling", async ({
  page,
}) => {
  const dataRoot = getDataRoot();
  const projectId = "e2e-flow-proj";
  const runId = "e2e-run-1";

  const lock = acquireOwnerLock(projectId, dataRoot);
  const store = openFlowsStore(projectId, { dataRoot, ownerLock: lock });
  let seq = 0;
  let prev = GENESIS_PREV;
  let artHash = "";

  function push(
    body: DistributiveOmit<FlowEvent, "v" | "seq" | "eventId" | "prev" | "at"> & {
      runId: string;
    },
  ) {
    seq += 1;
    const res = store.appendEvent({
      v: 1,
      seq,
      eventId: `ev_${seq}`,
      prev,
      at: makeIso(seq),
      ...body,
    } as FlowEvent);
    seq = res.seq;
    prev = res.hash;
  }

  try {
    store.createAndApproveRun({
      runId,
      flowRef: "e2e-two-step",
      flowHash: FLOW_HASH,
      flowYamlBytes: FLOW_YAML,
      source: "project",
      expectedDecisions: [],
      actorId: "operator",
    });
    seq = 2;
    prev = store.getEvents(runId)[1]!.hash;

    push({
      runId,
      actor: "runner",
      type: "run_started",
      data: {
        runnerVersion: "0.1.0",
        inputIds: {},
        budget: { tokens: 5000, steps: 10 },
      },
    });

    const genAtt = buildBoundedAttemptId("generate", 1);
    const genEff = buildDeterministicEffectKey(runId, "generate", 1);
    push({
      runId,
      actor: "runner",
      type: "step_started",
      stepId: "generate",
      attemptId: genAtt,
      data: { occurrence: 1, effectKey: genEff },
    });

    const art = store.writeAndRecordArtifact({
      artifactId: "art_e2e_1",
      runId,
      stepId: "generate",
      attemptId: genAtt,
      name: "output_file",
      mediaType: "text/plain",
      bytes: Buffer.from("e2e-verified-output\n", "utf8"),
    });
    artHash = art.contentHash;

    push({
      runId,
      actor: "runner",
      type: "artefact_recorded",
      stepId: "generate",
      attemptId: genAtt,
      data: {
        artefactId: "art_e2e_1",
        sha256: art.contentHash,
        sizeBytes: art.size,
      },
    });
    push({
      runId,
      actor: "agent",
      type: "step_result",
      stepId: "generate",
      attemptId: genAtt,
      data: {
        outputs: { status: "ok", output_file: art.contentHash },
        tokensUsed: 210,
        wallTimeMs: 95,
      },
    });
    push({
      runId,
      actor: "system",
      type: "judgement",
      stepId: "generate",
      attemptId: genAtt,
      data: {
        final: "continue",
        ruleHits: ["step_passed"],
        reasonCodes: ["ok"],
        engineTokens: 0,
      },
    });

    const verAtt = buildBoundedAttemptId("verify", 1);
    const verEff = buildDeterministicEffectKey(runId, "verify", 1);
    push({
      runId,
      actor: "runner",
      type: "step_started",
      stepId: "verify",
      attemptId: verAtt,
      data: { occurrence: 1, effectKey: verEff },
    });

    await page.goto(`/flows?project=${projectId}&run=${runId}`);

    await expect(page.getByTestId("flow-run-status")).toHaveText("running");
    await expect(page.getByTestId("flow-planning-approval")).toHaveText("Approved");
    await expect(page.getByTestId("flow-budget-summary")).toContainText(
      "Steps: 2 / 10 | Tokens: 210 / 5000",
    );
    await expect(page.getByTestId("flow-step-card-generate")).toHaveAttribute(
      "data-card-state",
      "done",
    );
    await expect(page.getByTestId("flow-step-card-verify")).toHaveAttribute(
      "data-card-state",
      "current",
    );

    const evidenceDetails = page.getByTestId("flow-step-evidence-generate");
    await evidenceDetails.locator("summary").click();
    await expect(evidenceDetails).toContainText("art_e2e_1");
    await expect(evidenceDetails).toContainText(artHash.slice(0, 12));

    // Append completion batch while writer holds ownerLock; polling should update UI to finished
    store.appendChainedBatch(runId, [
      (s, p) => ({
        event: {
          v: 1,
          runId,
          seq: s,
          eventId: `ev_${s}`,
          prev: p,
          at: makeIso(s),
          actor: "runner",
          stepId: "verify",
          attemptId: verAtt,
          type: "check_result",
          data: {
            checkId: "check_nonempty",
            targetSha: artHash,
            passed: true,
          },
        },
      }),
      (s, p) => ({
        event: {
          v: 1,
          runId,
          seq: s,
          eventId: `ev_${s}`,
          prev: p,
          at: makeIso(s),
          actor: "runner",
          stepId: "verify",
          attemptId: verAtt,
          type: "step_result",
          data: {
            outputs: { check: "passed" },
            tokensUsed: 0,
            wallTimeMs: 10,
          },
        },
      }),
      (s, p) => ({
        event: {
          v: 1,
          runId,
          seq: s,
          eventId: `ev_${s}`,
          prev: p,
          at: makeIso(s),
          actor: "system",
          stepId: "verify",
          attemptId: verAtt,
          type: "judgement",
          data: {
            final: "continue",
            ruleHits: ["check_passed"],
            reasonCodes: ["ok"],
            engineTokens: 0,
          },
        },
      }),
      (s, p) => ({
        event: {
          v: 1,
          runId,
          seq: s,
          eventId: `ev_${s}`,
          prev: p,
          at: makeIso(s),
          actor: "system",
          type: "run_finished",
          data: {
            outcome: "done",
            reasonCode: "completed",
          },
        },
      }),
    ]);

    await expect(page.getByTestId("flow-run-status")).toHaveText("finished", {
      timeout: 8_000,
    });
    await expect(page.getByTestId("flow-terminal-banner")).toContainText("done");
    await expect(page.getByTestId("flow-step-card-verify")).toHaveAttribute(
      "data-card-state",
      "done",
    );
  } finally {
    store.close();
    lock.release();
  }
});

test("read-only API refuses POST with 405 and invalid project queries with 400", async ({
  request,
}) => {
  const postRes = await request.post("/api/flows");
  expect(postRes.status()).toBe(405);
  expect(postRes.headers()["allow"]).toBe("GET");

  const badRes = await request.get("/api/flows?project=../escape");
  expect(badRes.status()).toBe(400);
});
