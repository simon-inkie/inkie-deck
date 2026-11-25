import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireOwnerLock } from "../../app/lib/flows/owner.server.js";
import { openFlowsStore } from "../../app/lib/flows/store.server.js";
import { FlowEventSchema, type FlowEvent } from "../../app/lib/flows/types.js";

const GENESIS_PREV = "0".repeat(64);
const SAMPLE_YAML = "flow: test\nversion: 1\nsteps:\n  - id: step1\n    type: agent\n";
const SAMPLE_HASH = crypto.createHash("sha256").update(SAMPLE_YAML).digest("hex");

describe("Public Log Privacy & Store Partitioning (privacy.test.ts)", () => {
  let scratchDir: string;
  const projectId = "test-privacy-project";

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-privacy-"));
  });

  afterEach(() => {
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("prohibits synthetic free text across envelope, unallowlisted fields, and legacy plain-hash fields", () => {
    // 1. Extra field on envelope fails schema parsing
    expect(
      FlowEventSchema.safeParse({
        v: 1, runId: "run-p1", seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        extraSecret: "SYNTHETIC_EXTRA_ENVELOPE_TOKEN_111",
        data: { flowRef: "test-flow", flowHash: "0".repeat(64), source: "builtin", expectedDecisions: [] },
      }).success
    ).toBe(false);

    // 2. Extra unconstrained field in payload data (with valid required stepId/attemptId!) fails
    expect(
      FlowEventSchema.safeParse({
        v: 1, runId: "run-p1", seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "step_outcome_unknown",
        stepId: "step1", attemptId: "att1",
        data: { reasonCode: "dispatch_interrupted", leakData: "SYNTHETIC_EXTRA_PAYLOAD_TOKEN_222" },
      }).success
    ).toBe(false);

    // 3. Legacy plain SHA-256 privateDetailHash / privateErrorHash fields are REJECTED (Major 7)
    expect(
      FlowEventSchema.safeParse({
        v: 1, runId: "run-p1", seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "step_failed",
        stepId: "step1", attemptId: "att1",
        data: { errorCode: "timeout", privateErrorHash: "a".repeat(64) },
      }).success
    ).toBe(false);

    expect(
      FlowEventSchema.safeParse({
        v: 1, runId: "run-p1", seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "check_result",
        stepId: "step1", attemptId: "att1",
        data: { checkId: "check_nonempty", targetSha: "a".repeat(64), passed: false, privateDetailHash: "b".repeat(64) },
      }).success
    ).toBe(false);
  });

  it("stores private text exclusively in private_details linked by CSPRNG privateRef on public event", () => {
    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    const runId = "run-isolation-test";
    const secretPrompt = "SUPER_SECRET_INTERNAL_PROMPT_KEY_12345";

    try {
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });

      const event: FlowEvent = {
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        data: { flowRef: "test", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
      };

      const res = store.appendEvent(event, { privateDetail: secretPrompt });
      expect(res.privateRef).toMatch(/^priv_[a-f0-9]{32}$/);

      // Public projection line contains opaque privateRef and NEVER the secret text
      const projectionLines = store.exportProjectionLines(runId);
      expect(projectionLines).toHaveLength(1);
      expect(projectionLines[0]).toContain(res.privateRef!);
      expect(projectionLines[0]).not.toContain(secretPrompt);

      // Private detail is directly retrievable using the public event's privateRef
      const parsedEvent = store.getParsedEvents(runId)[0]!;
      expect(parsedEvent.privateRef).toBe(res.privateRef);
      expect(store.getPrivateDetail(runId, parsedEvent.privateRef!)).toBe(secretPrompt);
    } finally {
      store.close();
      lock.release();
    }
  });

  it("purgeRun enables secure_delete before deleting, wipes private_details, and truncates WAL", () => {
    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    const runId = "run-purge-test";
    const purgeMarker = ["purge", "detail", "marker", "for", "secure", "delete", "test"].join("-");

    try {
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });
      const res = store.appendEvent(
        {
          v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
          at: new Date().toISOString(), actor: "runner", type: "run_planned",
          data: { flowRef: "test", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
        },
        { privateDetail: purgeMarker }
      );

      // Checkpoint into the main DB first so we prove the marker genuinely reached flows.db BEFORE purge
      store.checkpointPassive();
      expect(fs.readFileSync(store.dbPath).includes(Buffer.from(purgeMarker, "utf8"))).toBe(true);

      store.purgeRun(runId);

      expect(store.getEvents(runId)).toHaveLength(0);
      expect(store.getRun(runId)).toBeNull();
      expect(store.getPrivateDetail(runId, res.privateRef!)).toBeNull();

      // Physical check: WAL file must be truncated (0 bytes) and secret absent from DB file bytes
      const walPath = store.dbPath + "-wal";
      if (fs.existsSync(walPath)) {
        expect(fs.statSync(walPath).size).toBe(0);
      }
      const dbBytes = fs.readFileSync(store.dbPath);
      expect(dbBytes.includes(Buffer.from(purgeMarker, "utf8"))).toBe(false);
    } finally {
      store.close();
      lock.release();
    }
  });
});
