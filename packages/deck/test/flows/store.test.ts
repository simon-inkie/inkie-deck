import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { acquireOwnerLock, OwnerLockRequiredError } from "../../app/lib/flows/owner.server.js";
import {
  ArtifactVerificationError,
  buildBoundedAttemptId,
  buildDeterministicEffectKey,
  canonicalJsonStringify,
  HashChainCorruptionError,
  IllegalFlowTransitionError,
  openFlowsStore,
  PurgeIncompleteError,
  type FlowsStore,
} from "../../app/lib/flows/store.server.js";
import type { FlowEvent } from "../../app/lib/flows/types.js";

function withOwnedStore<T>(projectId: string, dataRoot: string, fn: (store: FlowsStore) => T): T {
  const lock = acquireOwnerLock(projectId, dataRoot);
  const store = openFlowsStore(projectId, { dataRoot, ownerLock: lock });
  try {
    return fn(store);
  } finally {
    store.close();
    lock.release();
  }
}

const GENESIS_PREV = "0".repeat(64);
const SAMPLE_YAML = "flow: sample\nversion: 1\nsteps:\n  - id: step1\n    type: agent\n";
const SAMPLE_HASH = crypto.createHash("sha256").update(SAMPLE_YAML).digest("hex");

describe("FlowsStore (store.server.ts) - Hardened Slice 1a Storage", () => {
  let scratchDir: string;
  const projectId = "test-store-project";

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-store-"));
  });

  afterEach(() => {
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("configures SQLite WAL mode, asserts PRAGMA synchronous = FULL (2), hides #db, requires ownerLock, and enforces 0700/0600 modes", () => {
    expect(() => openFlowsStore(projectId, { dataRoot: scratchDir })).toThrow(OwnerLockRequiredError);

    withOwnedStore(projectId, scratchDir, (store) => {
      expect("db" in store).toBe(false);
      expect(store.getPragmaStatus()).toEqual({ journalMode: "wal", synchronous: 2, foreignKeys: 1 });
      expect(fs.statSync(store.projectDir).mode & 0o777).toBe(0o700);
      expect(fs.statSync(store.dbPath).mode & 0o777).toBe(0o600);
    });
  });

  it("Critical 2: reopening a store with an interior tampered event throws HashChainCorruptionError on open", () => {
    const runId = "run-open-corrupt";
    let dbPath = "";
    withOwnedStore(projectId, scratchDir, (store) => {
      dbPath = store.dbPath;
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });
      const r1 = store.appendEvent({
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: "2026-11-22T22:00:00.000Z", actor: "runner", type: "run_planned",
        data: { flowRef: "sample", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
      });
      store.appendEvent({
        v: 1, runId, seq: 2, eventId: "ev-2", prev: r1.hash,
        at: "2026-11-22T22:00:01.000Z", actor: "human", type: "flow_approved",
        data: { flowHash: SAMPLE_HASH, actorId: "operator-1" },
      });

      // Tamper interior row (seq 1) offline without updating its hash
      const rawDb = new Database(dbPath);
      try {
        rawDb.prepare(`UPDATE flow_events SET line = '{"tampered":true}' WHERE run_id = ? AND seq = 1`).run(runId);
      } finally {
        rawDb.close();
      }

      // exportProjectionLines must also refuse corrupted history immediately
      expect(() => store.exportProjectionLines(runId)).toThrow(HashChainCorruptionError);
    });

    // Reopening the database MUST immediately refuse with HashChainCorruptionError
    expect(() => openFlowsStore(projectId, { dataRoot: scratchDir, readonly: true })).toThrow(HashChainCorruptionError);
  });

  it("Critical 3: rejects arbitrary text in `at` and unbounded strings in `outputs`", () => {
    const runId = "run-strict-envelope";
    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });

      // Arbitrary confidential note appended to timestamp prefix MUST be rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 1, eventId: "ev-bad-at", prev: GENESIS_PREV,
          at: "2026-11-22T12:00:00 confidential note",
          actor: "runner", type: "run_planned",
          data: { flowRef: "sample", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
        })
      ).toThrow(/Event envelope failed schema validation/);

      const r1 = store.appendEvent({
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: "2026-11-22T22:00:00.000Z", actor: "runner", type: "run_planned",
        data: { flowRef: "sample", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
      });
      const r2 = store.appendEvent({
        v: 1, runId, seq: 2, eventId: "ev-2", prev: r1.hash,
        at: "2026-11-22T22:00:01.000Z", actor: "human", type: "flow_approved",
        data: { flowHash: SAMPLE_HASH, actorId: "operator-1" },
      });
      const r3 = store.appendEvent({
        v: 1, runId, seq: 3, eventId: "ev-3", prev: r2.hash,
        at: "2026-11-22T22:00:02.000Z", actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000000, steps: 100 } },
      });
      const step1Att = buildBoundedAttemptId("step1", 1);
      const r4 = store.appendEvent({
        v: 1, runId, seq: 4, eventId: "ev-4", prev: r3.hash,
        at: "2026-11-22T22:00:03.000Z", actor: "runner", type: "step_started",
        stepId: "step1", attemptId: step1Att,
        data: { occurrence: 1, effectKey: buildDeterministicEffectKey(runId, "step1", 1) },
      });

      // Unbounded (>64 char) string in step_result.outputs MUST be rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 5, eventId: "ev-5", prev: r4.hash,
          at: "2026-11-22T22:00:04.000Z", actor: "agent", type: "step_result",
          stepId: "step1", attemptId: step1Att,
          data: { outputs: { status: "a".repeat(65) } as unknown as Record<string, string>, tokensUsed: 10, wallTimeMs: 10 },
        })
      ).toThrow(/Event envelope failed schema validation/);
    });
  });

  it("Major 1: rejects illegal transitions (run_started at seq 1, unapproved start, duplicate outcome/occurrence, batched step_started)", () => {
    const runId = "run-illegal-tx";
    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });

      // seq 1 must be run_planned
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
          at: "2026-11-22T22:00:00.000Z", actor: "runner", type: "run_started",
          data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000, steps: 5 } },
        })
      ).toThrow(IllegalFlowTransitionError);

      const r1 = store.appendEvent({
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: "2026-11-22T22:00:00.000Z", actor: "runner", type: "run_planned",
        data: { flowRef: "sample", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
      });

      // run_started before flow_approved rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 2, eventId: "ev-2", prev: r1.hash,
          at: "2026-11-22T22:00:01.000Z", actor: "runner", type: "run_started",
          data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000, steps: 5 } },
        })
      ).toThrow(IllegalFlowTransitionError);

      const r2 = store.appendEvent({
        v: 1, runId, seq: 2, eventId: "ev-2", prev: r1.hash,
        at: "2026-11-22T22:00:01.000Z", actor: "human", type: "flow_approved",
        data: { flowHash: SAMPLE_HASH, actorId: "operator-1" },
      });

      // step_started inside multi-event batch rejected (valid prev hash & deterministic effectKey isolate solo-intent guard)
      const batchStartEv: FlowEvent = {
        v: 1, runId, seq: 3, eventId: "ev-3", prev: r2.hash,
        at: "2026-11-22T22:00:02.000Z", actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000000, steps: 100 } },
      };
      const step1Att = buildBoundedAttemptId("step1", 1);
      const batchStartHash = crypto.createHash("sha256").update(canonicalJsonStringify(batchStartEv), "utf8").digest("hex");
      expect(() =>
        store.batchAppendEvents([
          { event: batchStartEv },
          {
            event: {
              v: 1, runId, seq: 4, eventId: "ev-4", prev: batchStartHash,
              at: "2026-11-22T22:00:03.000Z", actor: "runner", type: "step_started",
              stepId: "step1", attemptId: step1Att,
              data: { occurrence: 1, effectKey: buildDeterministicEffectKey(runId, "step1", 1) },
            },
          },
        ])
      ).toThrow(/step_started intent must be committed solo/);

      const r3 = store.appendEvent(batchStartEv);
      const r4 = store.appendEvent({
        v: 1, runId, seq: 4, eventId: "ev-4", prev: r3.hash,
        at: "2026-11-22T22:00:03.000Z", actor: "runner", type: "step_started",
        stepId: "step1", attemptId: step1Att,
        data: { occurrence: 1, effectKey: buildDeterministicEffectKey(runId, "step1", 1) },
      });

      const r5 = store.appendEvent({
        v: 1, runId, seq: 5, eventId: "ev-5", prev: r4.hash,
        at: "2026-11-22T22:00:04.000Z", actor: "agent", type: "step_result",
        stepId: "step1", attemptId: step1Att,
        data: { outputs: { ok: "true" }, tokensUsed: 10, wallTimeMs: 10 },
      });

      // Second outcome for same attempt rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 6, eventId: "ev-dup-out", prev: r5.hash,
          at: "2026-11-22T22:00:05.000Z", actor: "runner", type: "step_failed",
          stepId: "step1", attemptId: step1Att,
          data: { errorCode: "timeout" },
        })
      ).toThrow(/already has a recorded outcome/);

      // Settle + judge occurrence 1 cleanly so duplicate-occurrence test isolates Duplicate step occurrence
      const r6 = store.appendEvent({
        v: 1, runId, seq: 6, eventId: "ev-6", prev: r5.hash,
        at: "2026-11-22T22:00:05.000Z", actor: "system", type: "judgement",
        stepId: "step1", attemptId: step1Att,
        data: { final: "notify", ruleHits: ["retry_step"], reasonCodes: ["retry"], engineTokens: 0 },
      });

      // Duplicate occurrence 1 for step1 rejected strictly by duplicate-occurrence rule
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 7, eventId: "ev-dup-occ", prev: r6.hash,
          at: "2026-11-22T22:00:06.000Z", actor: "runner", type: "step_started",
          stepId: "step1", attemptId: step1Att,
          data: { occurrence: 1, effectKey: buildDeterministicEffectKey(runId, "step1", 1) },
        })
      ).toThrow(/Duplicate step occurrence/);
    });
  });

  it("Major 2: verifyHashChain catches relocated rows whose SQL run_id disagrees with JSON envelope runId", () => {
    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId: "run-a", flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });
      store.createRun({ runId: "run-b", flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });
      store.appendEvent({
        v: 1, runId: "run-a", seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: "2026-11-22T22:00:00.000Z", actor: "runner", type: "run_planned",
        data: { flowRef: "sample", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
      });

      // Relocate run-a's valid event row into run-b in SQL
      const rawDb = new Database(store.dbPath);
      try {
        rawDb.prepare(`UPDATE flow_events SET run_id = 'run-b' WHERE run_id = 'run-a'`).run();
      } finally {
        rawDb.close();
      }

      expect(() => store.verifyHashChain("run-b")).toThrow(HashChainCorruptionError);
    });
  });

  it("Major 3: canonicalJsonStringify omits explicit undefined keys and produces valid JSON", () => {
    const serialized = canonicalJsonStringify({ a: 1, b: undefined, c: [1, undefined, 2] });
    expect(serialized).toBe('{"a":1,"c":[1,null,2]}');
    expect(() => JSON.parse(serialized)).not.toThrow();

    withOwnedStore(projectId, scratchDir, (store) => {
      const runId = "run-undef-key";
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });
      store.appendEvent({
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: "2026-11-22T22:00:00.000Z", actor: "runner", type: "run_planned",
        privateRef: undefined,
        data: { flowRef: "sample", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
      } as FlowEvent);

      const parsed = store.getParsedEvents(runId);
      expect(parsed).toHaveLength(1);
      expect(parsed[0]!.type).toBe("run_planned");
    });
  });

  it("Major 6: recordArtifact verifies real file on disk and rejects missing or mismatched files", () => {
    const runId = "run-art-verify";
    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });

      // Missing file MUST be rejected
      expect(() =>
        store.recordArtifact({
          artifactId: "art_missing",
          runId,
          stepId: "step1",
          attemptId: "step1_1",
          name: "out.txt",
          contentHash: "a".repeat(64),
          mediaType: "text/plain",
          size: 10,
        })
      ).toThrow(ArtifactVerificationError);

      // Valid file written and verified succeeds
      const rec = store.writeAndRecordArtifact({
        artifactId: "art_real",
        runId,
        stepId: "step1",
        attemptId: "step1_1",
        name: "out.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("verified artifact bytes", "utf8"),
      });
      expect(rec.size).toBe(23);
      expect(store.getArtifact(runId, "art_real")?.content_hash).toBe(rec.contentHash);
    });
  });

  it("Major 7 & 8: links private details via CSPRNG privateRef and throws PurgeIncompleteError if WAL is blocked", () => {
    const runId = "run-priv-purge";
    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId, flowHash: SAMPLE_HASH, flowYamlBytes: SAMPLE_YAML });
      const res = store.appendEvent(
        {
          v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
          at: "2026-11-22T22:00:00.000Z", actor: "runner", type: "run_planned",
          data: { flowRef: "sample", flowHash: SAMPLE_HASH, source: "builtin", expectedDecisions: [] },
        },
        { privateDetail: "TOP-SECRET-RUN-NOTE" }
      );
      expect(res.privateRef).toMatch(/^priv_[a-f0-9]{32}$/);
      expect(store.getPrivateDetail(runId, res.privateRef!)).toBe("TOP-SECRET-RUN-NOTE");

      // Public projection line carries opaque privateRef, NEVER the secret text
      const lines = store.exportProjectionLines(runId);
      expect(lines[0]).toContain(res.privateRef!);
      expect(lines[0]).not.toContain("TOP-SECRET-RUN-NOTE");

      // Hold a read transaction open on a second connection to block WAL TRUNCATE checkpoint
      const reader = new Database(store.dbPath, { readonly: true });
      try {
        reader.exec("BEGIN TRANSACTION;");
        reader.prepare("SELECT COUNT(*) FROM flow_runs").get();

        expect(() => store.purgeRun(runId)).toThrow(PurgeIncompleteError);
      } finally {
        reader.exec("ROLLBACK;");
        reader.close();
      }

      // Once reader releases WAL snapshot, purgeRun succeeds and truncates WAL cleanly
      expect(() => store.purgeRun(runId)).not.toThrow();
      expect(store.getRun(runId)).toBeNull();
      expect(store.getPrivateDetail(runId, res.privateRef!)).toBeNull();
    });
  });
});
