/**
 * review-round3-adversarial.test.ts - Focused verification suite for Slice 1a
 * security boundaries, declarative transition table, confinement, and determinism.
 */
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import {
  acquireOwnerLock,
  assertSafeRegularLstatInDirFd,
  checkFilesystemSafety,
  isOwnerLocked,
  openDirFdNoFollow,
  OwnerLockRequiredError,
  resolveFlowsRootDir,
  resolveProjectDataDir,
  RunnerLockBusyError,
  snapshotProcFds,
  UnsafeFilesystemError,
  verifyOpenedSqliteFileInDirFd,
} from "../../app/lib/flows/owner.server.js";
import { reduceFlowRun } from "../../app/lib/flows/replay.js";
import { buildCollisionFreeArtifactId, planAndApproveRun, runFlow } from "../../app/lib/flows/runner.server.js";
import * as storeModule from "../../app/lib/flows/store.server.js";
import {
  ArtifactVerificationError,
  buildBoundedAttemptId,
  buildDeterministicEffectKey,
  canonicalJsonStringify,
  HashChainCorruptionError,
  IllegalFlowTransitionError,
  openFlowsStore,
  StepDeadlineExceededError,
  type FlowsStore,
} from "../../app/lib/flows/store.server.js";
import type { FlowDefinition, FlowEvent } from "../../app/lib/flows/types.js";

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

const TWO_STEP_YAML = `flow: adv-two-step
version: 1
limits:
  budget:
    tokens: 50000
    steps: 10
steps:
  - id: draft_step
    type: agent
  - id: verify_step
    type: check
`;

const ONE_STEP_YAML = `flow: adv-one-step
version: 1
limits:
  budget:
    tokens: 100
    steps: 1
steps:
  - id: only_step
    type: agent
`;

const CHECK_ONLY_YAML = `flow: adv-check-only
version: 1
steps:
  - id: verify_only
    type: check
`;

const ONE_STEP_HASH = crypto.createHash("sha256").update(ONE_STEP_YAML).digest("hex");

describe("Flows Slice 1a Structural Security & Transition Table Suite", () => {
  let scratchDir: string;
  const projectId = "adv-r5-proj";

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-r5-"));
  });

  afterEach(() => {
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("Critical 1 & 2 (Encapsulation & Privacy): FlowsStore constructor hidden, #db private, ownerLock required, caller private refs & forged check_result rejected", () => {
    // FlowsStore class must NOT be exported at runtime
    expect("FlowsStore" in storeModule).toBe(false);

    const runId = "run-encap-priv";
    planAndApproveRun({ projectId, runId, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });

    // Major 1: Writable store without OwnerLock refused; #db & #appendItemsInOpenTx are runtime-private; released lock revokes writes
    expect(() => openFlowsStore(projectId, { dataRoot: scratchDir })).toThrow(OwnerLockRequiredError);
    const shortLock = acquireOwnerLock(projectId, scratchDir);
    const staleStore = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: shortLock });
    expect("db" in staleStore).toBe(false);
    expect("appendItemsInOpenTx" in staleStore).toBe(false);
    shortLock.release();
    expect(() =>
      staleStore.allocateAndAppendStepIntent({ runId, stepId: "only_step" }),
    ).toThrow(OwnerLockRequiredError);
    staleStore.close();

    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(runId)[1]!;
      const r3 = store.appendEvent({
        v: 1, runId, seq: 3, eventId: "ev3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });

      // Critical 2 (Round 7): Builder calling lock.release() MUST throw OwnerLockRequiredError and roll back!
      const revLock = acquireOwnerLock("adv-rev-proj", scratchDir);
      const revStore = openFlowsStore("adv-rev-proj", { dataRoot: scratchDir, ownerLock: revLock });
      try {
        revStore.createAndApproveRun({
          runId: "run-rev", flowRef: "adv-one-step", flowHash: ONE_STEP_HASH,
          flowYamlBytes: ONE_STEP_YAML, source: "builtin", expectedDecisions: [], actorId: "op-1",
        });
        expect(() =>
          revStore.appendChainedBatch("run-rev", [
            (seq, prev) => {
              revLock.release();
              return {
                event: {
                  v: 1, runId: "run-rev", seq, eventId: "ev_rev_start", prev,
                  at: new Date().toISOString(), actor: "runner", type: "run_started",
                  data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
                },
              };
            },
          ]),
        ).toThrow(OwnerLockRequiredError);
        // Zero rows committed after release
        expect(revStore.getEvents("run-rev")).toHaveLength(2);
      } finally {
        revStore.close();
        revLock.release();
      }

      // Critical 2 (Round 7): 1-builder array whose getter pushes a 2nd outcome builder MUST NOT bypass solo-intent!
      const mutRun = "run-mut-batch";
      store.createAndApproveRun({
        runId: mutRun, flowRef: "adv-one-step", flowHash: ONE_STEP_HASH,
        flowYamlBytes: ONE_STEP_YAML, source: "builtin", expectedDecisions: [], actorId: "op-1",
      });
      const mutEv2 = store.getEvents(mutRun)[1]!;
      store.appendEvent({
        v: 1, runId: mutRun, seq: 3, eventId: "ev_m3", prev: mutEv2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });
      const mutBuilders: Array<(seq: number, prev: string) => { event: FlowEvent }> = [];
      mutBuilders.push((seq, prev) => ({
        get event(): FlowEvent {
          mutBuilders.push((seq2, prev2) => ({
            event: {
              v: 1, runId: mutRun, seq: seq2, eventId: "ev_mut_res", prev: prev2,
              at: new Date().toISOString(), actor: "agent", type: "step_result",
              stepId: "only_step", attemptId: "att_mut_1",
              data: { outputs: { status: "ok" }, tokensUsed: 1, wallTimeMs: 1 },
            },
          }));
          return {
            v: 1, runId: mutRun, seq, eventId: "ev_mut_start", prev,
            at: new Date().toISOString(), actor: "runner", type: "step_started",
            stepId: "only_step", attemptId: buildBoundedAttemptId("only_step", 1),
            data: { occurrence: 1, effectKey: buildDeterministicEffectKey(mutRun, "only_step", 1) },
          };
        },
      }));
      const mutOut = store.appendChainedBatch(mutRun, mutBuilders);
      expect(mutOut).toHaveLength(1);
      expect(store.getParsedEvents(mutRun).some((e) => e.type === "step_result")).toBe(false);

      // Major 1: Reentrant allocateAndAppendStepIntent inside appendChainedBatch builder MUST be rejected
      expect(() =>
        store.appendChainedBatch(runId, [
          (seq, prev) => {
            store.allocateAndAppendStepIntent({ runId, stepId: "only_step" });
            return {
              event: {
                v: 1, runId, seq, eventId: "ev_r", prev,
                at: new Date().toISOString(), actor: "system", type: "run_finished",
                data: { outcome: "stopped", reasonCode: "manual_stop" },
              },
            };
          },
        ]),
      ).toThrow(/Reentrant store mutation/);

      // Top-level/nested caller-supplied private refs AND all 5 reserved Slice 1a events rejected with isolated negatives
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 4, eventId: "ev_priv1", prev: r3.hash,
          at: new Date().toISOString(), actor: "human", type: "operator_input",
          data: { attemptId: "att_1", privateRef: `priv_${"a".repeat(32)}` },
        }),
      ).toThrow(IllegalFlowTransitionError);

      for (const reservedEvent of [
        { type: "run_released", data: { epoch: 1 } },
        { type: "run_claimed", data: { epoch: 1, machine: "host-1" } },
        { type: "child_started", data: { childRunId: "child-1", flowHash: "a".repeat(64), budget: { tokens: 10, steps: 1 } } },
        { type: "child_finished", data: { childRunId: "child-1", outcome: "done", headSeq: 1, headHash: "a".repeat(64) } },
        { type: "operator_input", data: { attemptId: "att_1" } },
      ] as const) {
        expect(() =>
          store.appendEvent({
            v: 1, runId, seq: 4, eventId: `ev_${reservedEvent.type}`, prev: r3.hash,
            at: new Date().toISOString(), actor: "system",
            ...reservedEvent,
          } as FlowEvent),
        ).toThrow(/reserved for a later slice/);
      }

      const intent = store.allocateAndAppendStepIntent({ runId, stepId: "only_step" });
      // Local SQL receipt WITHOUT public artefact_recorded event STILL cannot authorize 64-hex output value
      const art = store.writeAndRecordArtifact({
        artifactId: "art_local_only",
        runId, stepId: "only_step", attemptId: intent.attemptId,
        name: "local.txt", mediaType: "text/plain", bytes: Buffer.from("local only", "utf8"),
      });
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: intent.seq + 1, eventId: "ev_hex_unpub", prev: intent.hash,
          at: new Date().toISOString(), actor: "agent", type: "step_result",
          stepId: "only_step", attemptId: intent.attemptId,
          data: { outputs: { status: art.contentHash }, tokensUsed: 10, wallTimeMs: 5 },
        }),
      ).toThrow(/without a public artefact_recorded event/);

      // Unlinking artefact file between receipt and artefact_recorded MUST be refused at append time
      fs.unlinkSync(art.filePath);
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: intent.seq + 1, eventId: "ev_art_unlinked", prev: intent.hash,
          at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
          stepId: "only_step", attemptId: intent.attemptId,
          data: { artefactId: "art_local_only", sha256: art.contentHash, sizeBytes: art.size },
        }),
      ).toThrow(ArtifactVerificationError);
    });

    // Critical 2: Store append API rejects forged checkId, unrecorded 64-hex targetSha on FAILED checks too,
    // wrong checkId for pinned check_nonempty, wrong targetSha for pinned `against`, and duplicate check_result
    const chkRun = "run-forged-check";
    planAndApproveRun({ projectId, runId: chkRun, flowYaml: CHECK_ONLY_YAML, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(chkRun)[1]!;
      store.appendEvent({
        v: 1, runId: chkRun, seq: 3, eventId: "ev3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000000, steps: 100 } },
      });
      const intent = store.allocateAndAppendStepIntent({ runId: chkRun, stepId: "verify_only" });

      // Forged freeform checkId rejected by schema
      expect(() =>
        store.appendEvent({
          v: 1, runId: chkRun, seq: intent.seq + 1, eventId: "ev_bad_cid", prev: intent.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "verify_only", attemptId: intent.attemptId,
          data: { checkId: "internal-reset-code-1234" as unknown as "check_nonempty", targetSha: "a".repeat(64), passed: true },
        }),
      ).toThrow(/schema validation/);

      // Unrecorded 64-hex secret in targetSha on FAILED check_result rejected (Critical 2!)
      expect(() =>
        store.appendEvent({
          v: 1, runId: chkRun, seq: intent.seq + 1, eventId: "ev_fail_secret", prev: intent.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "verify_only", attemptId: intent.attemptId,
          data: { checkId: "check_nonempty", targetSha: "deadbeef".repeat(8), passed: false },
        }),
      ).toThrow(/64 zeros or a publicly recorded artefact_recorded/);

      // Wrong checkId ("check_exists" when pinned default is "check_nonempty") rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId: chkRun, seq: intent.seq + 1, eventId: "ev_wrong_pred", prev: intent.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "verify_only", attemptId: intent.attemptId,
          data: { checkId: "check_exists", targetSha: "0".repeat(64), passed: false },
        }),
      ).toThrow(/disagrees with pinned check requirement/);

      // Duplicate check_result on same attempt rejected
      const failedChk = store.appendEvent({
        v: 1, runId: chkRun, seq: intent.seq + 1, eventId: "ev_fail_chk", prev: intent.hash,
        at: new Date().toISOString(), actor: "runner", type: "check_result",
        stepId: "verify_only", attemptId: intent.attemptId,
        data: { checkId: "check_nonempty", targetSha: "0".repeat(64), passed: false },
      });
      expect(() =>
        store.appendEvent({
          v: 1, runId: chkRun, seq: failedChk.seq + 1, eventId: "ev_dup_chk", prev: failedChk.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "verify_only", attemptId: intent.attemptId,
          data: { checkId: "check_nonempty", targetSha: "0".repeat(64), passed: false },
        }),
      ).toThrow(/already has a recorded check_result/);
    });

    // Critical 2: Pinned `against: g1.a1` with `check_nonempty` rejects passing check_result pointing at g2.a2
    const targetPinYaml = `flow: pin-target\nversion: 1\nsteps:\n  - id: g1\n    type: agent\n    outputs: [a1]\n  - id: g2\n    type: agent\n    outputs: [a2]\n  - id: ver\n    type: check\n    against: g1.a1\n    run: [check_nonempty]\n`;
    const tpRun = "run-pin-against";
    planAndApproveRun({ projectId, runId: tpRun, flowYaml: targetPinYaml, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(tpRun)[1]!;
      store.appendEvent({
        v: 1, runId: tpRun, seq: 3, eventId: "ev3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000000, steps: 100 } },
      });
      // Complete g1 with 0-byte artefact named a1 AND a second non-empty artefact from the SAME attempt
      // with artifactId === "a1" and receipt name === "other" (Critical 1 output-name shadowing attack!)
      const i1 = store.allocateAndAppendStepIntent({ runId: tpRun, stepId: "g1" });
      const rec1 = store.writeAndRecordArtifact({
        artifactId: "art_g1", runId: tpRun, stepId: "g1", attemptId: i1.attemptId,
        name: "a1", mediaType: "text/plain", bytes: Buffer.alloc(0),
      });
      const a1 = store.appendEvent({
        v: 1, runId: tpRun, seq: i1.seq + 1, eventId: "ea1", prev: i1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "g1", attemptId: i1.attemptId,
        data: { artefactId: "art_g1", sha256: rec1.contentHash, sizeBytes: 0 },
      });
      const recShadow = store.writeAndRecordArtifact({
        artifactId: "a1", runId: tpRun, stepId: "g1", attemptId: i1.attemptId,
        name: "other", mediaType: "text/plain", bytes: Buffer.from("shadowing nonempty", "utf8"),
      });
      const aShadow = store.appendEvent({
        v: 1, runId: tpRun, seq: a1.seq + 1, eventId: "ea1_shadow", prev: a1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "g1", attemptId: i1.attemptId,
        data: { artefactId: "a1", sha256: recShadow.contentHash, sizeBytes: recShadow.size },
      });
      const r1 = store.appendEvent({
        v: 1, runId: tpRun, seq: aShadow.seq + 1, eventId: "er1", prev: aShadow.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "g1", attemptId: i1.attemptId, data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId: tpRun, seq: r1.seq + 1, eventId: "ej1", prev: r1.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "g1", attemptId: i1.attemptId, data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      const i2 = store.allocateAndAppendStepIntent({ runId: tpRun, stepId: "g2" });
      const rec2 = store.writeAndRecordArtifact({
        artifactId: "art_g2", runId: tpRun, stepId: "g2", attemptId: i2.attemptId,
        name: "a2", mediaType: "text/plain", bytes: Buffer.from("nonempty g2", "utf8"),
      });
      const a2 = store.appendEvent({
        v: 1, runId: tpRun, seq: i2.seq + 1, eventId: "ea2", prev: i2.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "g2", attemptId: i2.attemptId,
        data: { artefactId: "art_g2", sha256: rec2.contentHash, sizeBytes: rec2.size },
      });
      const r2 = store.appendEvent({
        v: 1, runId: tpRun, seq: a2.seq + 1, eventId: "er2", prev: a2.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "g2", attemptId: i2.attemptId, data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId: tpRun, seq: r2.seq + 1, eventId: "ej2", prev: r2.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "g2", attemptId: i2.attemptId, data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      const i3 = store.allocateAndAppendStepIntent({ runId: tpRun, stepId: "ver" });
      // Critical 1: Shadowing artefact with ID "a1" and receipt name "other" MUST NOT satisfy pinned g1.a1
      expect(() =>
        store.appendEvent({
          v: 1, runId: tpRun, seq: i3.seq + 1, eventId: "ec_shadow", prev: i3.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "ver", attemptId: i3.attemptId,
          data: { checkId: "check_nonempty", targetSha: recShadow.contentHash, passed: true },
        }),
      ).toThrow(/does not match pinned against target/);
      // Passing check_nonempty against g2's SHA instead of pinned g1.a1 MUST be rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId: tpRun, seq: i3.seq + 1, eventId: "ec_wrong_art", prev: i3.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "ver", attemptId: i3.attemptId,
          data: { checkId: "check_nonempty", targetSha: rec2.contentHash, passed: true },
        }),
      ).toThrow(/does not match pinned against target/);
      // Passing check_exists against 0-byte g1.a1 when pinned step requires check_nonempty MUST be rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId: tpRun, seq: i3.seq + 1, eventId: "ec_wrong_check", prev: i3.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "ver", attemptId: i3.attemptId,
          data: { checkId: "check_exists", targetSha: rec1.contentHash, passed: true },
        }),
      ).toThrow(/disagrees with pinned check requirement/);
      // Critical 1: Forged failed check_result with 64 zeros when pinned target rec1 exists MUST be rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId: tpRun, seq: i3.seq + 1, eventId: "ec_forged_zero_fail", prev: i3.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "ver", attemptId: i3.attemptId,
          data: { checkId: "check_nonempty", targetSha: "0".repeat(64), passed: false },
        }),
      ).toThrow(/does not match pinned against target/);
    });

    // Critical 1: Forged passed: false when pinned target actually exists and passes on disk MUST be rejected
    const forgedFailYaml = `flow: forged-fail\nversion: 1\nsteps:\n  - id: g1\n    type: agent\n    outputs: [a1]\n  - id: ver\n    type: check\n    against: g1.a1\n    run: [check_nonempty]\n`;
    const ffRun = "run-forged-fail";
    planAndApproveRun({ projectId, runId: ffRun, flowYaml: forgedFailYaml, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(ffRun)[1]!;
      store.appendEvent({
        v: 1, runId: ffRun, seq: 3, eventId: "ev3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000000, steps: 100 } },
      });
      const i1 = store.allocateAndAppendStepIntent({ runId: ffRun, stepId: "g1" });
      const rec1 = store.writeAndRecordArtifact({
        artifactId: "art_ff1", runId: ffRun, stepId: "g1", attemptId: i1.attemptId,
        name: "a1", mediaType: "text/plain", bytes: Buffer.from("valid nonempty payload", "utf8"),
      });
      const a1 = store.appendEvent({
        v: 1, runId: ffRun, seq: i1.seq + 1, eventId: "eaf1", prev: i1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "g1", attemptId: i1.attemptId,
        data: { artefactId: "art_ff1", sha256: rec1.contentHash, sizeBytes: rec1.size },
      });
      const r1 = store.appendEvent({
        v: 1, runId: ffRun, seq: a1.seq + 1, eventId: "erf1", prev: a1.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "g1", attemptId: i1.attemptId, data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
      });
      // Major 5: 64-hex secret in judgement.data.reasonCodes MUST be rejected by closed enum schema!
      expect(() =>
        store.appendEvent({
          v: 1, runId: ffRun, seq: r1.seq + 1, eventId: "ej_secret_code", prev: r1.hash,
          at: new Date().toISOString(), actor: "system", type: "judgement",
          stepId: "g1", attemptId: i1.attemptId,
          data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["a".repeat(64) as unknown as "ok"], engineTokens: 0 },
        }, { privateDetail: "a".repeat(64) }),
      ).toThrow(/schema validation/);

      // Isolated ruleHits enum rejection negative (valid reasonCodes: ["ok"])
      expect(() =>
        store.appendEvent({
          v: 1, runId: ffRun, seq: r1.seq + 1, eventId: "ej_secret_rule", prev: r1.hash,
          at: new Date().toISOString(), actor: "system", type: "judgement",
          stepId: "g1", attemptId: i1.attemptId,
          data: { final: "continue", ruleHits: ["b".repeat(64) as unknown as "step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
        }),
      ).toThrow(/schema validation/);

      store.appendEvent({
        v: 1, runId: ffRun, seq: r1.seq + 1, eventId: "ejf1", prev: r1.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "g1", attemptId: i1.attemptId, data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });
      const i2 = store.allocateAndAppendStepIntent({ runId: ffRun, stepId: "ver" });
      expect(() =>
        store.appendEvent({
          v: 1, runId: ffRun, seq: i2.seq + 1, eventId: "ecf_forged", prev: i2.hash,
          at: new Date().toISOString(), actor: "runner", type: "check_result",
          stepId: "ver", attemptId: i2.attemptId,
          data: { checkId: "check_nonempty", targetSha: rec1.contentHash, passed: false },
        }),
      ).toThrow(/Cannot record check_result passed: false when pinned target/);
    });
  });

  it("Critical 2 & Major 3: rejects hard-linked flows.db, read-only writeAndRecordArtifact side effects, hostile purgeRun IDs, and symlink escape", async () => {
    // Critical 2: Hard-linked flows.db (st_nlink > 1) MUST be refused BEFORE SQLite initializes or chmods it
    const decoyDb = path.join(scratchDir, "checkout-alias.db");
    fs.writeFileSync(decoyDb, "", { mode: 0o644 });
    fs.chmodSync(decoyDb, 0o644);
    const hlProj = "adv-hl-db";
    const hlProjDir = path.join(scratchDir, "flows", hlProj);
    fs.mkdirSync(hlProjDir, { recursive: true, mode: 0o700 });
    fs.linkSync(decoyDb, path.join(hlProjDir, "flows.db"));

    const hlLock = acquireOwnerLock(hlProj, scratchDir);
    try {
      expect(() => openFlowsStore(hlProj, { dataRoot: scratchDir, ownerLock: hlLock })).toThrow(/Hard-linked file forbidden/);
      expect(fs.statSync(decoyDb).size).toBe(0);
      expect(fs.statSync(decoyDb).mode & 0o777).toBe(0o644);
    } finally {
      hlLock.release();
    }

    // Major 2: FIFO at flows.owner MUST be rejected immediately without blocking!
    const fifoProj = "adv-fifo-proj";
    const fifoDir = path.join(scratchDir, "flows", fifoProj);
    fs.mkdirSync(fifoDir, { recursive: true, mode: 0o700 });
    const fifoPath = path.join(fifoDir, "flows.owner");
    const mkfifoRes = spawnSync("mkfifo", [fifoPath]);
    if (mkfifoRes.status === 0) {
      expect(() => acquireOwnerLock(fifoProj, scratchDir)).toThrow(/non-regular inode forbidden/);
    }

    const keepRunId = "run-keep-intact";
    planAndApproveRun({ projectId, runId: keepRunId, flowYaml: TWO_STEP_YAML, dataRoot: scratchDir });
    const res = await runFlow(projectId, keepRunId, { dataRoot: scratchDir });
    expect(res.finalStatus).toBe("finished");

    // Major 3: Read-only store refuses writeAndRecordArtifact BEFORE creating any file on disk for keepRunId
    const roStore = openFlowsStore(projectId, { dataRoot: scratchDir, readonly: true });
    try {
      const roBytes = Buffer.from("RO_MUST_NOT_WRITE", "utf8");
      const roSha = crypto.createHash("sha256").update(roBytes).digest("hex");
      expect(() =>
        roStore.writeAndRecordArtifact({
          artifactId: "art_ro",
          runId: keepRunId, stepId: "draft_step", attemptId: "att_ro",
          name: "ro.txt", mediaType: "text/plain", bytes: roBytes,
        }),
      ).toThrow(/read-only/);
      expect(fs.existsSync(path.join(roStore.projectDir, "artifacts", keepRunId, roSha))).toBe(false);
    } finally {
      roStore.close();
    }

    withOwnedStore(projectId, scratchDir, (store) => {
      for (const hostileId of ["..", ".", "", "/tmp", "../other", "a/b"]) {
        expect(() => store.purgeRun(hostileId)).toThrow(/Invalid flow runId/);
      }
      expect(fs.existsSync(store.dbPath)).toBe(true);
      expect(store.getRun(keepRunId)).not.toBeNull();

      // Symlinked artifacts ancestor blocks both writeAndRecordArtifact (before mkdir) AND purgeRun (before SQL delete)
      const escapeTarget = path.join(scratchDir, "fake-checkout-runs");
      fs.mkdirSync(escapeTarget, { recursive: true });
      fs.rmSync(path.join(store.projectDir, "artifacts"), { recursive: true, force: true });
      fs.symlinkSync(escapeTarget, path.join(store.projectDir, "artifacts"));

      expect(() =>
        store.writeAndRecordArtifact({
          artifactId: "art_escape",
          runId: keepRunId, stepId: "draft_step", attemptId: "att_1",
          name: "out.txt", mediaType: "text/plain", bytes: Buffer.from("PRIVATE", "utf8"),
        }),
      ).toThrow(/Symlink.*forbidden/);
      expect(fs.existsSync(path.join(escapeTarget, keepRunId))).toBe(false);

      expect(() => store.purgeRun(keepRunId)).toThrow(/Symlink.*forbidden/);
      expect(store.getRun(keepRunId)).not.toBeNull();
      fs.unlinkSync(path.join(store.projectDir, "artifacts"));

      // Nonexistent runId in writeAndRecordArtifact creates ZERO directories on disk
      expect(() =>
        store.writeAndRecordArtifact({
          artifactId: "art_ghost",
          runId: "run-does-not-exist", stepId: "draft_step", attemptId: "att_1",
          name: "g.txt", mediaType: "text/plain", bytes: Buffer.from("ghost", "utf8"),
        }),
      ).toThrow(/nonexistent run/);
      expect(fs.existsSync(path.join(store.projectDir, "artifacts", "run-does-not-exist"))).toBe(false);
    });
  });

  it("No redispatch on waiting_decision (interrupted K1 or deleted artefact after judgement)", async () => {
    const runId = "run-no-redispatch";
    planAndApproveRun({ projectId, runId, flowYaml: TWO_STEP_YAML, dataRoot: scratchDir });

    let artFilePath = "";
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(runId)[1]!;
      store.appendEvent({
        v: 1, runId, seq: 3, eventId: "ev_s", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 50000, steps: 10 } },
      });
      const intent = store.allocateAndAppendStepIntent({ runId, stepId: "draft_step" });
      const rec = store.writeAndRecordArtifact({
        artifactId: "art_draft_1",
        runId, stepId: "draft_step", attemptId: intent.attemptId,
        name: "draft.txt", mediaType: "text/plain", bytes: Buffer.from("draft artefact bytes", "utf8"),
      });
      artFilePath = rec.filePath;
      const artEv = store.appendEvent({
        v: 1, runId, seq: intent.seq + 1, eventId: "ev_art", prev: intent.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "draft_step", attemptId: intent.attemptId,
        data: { artefactId: "art_draft_1", sha256: rec.contentHash, sizeBytes: rec.size },
      });
      const resEv = store.appendEvent({
        v: 1, runId, seq: artEv.seq + 1, eventId: "ev_res", prev: artEv.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "draft_step", attemptId: intent.attemptId,
        data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 5 },
      });
      store.appendEvent({
        v: 1, runId, seq: resEv.seq + 1, eventId: "ev_jdg", prev: resEv.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "draft_step", attemptId: intent.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });
    });

    fs.unlinkSync(artFilePath);
    const resumed = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(resumed.finalStatus).toBe("waiting_decision");
    expect(resumed.dispatchedSteps).toHaveLength(0);

    // Major 4 (Round 7): Durable step_failed without judgement recovers cleanly to stopped instead of stalling!
    const failRecoverRun = "run-failed-no-judgement";
    planAndApproveRun({ projectId, runId: failRecoverRun, flowYaml: TWO_STEP_YAML, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(failRecoverRun)[1]!;
      store.appendEvent({
        v: 1, runId: failRecoverRun, seq: 3, eventId: "ev_fs", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 50000, steps: 10 } },
      });
      const intent = store.allocateAndAppendStepIntent({ runId: failRecoverRun, stepId: "draft_step" });
      store.appendEvent({
        v: 1, runId: failRecoverRun, seq: intent.seq + 1, eventId: "ev_fail_no_jdg", prev: intent.hash,
        at: new Date().toISOString(), actor: "runner", type: "step_failed",
        stepId: "draft_step", attemptId: intent.attemptId,
        data: { errorCode: "execution_error" },
      });
    });
    const recoveredFail = await runFlow(projectId, failRecoverRun, { dataRoot: scratchDir });
    expect(recoveredFail.finalStatus).toBe("stopped");
    expect(recoveredFail.dispatchedSteps).toHaveLength(0);
    const loadedFail = loadRunState(projectId, failRecoverRun, { dataRoot: scratchDir });
    expect(loadedFail.events.some((e) => e.type === "judgement" && e.data.final === "stop")).toBe(true);
    expect(loadedFail.events.some((e) => e.type === "run_finished" && e.data.outcome === "stopped")).toBe(true);

    // Critical 1 (Round 7 runner end-to-end): Output-name shadowing artefact (artifactId="output_file", name="other")
    // MUST NOT fool built-in runner check_nonempty when real output_file is 0 bytes!
    const shadowRun = "run-shadow-runner";
    const shadowYaml = `flow: shadow-runner\nversion: 1\nsteps:\n  - id: generate\n    type: agent\n    outputs: [output_file]\n  - id: verify\n    type: check\n    against: generate.output_file\n    run: [check_nonempty]\n`;
    planAndApproveRun({ projectId, runId: shadowRun, flowYaml: shadowYaml, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(shadowRun)[1]!;
      store.appendEvent({
        v: 1, runId: shadowRun, seq: 3, eventId: "ev_sh3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000000, steps: 100 } },
      });
      const i1 = store.allocateAndAppendStepIntent({ runId: shadowRun, stepId: "generate" });
      const recEmpty = store.writeAndRecordArtifact({
        artifactId: "art_real_empty", runId: shadowRun, stepId: "generate", attemptId: i1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.alloc(0),
      });
      const a1 = store.appendEvent({
        v: 1, runId: shadowRun, seq: i1.seq + 1, eventId: "ea_sh1", prev: i1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: i1.attemptId,
        data: { artefactId: "art_real_empty", sha256: recEmpty.contentHash, sizeBytes: 0 },
      });
      const recDecoy = store.writeAndRecordArtifact({
        artifactId: "output_file", runId: shadowRun, stepId: "generate", attemptId: i1.attemptId,
        name: "other", mediaType: "text/plain", bytes: Buffer.from("decoy nonempty", "utf8"),
      });
      const a2 = store.appendEvent({
        v: 1, runId: shadowRun, seq: a1.seq + 1, eventId: "ea_sh2", prev: a1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: i1.attemptId,
        data: { artefactId: "output_file", sha256: recDecoy.contentHash, sizeBytes: recDecoy.size },
      });
      const r1 = store.appendEvent({
        v: 1, runId: shadowRun, seq: a2.seq + 1, eventId: "er_sh1", prev: a2.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "generate", attemptId: i1.attemptId, data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId: shadowRun, seq: r1.seq + 1, eventId: "ej_sh1", prev: r1.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: i1.attemptId, data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });
    });
    const shadowRes = await runFlow(projectId, shadowRun, { dataRoot: scratchDir });
    expect(shadowRes.finalStatus).toBe("stopped");
  });

  it("Integrity: rejects seq=0, duplicate JSON keys with rehashed chain, tampered pinned_flows at append, and orphan event rows", () => {
    const runId = "run-integrity";
    planAndApproveRun({ projectId, runId, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });

    let dbPath = "";
    withOwnedStore(projectId, scratchDir, (store) => {
      dbPath = store.dbPath;
      const rawDb = new Database(dbPath);
      try {
        // CHECK (seq >= 1) rejects seq=0
        expect(() =>
          rawDb
            .prepare(
              `INSERT INTO flow_events (run_id, seq, step_id, attempt_id, phase, event_type, line, hash, prev_hash, created_at)
               VALUES (?, 0, 'flow', '0', 'run_planned', 'run_planned', '{"s":1}', ?, ?, ?)`,
            )
            .run(runId, "a".repeat(64), GENESIS_PREV, Date.now()),
        ).toThrow(/CHECK constraint failed/);

        // Duplicate JSON key smuggling with recomputed hashes rejected by canonical-byte check
        const row1 = store.getEvents(runId)[0]!;
        const env1 = JSON.parse(row1.line) as FlowEvent;
        const canonical = canonicalJsonStringify(env1);
        const dupLine = canonical.replace(`"at":"${env1.at}"`, `"at":"SMUGGLED","at":"${env1.at}"`);
        const dupHash = crypto.createHash("sha256").update(dupLine, "utf8").digest("hex");
        const row2 = store.getEvents(runId)[1]!;
        const env2 = { ...(JSON.parse(row2.line) as FlowEvent), prev: dupHash };
        const line2 = canonicalJsonStringify(env2);
        const hash2 = crypto.createHash("sha256").update(line2, "utf8").digest("hex");

        rawDb.prepare(`UPDATE flow_events SET line = ?, hash = ? WHERE run_id = ? AND seq = 1`).run(dupLine, dupHash, runId);
        rawDb.prepare(`UPDATE flow_events SET line = ?, hash = ?, prev_hash = ? WHERE run_id = ? AND seq = 2`).run(line2, hash2, dupHash, runId);
      } finally {
        rawDb.close();
      }
      expect(() => store.exportProjectionLines(runId)).toThrow(HashChainCorruptionError);
    });
    expect(() => openFlowsStore(projectId, { dataRoot: scratchDir, readonly: true })).toThrow(HashChainCorruptionError);

    // Major 2: Tampered pinned_flows.bytes with valid replacement YAML MUST be rejected at append time too
    const pinProj = "adv-r6-pin-append";
    planAndApproveRun({ projectId: pinProj, runId: "run-pin-app", flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });
    const pinRaw = new Database(path.join(scratchDir, "flows", pinProj, "flows.db"));
    try {
      pinRaw
        .prepare(`UPDATE pinned_flows SET bytes = ? WHERE hash = ?`)
        .run(Buffer.from("flow: injected\nversion: 1\nsteps:\n  - id: evil_step\n    type: agent\n", "utf8"), ONE_STEP_HASH);
    } finally {
      pinRaw.close();
    }
    withOwnedStore(pinProj, scratchDir, (store) => {
      const ev2 = store.getEvents("run-pin-app")[1]!;
      expect(() =>
        store.appendEvent({
          v: 1, runId: "run-pin-app", seq: 3, eventId: "ev3", prev: ev2.hash,
          at: new Date().toISOString(), actor: "runner", type: "run_started",
          data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
        }),
      ).toThrow(HashChainCorruptionError);
    });

    // Orphan event row (parent flow_runs deleted with foreign_keys=OFF) rejected on open
    const orphanProj = "adv-r5-orphan";
    planAndApproveRun({ projectId: orphanProj, runId: "run-orp", flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });
    const rawDb = new Database(path.join(scratchDir, "flows", orphanProj, "flows.db"));
    try {
      rawDb.pragma("foreign_keys = OFF");
      rawDb.prepare(`DELETE FROM flow_runs WHERE run_id = 'run-orp'`).run();
    } finally {
      rawDb.close();
    }
    expect(() => openFlowsStore(orphanProj, { dataRoot: scratchDir, readonly: true })).toThrow(HashChainCorruptionError);
  });

  it("Transition Table: enforces EVERY row rule (planned/approved hash, non-sticky pass, unjudged stopped, unknown unstarted, stop->done)", () => {
    const runId = "run-transition-table";
    withOwnedStore(projectId, scratchDir, (store) => {
      const TWO_HASH = crypto.createHash("sha256").update(TWO_STEP_YAML).digest("hex");
      store.createRun({ runId, flowHash: TWO_HASH, flowYamlBytes: TWO_STEP_YAML });

      // run_planned wrong hash rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 1, eventId: "ev_bad_plan", prev: GENESIS_PREV,
          at: new Date().toISOString(), actor: "runner", type: "run_planned",
          data: { flowRef: "adv-two-step", flowHash: "b".repeat(64), source: "builtin", expectedDecisions: [] },
        }),
      ).toThrow(IllegalFlowTransitionError);

      const p1 = store.appendEvent({
        v: 1, runId, seq: 1, eventId: "ev_p1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        data: { flowRef: "adv-two-step", flowHash: TWO_HASH, source: "builtin", expectedDecisions: [] },
      });

      // flow_approved wrong hash rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 2, eventId: "ev_bad_app", prev: p1.hash,
          at: new Date().toISOString(), actor: "human", type: "flow_approved",
          data: { flowHash: "c".repeat(64), actorId: "operator-1" },
        }),
      ).toThrow(IllegalFlowTransitionError);

      const a2 = store.appendEvent({
        v: 1, runId, seq: 2, eventId: "ev_a2", prev: p1.hash,
        at: new Date().toISOString(), actor: "human", type: "flow_approved",
        data: { flowHash: TWO_HASH, actorId: "operator-1" },
      });

      // Duplicate flow_approved rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 3, eventId: "ev_dup_app", prev: a2.hash,
          at: new Date().toISOString(), actor: "human", type: "flow_approved",
          data: { flowHash: TWO_HASH, actorId: "operator-1" },
        }),
      ).toThrow(IllegalFlowTransitionError);

      const r3 = store.appendEvent({
        v: 1, runId, seq: 3, eventId: "ev3", prev: a2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 50000, steps: 10 } },
      });

      // step_outcome_unknown for unstarted attempt rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 4, eventId: "ev_unk_bad", prev: r3.hash,
          at: new Date().toISOString(), actor: "runner", type: "step_outcome_unknown",
          stepId: "draft_step", attemptId: "att_ghost",
          data: { reasonCode: "crash_during_execution" },
        }),
      ).toThrow(IllegalFlowTransitionError);

      // Undeclared & skipped step rejected
      expect(() =>
        store.allocateAndAppendStepIntent({ runId, stepId: "ghost_step" }),
      ).toThrow(IllegalFlowTransitionError);
      expect(() =>
        store.allocateAndAppendStepIntent({ runId, stepId: "verify_step" }),
      ).toThrow(IllegalFlowTransitionError);

      // Start step 1
      const i1 = store.allocateAndAppendStepIntent({ runId, stepId: "draft_step" });

      // Overlapping step_started and run_finished(stopped) while unsettled rejected
      expect(() =>
        store.allocateAndAppendStepIntent({ runId, stepId: "draft_step" }),
      ).toThrow(IllegalFlowTransitionError);
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: i1.seq + 1, eventId: "ev_fin_unsettled", prev: i1.hash,
          at: new Date().toISOString(), actor: "system", type: "run_finished",
          data: { outcome: "stopped", reasonCode: "manual_stop" },
        }),
      ).toThrow(IllegalFlowTransitionError);

      // Record artefact + pass step 1
      const rec = store.writeAndRecordArtifact({
        artifactId: "art_d1",
        runId, stepId: "draft_step", attemptId: i1.attemptId,
        name: "d1.txt", mediaType: "text/plain", bytes: Buffer.from("draft payload", "utf8"),
      });
      const art1 = store.appendEvent({
        v: 1, runId, seq: i1.seq + 1, eventId: "ev_art1", prev: i1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "draft_step", attemptId: i1.attemptId,
        data: { artefactId: "art_d1", sha256: rec.contentHash, sizeBytes: rec.size },
      });
      const r1 = store.appendEvent({
        v: 1, runId, seq: art1.seq + 1, eventId: "ev_r1", prev: art1.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "draft_step", attemptId: i1.attemptId,
        data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 5 },
      });

      // Major 2: run_finished(stopped) right after outcome WITHOUT judgement MUST be rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: r1.seq + 1, eventId: "ev_fin_unjudged", prev: r1.hash,
          at: new Date().toISOString(), actor: "system", type: "run_finished",
          data: { outcome: "stopped", reasonCode: "manual_stop" },
        }),
      ).toThrow(/unsettled or awaiting judgement/);

      const j1 = store.appendEvent({
        v: 1, runId, seq: r1.seq + 1, eventId: "ev_j1", prev: r1.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "draft_step", attemptId: i1.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      // Premature run_finished(done) without step 2 rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: j1.seq + 1, eventId: "ev_prem_done", prev: j1.hash,
          at: new Date().toISOString(), actor: "system", type: "run_finished",
          data: { outcome: "done", reasonCode: "completed" },
        }),
      ).toThrow(IllegalFlowTransitionError);

      // Start step 2 (check) -> check_result required -> pass occurrence 1 -> THEN occurrence 2 fails + notify!
      const i2 = store.allocateAndAppendStepIntent({ runId, stepId: "verify_step" });
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: i2.seq + 1, eventId: "ev_skip_chk", prev: i2.hash,
          at: new Date().toISOString(), actor: "runner", type: "step_result",
          stepId: "verify_step", attemptId: i2.attemptId,
          data: { outputs: { check: "passed" }, tokensUsed: 0, wallTimeMs: 1 },
        }),
      ).toThrow(/without a prior passing check_result/);

      const c2 = store.appendEvent({
        v: 1, runId, seq: i2.seq + 1, eventId: "ev_c2", prev: i2.hash,
        at: new Date().toISOString(), actor: "runner", type: "check_result",
        stepId: "verify_step", attemptId: i2.attemptId,
        data: { checkId: "check_nonempty", targetSha: rec.contentHash, passed: true },
      });
      const sr2 = store.appendEvent({
        v: 1, runId, seq: c2.seq + 1, eventId: "ev_sr2", prev: c2.hash,
        at: new Date().toISOString(), actor: "runner", type: "step_result",
        stepId: "verify_step", attemptId: i2.attemptId,
        data: { outputs: { check: "passed" }, tokensUsed: 0, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId, seq: sr2.seq + 1, eventId: "ev_j2", prev: sr2.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "verify_step", attemptId: i2.attemptId,
        data: { final: "continue", ruleHits: ["check_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      // Major 2: Occurrence 2 of verify_step fails with judgement(notify) -> previous pass MUST NOT allow run_finished(done)!
      const i2Occ2 = store.allocateAndAppendStepIntent({ runId, stepId: "verify_step" });
      const f2 = store.appendEvent({
        v: 1, runId, seq: i2Occ2.seq + 1, eventId: "ev_f2", prev: i2Occ2.hash,
        at: new Date().toISOString(), actor: "runner", type: "step_failed",
        stepId: "verify_step", attemptId: i2Occ2.attemptId,
        data: { errorCode: "check_failed" },
      });
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: f2.seq + 1, eventId: "ev_cont_after_fail", prev: f2.hash,
          at: new Date().toISOString(), actor: "system", type: "judgement",
          stepId: "verify_step", attemptId: i2Occ2.attemptId,
          data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
        }),
      ).toThrow(/forbidden for failed or unknown attempt/);

      const jNotify = store.appendEvent({
        v: 1, runId, seq: f2.seq + 1, eventId: "ev_jnotify", prev: f2.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "verify_step", attemptId: i2Occ2.attemptId,
        data: { final: "notify", ruleHits: ["check_failed"], reasonCodes: ["check_failed"], engineTokens: 0 },
      });
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: jNotify.seq + 1, eventId: "ev_masked_done", prev: jNotify.hash,
          at: new Date().toISOString(), actor: "system", type: "run_finished",
          data: { outcome: "done", reasonCode: "completed" },
        }),
      ).toThrow(IllegalFlowTransitionError);
    });

    // Major 5: Direct append enforces step budget ceiling (1-step pinned budget forbids 2nd step_started, matching replay)
    const oneStepLimitTwoStepYaml = `flow: adv-two-step-1step\nversion: 1\nlimits:\n  budget:\n    tokens: 1000\n    steps: 1\nsteps:\n  - id: draft_step\n    type: agent\n  - id: verify_step\n    type: check\n`;
    const budgetRun = "run-append-budget";
    planAndApproveRun({ projectId, runId: budgetRun, flowYaml: oneStepLimitTwoStepYaml, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(budgetRun)[1]!;
      store.appendEvent({
        v: 1, runId: budgetRun, seq: 3, eventId: "ev3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000, steps: 1 } },
      });
      const i1 = store.allocateAndAppendStepIntent({ runId: budgetRun, stepId: "draft_step" });
      const r1 = store.appendEvent({
        v: 1, runId: budgetRun, seq: i1.seq + 1, eventId: "er1", prev: i1.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "draft_step", attemptId: i1.attemptId, data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId: budgetRun, seq: r1.seq + 1, eventId: "ej1", prev: r1.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "draft_step", attemptId: i1.attemptId, data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });
      expect(() =>
        store.allocateAndAppendStepIntent({ runId: budgetRun, stepId: "verify_step" }),
      ).toThrow(/step budget ceiling reached/);
    });

    // Major 3 (Round 7 & Round 8): Direct append rejects step_result charging 100 tokens when only 1 token is pinned
    const oneTokLimitYaml = `flow: adv-one-tok-limit\nversion: 1\nlimits:\n  budget:\n    tokens: 1\n    steps: 5\nsteps:\n  - id: only_step\n    type: agent\n`;
    const tokBudgetRun = "run-append-tok-budget";
    planAndApproveRun({ projectId, runId: tokBudgetRun, flowYaml: oneTokLimitYaml, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(tokBudgetRun)[1]!;
      store.appendEvent({
        v: 1, runId: tokBudgetRun, seq: 3, eventId: "ev3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1, steps: 5 } },
      });
      const i1 = store.allocateAndAppendStepIntent({ runId: tokBudgetRun, stepId: "only_step" });
      expect(() =>
        store.appendEvent({
          v: 1, runId: tokBudgetRun, seq: i1.seq + 1, eventId: "er_overspend", prev: i1.hash,
          at: new Date().toISOString(), actor: "agent", type: "step_result",
          stepId: "only_step", attemptId: i1.attemptId,
          data: { outputs: { status: "ok" }, tokensUsed: 100, wallTimeMs: 1 },
        }),
      ).toThrow(/exceeds remaining token budget/);
    });

    // Minor 2: Corrupting ONLY SQL `phase` column (leaving event_type & line intact) rejected on open
    const phaseProj = "adv-phase-corrupt";
    planAndApproveRun({ projectId: phaseProj, runId: "run-phase", flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });
    const phaseDb = new Database(path.join(scratchDir, "flows", phaseProj, "flows.db"));
    try {
      phaseDb.prepare(`UPDATE flow_events SET phase = 'tampered_phase' WHERE run_id = 'run-phase' AND seq = 1`).run();
    } finally {
      phaseDb.close();
    }
    expect(() => openFlowsStore(phaseProj, { dataRoot: scratchDir, readonly: true })).toThrow(HashChainCorruptionError);

    // Pure reducer also refuses stop->done reversal and protects against __proto__ artefactId pollution
    const flowDef: FlowDefinition = { flow: "f", version: 1, steps: [{ id: "s1", type: "agent" }] };
    const sha = "e".repeat(64);
    const protoEvents: FlowEvent[] = [
      {
        v: 1, runId: "r", seq: 1, eventId: "e1", prev: GENESIS_PREV, at: "2026-11-22T22:00:00.000Z",
        actor: "runner", type: "run_planned",
        data: { flowRef: "f", flowHash: "0".repeat(64), source: "builtin", expectedDecisions: [] },
      },
      {
        v: 1, runId: "r", seq: 2, eventId: "e2", prev: "0".repeat(64), at: "2026-11-22T22:00:01.000Z",
        actor: "runner", type: "artefact_recorded", stepId: "s1", attemptId: "a1",
        data: { artefactId: "__proto__", sha256: sha, sizeBytes: 0 },
      },
      {
        v: 1, runId: "r", seq: 3, eventId: "e3", prev: "0".repeat(64), at: "2026-11-22T22:00:02.000Z",
        actor: "system", type: "judgement", stepId: "s1", attemptId: "a1",
        data: { final: "stop", ruleHits: ["stop_rule"], reasonCodes: ["halted"], engineTokens: 0 },
      },
      {
        v: 1, runId: "r", seq: 4, eventId: "e4", prev: "0".repeat(64), at: "2026-11-22T22:00:03.000Z",
        actor: "system", type: "run_finished",
        data: { outcome: "done", reasonCode: "completed" },
      },
    ];
    const reduced = reduceFlowRun(flowDef, protoEvents, new Map([[`__proto__:${sha}`, 0]]));
    expect(reduced.status).toBe("stopped");
    expect(Object.entries(reduced.recordedArtefacts).some(([k]) => k === "__proto__")).toBe(true);
  });

  it("Major 4: collision-free IDs (a_b+c vs a+b_c), 64-char stepId check target, _+proto__, and check_exists vs check_nonempty on 0-byte artefact", async () => {
    // 1. Delimiter collision test: (a_b, c) and (a, b_c) produce distinct IDs and complete cleanly
    expect(buildCollisionFreeArtifactId("a_b", "c")).not.toBe(buildCollisionFreeArtifactId("a", "b_c"));
    const delimYaml = `flow: delim-flow\nversion: 1\nsteps:\n  - id: a_b\n    type: agent\n    outputs: [c]\n  - id: a\n    type: agent\n    outputs: [b_c]\n  - id: ver\n    type: check\n    against: a.b_c\n    run: [check_nonempty]\n`;
    planAndApproveRun({ projectId, runId: "run-delim", flowYaml: delimYaml, dataRoot: scratchDir });
    expect((await runFlow(projectId, "run-delim", { dataRoot: scratchDir })).finalStatus).toBe("finished");

    // 2. 64-char stepId with output_file resolves cleanly in `against: <stepId>.output_file`
    const longId = "s".repeat(64);
    const longCheckYaml = `flow: long-check\nversion: 1\nsteps:\n  - id: ${longId}\n    type: agent\n    outputs: [output_file]\n  - id: ver\n    type: check\n    against: ${longId}.output_file\n    run: [check_exists]\n`;
    planAndApproveRun({ projectId, runId: "run-long-chk", flowYaml: longCheckYaml, dataRoot: scratchDir });
    expect((await runFlow(projectId, "run-long-chk", { dataRoot: scratchDir })).finalStatus).toBe("finished");

    // 3. Step `_` with output `proto__` succeeds end-to-end without prototype pollution
    const protoStepYaml = `flow: proto-step\nversion: 1\nsteps:\n  - id: _\n    type: agent\n    outputs: [proto__]\n  - id: ver\n    type: check\n    against: _.proto__\n    run: [check_exists]\n`;
    planAndApproveRun({ projectId, runId: "run-proto-step", flowYaml: protoStepYaml, dataRoot: scratchDir });
    expect((await runFlow(projectId, "run-proto-step", { dataRoot: scratchDir })).finalStatus).toBe("finished");

    // 4. check_exists PASSES on verified 0-byte artefact while check_nonempty FAILS on verified 0-byte artefact
    const zeroExistsYaml = `flow: zero-exists\nversion: 1\nsteps:\n  - id: gen\n    type: agent\n    outputs: [empty_file]\n  - id: ver\n    type: check\n    against: gen.empty_file\n    run: [check_exists]\n`;
    const zeroNonEmptyYaml = `flow: zero-nonempty\nversion: 1\nsteps:\n  - id: gen\n    type: agent\n    outputs: [empty_file]\n  - id: ver\n    type: check\n    against: gen.empty_file\n    run: [check_nonempty]\n`;

    for (const [runId, yaml, expectedStatus] of [
      ["run-zero-exists", zeroExistsYaml, "finished"],
      ["run-zero-nonempty", zeroNonEmptyYaml, "stopped"],
    ] as const) {
      planAndApproveRun({ projectId, runId, flowYaml: yaml, dataRoot: scratchDir });
      withOwnedStore(projectId, scratchDir, (store) => {
        const ev2 = store.getEvents(runId)[1]!;
        store.appendEvent({
          v: 1, runId, seq: 3, eventId: "ev3", prev: ev2.hash,
          at: new Date().toISOString(), actor: "runner", type: "run_started",
          data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000000, steps: 100 } },
        });
        const intent = store.allocateAndAppendStepIntent({ runId, stepId: "gen" });
        const artId = buildCollisionFreeArtifactId("gen", "empty_file");
        const rec = store.writeAndRecordArtifact({
          artifactId: artId,
          runId, stepId: "gen", attemptId: intent.attemptId,
          name: "empty_file", mediaType: "text/plain", bytes: Buffer.alloc(0),
        });
        const artEv = store.appendEvent({
          v: 1, runId, seq: intent.seq + 1, eventId: "ev_art_z", prev: intent.hash,
          at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
          stepId: "gen", attemptId: intent.attemptId,
          data: { artefactId: artId, sha256: rec.contentHash, sizeBytes: 0 },
        });
        const resEv = store.appendEvent({
          v: 1, runId, seq: artEv.seq + 1, eventId: "ev_res_z", prev: artEv.hash,
          at: new Date().toISOString(), actor: "agent", type: "step_result",
          stepId: "gen", attemptId: intent.attemptId,
          data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
        });
        store.appendEvent({
          v: 1, runId, seq: resEv.seq + 1, eventId: "ev_j_z", prev: resEv.hash,
          at: new Date().toISOString(), actor: "system", type: "judgement",
          stepId: "gen", attemptId: intent.attemptId,
          data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
        });
      });
      const runRes = await runFlow(projectId, runId, { dataRoot: scratchDir });
      expect(runRes.finalStatus).toBe(expectedStatus);
    }

    // 5. Check-only flow with no artefact fails, unsupported run fails, literal SHA passes
    planAndApproveRun({ projectId, runId: "run-chk-only", flowYaml: CHECK_ONLY_YAML, dataRoot: scratchDir });
    expect((await runFlow(projectId, "run-chk-only", { dataRoot: scratchDir })).finalStatus).toBe("stopped");

    const unknownChkYaml = `flow: unknown-chk\nversion: 1\nsteps:\n  - id: gen\n    type: agent\n    outputs: [output_file]\n  - id: ver\n    type: check\n    against: gen.output_file\n    run: [unknown_check]\n`;
    planAndApproveRun({ projectId, runId: "run-unk-chk", flowYaml: unknownChkYaml, dataRoot: scratchDir });
    expect((await runFlow(projectId, "run-unk-chk", { dataRoot: scratchDir })).finalStatus).toBe("stopped");

    const expectedStubSha = crypto.createHash("sha256").update("stub output for gen\n", "utf8").digest("hex");
    const literalShaYaml = `flow: lit-sha\nversion: 1\nsteps:\n  - id: gen\n    type: agent\n    outputs: [output_file]\n  - id: ver\n    type: check\n    against: ${expectedStubSha}\n    run: [check_exists]\n`;
    planAndApproveRun({ projectId, runId: "run-lit-sha", flowYaml: literalShaYaml, dataRoot: scratchDir });
    expect((await runFlow(projectId, "run-lit-sha", { dataRoot: scratchDir })).finalStatus).toBe("finished");
  });

  it("Budget reservation, exact 1-step finish, atomic plan retry, and live runFlow contention blocking second runner + second writer", async () => {
    // Atomic planAndApproveRun: invalid actorId leaves zero partial run and retry succeeds
    const atomicRun = "run-atomic-plan";
    expect(() =>
      planAndApproveRun({ projectId, runId: atomicRun, flowYaml: ONE_STEP_YAML, actorId: "bad actor", dataRoot: scratchDir }),
    ).toThrow(/Invalid actorId/);
    planAndApproveRun({ projectId, runId: atomicRun, flowYaml: ONE_STEP_YAML, actorId: "operator-1", dataRoot: scratchDir });

    // Exact 1-step & 100-token budget completes consistently
    const exactRes = await runFlow(projectId, atomicRun, { dataRoot: scratchDir });
    expect(exactRes.finalStatus).toBe("finished");
    expect(exactRes.terminalOutcome).toBe("done");

    // 1-token budget refuses 100-token built-in stub before dispatch
    const oneTokYaml = `flow: one-tok\nversion: 1\nlimits:\n  budget:\n    tokens: 1\n    steps: 5\nsteps:\n  - id: s1\n    type: agent\n`;
    planAndApproveRun({ projectId, runId: "run-one-tok", flowYaml: oneTokYaml, dataRoot: scratchDir });
    const oneTokRes = await runFlow(projectId, "run-one-tok", { dataRoot: scratchDir });
    expect(oneTokRes.finalStatus).toBe("stopped");
    expect(oneTokRes.terminalReason).toBe("ceiling_reached");
    expect(oneTokRes.dispatchedSteps).toHaveLength(0);

    // Live runFlow contention blocks a second runFlow AND blocks acquiring a second OwnerLock for any write/purge!
    const holderRun = "run-holder";
    const contenderRun = "run-contender";
    planAndApproveRun({ projectId, runId: holderRun, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });
    planAndApproveRun({ projectId, runId: contenderRun, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });

    let releaseHolder!: () => void;
    let entered!: () => void;
    const ready = new Promise<void>((r) => { entered = r; });
    const gate = new Promise<void>((r) => { releaseHolder = r; });

    const p1 = runFlow(projectId, holderRun, {
      dataRoot: scratchDir,
      onStepDispatch: async () => {
        entered();
        await gate;
      },
    });
    await ready;
    await expect(runFlow(projectId, contenderRun, { dataRoot: scratchDir })).rejects.toThrow(RunnerLockBusyError);
    expect(() => acquireOwnerLock(projectId, scratchDir)).toThrow(RunnerLockBusyError);
    expect(() => openFlowsStore(projectId, { dataRoot: scratchDir })).toThrow(OwnerLockRequiredError);
    releaseHolder();
    expect((await p1).finalStatus).toBe("finished");
  });

  it("Path confinement & mount safety: rejects symlink dataRoot, non-Git symlink ancestor, git worktree alias, and non-Linux/unsafe mounts", () => {
    const symGit = path.join(scratchDir, "sym-git");
    fs.symlinkSync(__dirname, symGit);
    expect(() => resolveFlowsRootDir(symGit)).toThrow(/Symlink dataRoot forbidden/);
    expect(() => resolveFlowsRootDir(path.join(symGit, "nested"))).toThrow(UnsafeFilesystemError);

    const realOut = path.join(scratchDir, "real-out");
    fs.mkdirSync(realOut, { recursive: true });
    const symOut = path.join(scratchDir, "sym-out");
    fs.symlinkSync(realOut, symOut);
    expect(() => resolveFlowsRootDir(path.join(symOut, "nested"))).toThrow(/Symlink ancestor forbidden/);

    const base = path.join(scratchDir, "base");
    fs.mkdirSync(base, { recursive: true });
    fs.symlinkSync(realOut, path.join(base, "flows"));
    expect(() => resolveProjectDataDir("proj-1", base)).toThrow(/Symlink component forbidden/);

    expect(() => isOwnerLocked("proj-1", "/mnt/c/repos/project")).toThrow(UnsafeFilesystemError);
    expect(() => checkFilesystemSafety("/Users/example/custom-mount", { allowGitWorktree: true, platformOverride: "darwin" })).toThrow(UnsafeFilesystemError);
    expect(() => checkFilesystemSafety("Z:\\mapped-share\\data", { allowGitWorktree: true, platformOverride: "win32" })).toThrow(UnsafeFilesystemError);
  });

  it("Round 9 Critical 1 & Major 4: pre-tx parse-once-freeze blocks ordinary batchAppendEvents getter savepoint, privateErrorRef getter evasion, and effectKey smuggling", () => {
    const runA = "run-r9-a";
    const runB = "run-r9-b";
    planAndApproveRun({ projectId, runId: runA, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });
    planAndApproveRun({ projectId, runId: runB, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });

    withOwnedStore(projectId, scratchDir, (store) => {
      const aEv2 = store.getEvents(runA)[1]!;
      store.appendEvent({
        v: 1, runId: runA, seq: 3, eventId: "ea_start", prev: aEv2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });
      const bEv2 = store.getEvents(runB)[1]!;
      store.appendEvent({
        v: 1, runId: runB, seq: 3, eventId: "eb_start", prev: bEv2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });

      const aIntent = store.allocateAndAppendStepIntent({ runId: runA, stepId: "only_step" });

      // Critical 1 (Part A): A getter on nested data inside batchAppendEvents for run A calling
      // allocateAndAppendStepIntent for run B executes BEFORE BEGIN IMMEDIATE (solo durable commit),
      // NEVER inside run A's transaction as a savepoint that vanishes when run A rolls back!
      let bAllocatedSeq = 0;
      const evilOutcomeData: Record<string, unknown> = {
        tokensUsed: 10,
        wallTimeMs: 5,
      };
      Object.defineProperty(evilOutcomeData, "outputs", {
        enumerable: true,
        get() {
          if (bAllocatedSeq === 0) {
            const bIntent = store.allocateAndAppendStepIntent({ runId: runB, stepId: "only_step" });
            bAllocatedSeq = bIntent.seq;
          }
          return { status: "ok" };
        },
      });
      expect(() =>
        store.batchAppendEvents([
          {
            // Force outer batch rollback on invalid prev hash AFTER pre-tx getter runs
            event: {
              v: 1, runId: runA, seq: aIntent.seq + 1, eventId: "ea_res", prev: "f".repeat(64),
              at: new Date().toISOString(), actor: "agent", type: "step_result",
              stepId: "only_step", attemptId: aIntent.attemptId,
              data: evilOutcomeData as { outputs: { status: "ok" }; tokensUsed: number; wallTimeMs: number },
            },
          },
        ]),
      ).toThrow(/Invalid event prev hash/);

      // Run A rolled back cleanly (zero step_result), while run B's solo intent SURVIVED durably!
      expect(store.getParsedEvents(runA).some((e) => e.type === "step_result")).toBe(false);
      expect(bAllocatedSeq).toBe(4);
      expect(store.getParsedEvents(runB).some((e) => e.type === "step_started")).toBe(true);

      // Critical 1 (Part B): Inside appendChainedBatch, reentrant allocateAndAppendStepIntent on a DIFFERENT run B is rejected by #inTx!
      const runC = "run-r9-c";
      store.createAndApproveRun({
        runId: runC, flowRef: "adv-one-step", flowHash: ONE_STEP_HASH,
        flowYamlBytes: ONE_STEP_YAML, source: "builtin", expectedDecisions: [], actorId: "op-1",
      });
      const cEv2 = store.getEvents(runC)[1]!;
      store.appendEvent({
        v: 1, runId: runC, seq: 3, eventId: "ec_start", prev: cEv2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });
      expect(() =>
        store.appendChainedBatch(runA, [
          (seq, prev) => {
            store.allocateAndAppendStepIntent({ runId: runC, stepId: "only_step" });
            return {
              event: {
                v: 1, runId: runA, seq, eventId: "ea_fail", prev,
                at: new Date().toISOString(), actor: "runner", type: "step_failed",
                stepId: "only_step", attemptId: aIntent.attemptId,
                data: { errorCode: "execution_error" },
              },
            };
          },
        ]),
      ).toThrow(/Reentrant store mutation while a SQLite transaction is open/);
      expect(store.getParsedEvents(runC).some((e) => e.type === "step_started")).toBe(false);

      // Major 4 (Part A): Stateful getter on step_failed.data.privateErrorRef (returns undefined on 1st read, priv_... on 2nd)
      // CANNOT evade provenance check because materializePlain reads it ONCE!
      let reads = 0;
      const sneakyFailData: Record<string, unknown> = { errorCode: "execution_error" };
      Object.defineProperty(sneakyFailData, "privateErrorRef", {
        enumerable: true,
        get() {
          reads += 1;
          return reads === 1 ? undefined : `priv_${"a".repeat(32)}`;
        },
      });
      store.appendEvent({
        v: 1, runId: runA, seq: aIntent.seq + 1, eventId: "ea_sneaky_fail", prev: aIntent.hash,
        at: new Date().toISOString(), actor: "runner", type: "step_failed",
        stepId: "only_step", attemptId: aIntent.attemptId,
        data: sneakyFailData as { errorCode: "execution_error"; privateErrorRef?: string },
      });
      expect(reads).toBe(1);
      const storedFail = store.getParsedEvents(runA).find((e) => e.type === "step_failed");
      expect(storedFail?.type === "step_failed" && storedFail.data.privateErrorRef).toBeUndefined();

      // And a direct caller-supplied step_failed.data.privateErrorRef (non-reserved event!) MUST throw IllegalFlowTransitionError!
      const bIntent = store.getParsedEvents(runB).find((e) => e.type === "step_started")!;
      const bHead = store.getEvents(runB)[store.getEvents(runB).length - 1]!;
      expect(() =>
        store.appendEvent({
          v: 1, runId: runB, seq: bHead.seq + 1, eventId: "eb_direct_privref", prev: bHead.hash,
          at: new Date().toISOString(), actor: "runner", type: "step_failed",
          stepId: "only_step", attemptId: bIntent.attemptId!,
          data: { errorCode: "execution_error", privateErrorRef: `priv_${"b".repeat(32)}` },
        }),
      ).toThrow(/Caller-supplied data\.privateErrorRef is forbidden/);

      // Major 4 (Part B): Synthetic secret in step_started.data.effectKey MUST be rejected (schema & deterministic match)!
      const cHead = store.getEvents(runC)[store.getEvents(runC).length - 1]!;
      const onlyStepAtt = buildBoundedAttemptId("only_step", 1);
      expect(() =>
        store.appendEvent(
          {
            v: 1, runId: runC, seq: cHead.seq + 1, eventId: "ec_secret_eff", prev: cHead.hash,
            at: new Date().toISOString(), actor: "runner", type: "step_started",
            stepId: "only_step", attemptId: onlyStepAtt,
            data: { occurrence: 1, effectKey: "secret_token_leaked_via_effect_key" },
          },
          { privateDetail: "secret_token_leaked_via_effect_key" },
        ),
      ).toThrow(/schema validation/);
      expect(() =>
        store.appendEvent(
          {
            v: 1, runId: runC, seq: cHead.seq + 1, eventId: "ec_wrong_hex_eff", prev: cHead.hash,
            at: new Date().toISOString(), actor: "runner", type: "step_started",
            stepId: "only_step", attemptId: onlyStepAtt,
            data: { occurrence: 1, effectKey: `eff_${"a".repeat(24)}` },
          },
          { privateDetail: `eff_${"a".repeat(24)}` },
        ),
      ).toThrow(/must match deterministic key/);
    });
  });

  it("Round 9 Critical 2: named check cannot certify failed occurrence output AND numeric artefact ID '1' preserves event order in runner & store", async () => {
    const checkFlowYaml = `flow: r9-check-bind
version: 1
limits:
  budget:
    tokens: 10000
    steps: 10
steps:
  - id: generate
    type: agent
    outputs: [output_file]
  - id: verify
    type: check
    against: generate.output_file
    run: [check_nonempty]
`;
    // Case A: Occurrence 1 writes nonempty generate.output_file, fails, judged notify.
    // Occurrence 2 succeeds with NO output_file receipt -> verify MUST FAIL (cannot certify occurrence 1's bytes!).
    const staleRun = "run-r9-stale-occ";
    planAndApproveRun({ projectId, runId: staleRun, flowYaml: checkFlowYaml, dataRoot: scratchDir });
    let occ1Sha = "";
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(staleRun)[1]!;
      store.appendEvent({
        v: 1, runId: staleRun, seq: 3, eventId: "ev_s", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 10000, steps: 10 } },
      });
      // Occurrence 1: writes nonempty output_file, then fails + notify
      const i1 = store.allocateAndAppendStepIntent({ runId: staleRun, stepId: "generate" });
      const rec1 = store.writeAndRecordArtifact({
        artifactId: "art_occ1", runId: staleRun, stepId: "generate", attemptId: i1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("stale failed occurrence 1", "utf8"),
      });
      occ1Sha = rec1.contentHash;
      const a1 = store.appendEvent({
        v: 1, runId: staleRun, seq: i1.seq + 1, eventId: "ea1", prev: i1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: i1.attemptId,
        data: { artefactId: "art_occ1", sha256: rec1.contentHash, sizeBytes: rec1.size },
      });
      const f1 = store.appendEvent({
        v: 1, runId: staleRun, seq: a1.seq + 1, eventId: "ef1", prev: a1.hash,
        at: new Date().toISOString(), actor: "runner", type: "step_failed",
        stepId: "generate", attemptId: i1.attemptId,
        data: { errorCode: "execution_error" },
      });
      store.appendEvent({
        v: 1, runId: staleRun, seq: f1.seq + 1, eventId: "ej1", prev: f1.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: i1.attemptId,
        data: { final: "notify", ruleHits: ["retry_step"], reasonCodes: ["retry"], engineTokens: 0 },
      });
      // Occurrence 2: succeeds with NO output_file receipt
      const i2 = store.allocateAndAppendStepIntent({ runId: staleRun, stepId: "generate" });
      const r2 = store.appendEvent({
        v: 1, runId: staleRun, seq: i2.seq + 1, eventId: "er2", prev: i2.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "generate", attemptId: i2.attemptId,
        data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId: staleRun, seq: r2.seq + 1, eventId: "ej2", prev: r2.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: i2.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });
    });

    // Direct runner resume MUST fail verify (stopped), NOT certify occurrence 1's stale bytes!
    const staleRes = await runFlow(projectId, staleRun, { dataRoot: scratchDir });
    expect(staleRes.finalStatus).toBe("stopped");
    const staleLoaded = loadRunState(projectId, staleRun, { dataRoot: scratchDir });
    const chkEv = staleLoaded.events.find((e) => e.type === "check_result");
    expect(chkEv?.type === "check_result" && chkEv.data.passed).toBe(false);
    expect(chkEv?.type === "check_result" && chkEv.data.targetSha).toBe("0".repeat(64));
    expect(chkEv?.type === "check_result" && chkEv.data.targetSha).not.toBe(occ1Sha);

    // Case B: Numeric artefact ID "1" recorded AFTER non-numeric "art_first" with same receipt name "output_file"
    // on the same successful occurrence -> runner & store MUST agree "1" (nonempty) is latest and finish done!
    const numIdRun = "run-r9-num-id";
    planAndApproveRun({ projectId, runId: numIdRun, flowYaml: checkFlowYaml, dataRoot: scratchDir });
    let numericArtSha = "";
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(numIdRun)[1]!;
      store.appendEvent({
        v: 1, runId: numIdRun, seq: 3, eventId: "ev_s", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 10000, steps: 10 } },
      });
      const i1 = store.allocateAndAppendStepIntent({ runId: numIdRun, stepId: "generate" });
      const recFirst = store.writeAndRecordArtifact({
        artifactId: "art_first", runId: numIdRun, stepId: "generate", attemptId: i1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.alloc(0),
      });
      const a1 = store.appendEvent({
        v: 1, runId: numIdRun, seq: i1.seq + 1, eventId: "ea1", prev: i1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: i1.attemptId,
        data: { artefactId: "art_first", sha256: recFirst.contentHash, sizeBytes: 0 },
      });
      const recNum = store.writeAndRecordArtifact({
        artifactId: "1", runId: numIdRun, stepId: "generate", attemptId: i1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("numeric id latest nonempty", "utf8"),
      });
      numericArtSha = recNum.contentHash;
      const a2 = store.appendEvent({
        v: 1, runId: numIdRun, seq: a1.seq + 1, eventId: "ea2", prev: a1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: i1.attemptId,
        data: { artefactId: "1", sha256: recNum.contentHash, sizeBytes: recNum.size },
      });
      const r1 = store.appendEvent({
        v: 1, runId: numIdRun, seq: a2.seq + 1, eventId: "er1", prev: a2.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "generate", attemptId: i1.attemptId,
        data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId: numIdRun, seq: r1.seq + 1, eventId: "ej1", prev: r1.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: i1.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });
    });
    const numRes = await runFlow(projectId, numIdRun, { dataRoot: scratchDir });
    expect(numRes.finalStatus).toBe("finished");
    const numLoaded = loadRunState(projectId, numIdRun, { dataRoot: scratchDir });
    const numChk = numLoaded.events.find((e) => e.type === "check_result");
    expect(numChk?.type === "check_result" && numChk.data.passed).toBe(true);
    expect(numChk?.type === "check_result" && numChk.data.targetSha).toBe(numericArtSha);
  });

  it("Round 9 Majors 1, 2 & 3: detects flows.owner inode swap, enforces append-time step deadline rollback, and refuses direct budget inflation", () => {
    // Major 3: Direct append of run_started with inflated budget on a 1-token pinned flow MUST fail
    const oneTokYaml = `flow: r9-one-tok\nversion: 1\nlimits:\n  budget:\n    tokens: 1\n    steps: 5\nsteps:\n  - id: only_step\n    type: agent\n`;
    const budRun = "run-r9-bud";
    planAndApproveRun({ projectId, runId: budRun, flowYaml: oneTokYaml, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(budRun)[1]!;
      expect(() =>
        store.appendEvent({
          v: 1, runId: budRun, seq: 3, eventId: "ev_inflate", prev: ev2.hash,
          at: new Date().toISOString(), actor: "runner", type: "run_started",
          data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000, steps: 5 } },
        }),
      ).toThrow(/disagrees with pinned flow budget/);
    });

    // Major 2: Append-time deadline exceeded rolls back check_result + step_result + judgement cleanly
    const dlRun = "run-r9-deadline";
    planAndApproveRun({ projectId, runId: dlRun, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });
    withOwnedStore(projectId, scratchDir, (store) => {
      const ev2 = store.getEvents(dlRun)[1]!;
      store.appendEvent({
        v: 1, runId: dlRun, seq: 3, eventId: "ev_s", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });
      const i1 = store.allocateAndAppendStepIntent({ runId: dlRun, stepId: "only_step" });
      expect(() =>
        store.appendChainedBatch(
          dlRun,
          [
            (seq, prev) => ({
              event: {
                v: 1, runId: dlRun, seq, eventId: "ev_late_res", prev,
                at: new Date().toISOString(), actor: "agent", type: "step_result",
                stepId: "only_step", attemptId: i1.attemptId,
                data: { outputs: { status: "ok" }, tokensUsed: 10, wallTimeMs: 500 },
              },
            }),
            (seq, prev) => ({
              event: {
                v: 1, runId: dlRun, seq, eventId: "ev_late_j", prev,
                at: new Date().toISOString(), actor: "system", type: "judgement",
                stepId: "only_step", attemptId: i1.attemptId,
                data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
              },
            }),
          ],
          { deadlineMs: Date.now() - 1 },
        ),
      ).toThrow(StepDeadlineExceededError);
      expect(store.getParsedEvents(dlRun).some((e) => e.type === "step_result")).toBe(false);
    });

    // Major 1: Unlinking & replacing flows.owner while lock is held invalidates active lock immediately
    const swapProj = "adv-r9-owner-swap";
    const swapRun = "run-r9-swap";
    planAndApproveRun({ projectId: swapProj, runId: swapRun, flowYaml: ONE_STEP_YAML, dataRoot: scratchDir });
    const swapLock = acquireOwnerLock(swapProj, scratchDir);
    const swapStore = openFlowsStore(swapProj, { dataRoot: scratchDir, ownerLock: swapLock });
    try {
      const ev2 = swapStore.getEvents(swapRun)[1]!;
      // Replace flows.owner with a brand-new inode while swapLock holds the unlinked inode
      fs.unlinkSync(swapLock.lockPath);
      fs.writeFileSync(swapLock.lockPath, "", { mode: 0o600 });
      expect(() =>
        swapStore.appendEvent({
          v: 1, runId: swapRun, seq: 3, eventId: "ev_after_swap", prev: ev2.hash,
          at: new Date().toISOString(), actor: "runner", type: "run_started",
          data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
        }),
      ).toThrow(OwnerLockRequiredError);
    } finally {
      swapStore.close();
      swapLock.release();
    }
  });

  it("Round 10 Critical 2: producer re-run invalidates prior check pass in BOTH store (run_finished) and runner resume", async () => {
    const projectId = "adv-r10-c2-proj";
    const runId = "run-r10-c2";
    const twoStepYaml = `flow: r10-c2-flow
version: 1
limits:
  budget:
    tokens: 5000
    steps: 10
steps:
  - id: generate
    type: agent
    outputs: [output_file]
  - id: verify
    type: check
    against: generate.output_file
    run: [check_nonempty]
`;
    const flowHash = crypto.createHash("sha256").update(twoStepYaml, "utf8").digest("hex");
    const lock = acquireOwnerLock(projectId, scratchDir);
    const store = openFlowsStore(projectId, { dataRoot: scratchDir, ownerLock: lock });
    let occ2Sha = "";
    try {
      store.createAndApproveRun({
        runId, flowRef: "r10-c2-flow", flowHash,
        flowYamlBytes: twoStepYaml, source: "builtin", expectedDecisions: [], actorId: "op-1",
      });
      const ev2 = store.getEvents(runId)[1]!;
      store.appendEvent({
        v: 1, runId, seq: 3, eventId: "e3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 5000, steps: 10 } },
      });

      // Occurrence 1 of generate -> artefact 1 -> step_result -> judgement(continue)
      const g1 = store.allocateAndAppendStepIntent({ runId, stepId: "generate" });
      const art1 = store.writeAndRecordArtifact({
        artifactId: "art_g1", runId, stepId: "generate", attemptId: g1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("draft version 1"),
      });
      const g1a = store.appendEvent({
        v: 1, runId, seq: g1.seq + 1, eventId: "eg1a", prev: g1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: g1.attemptId,
        data: { artefactId: "art_g1", sha256: art1.contentHash, sizeBytes: art1.size },
      });
      const g1r = store.appendEvent({
        v: 1, runId, seq: g1a.seq + 1, eventId: "eg1r", prev: g1a.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "generate", attemptId: g1.attemptId,
        data: { outputs: { output_file: art1.contentHash }, tokensUsed: 10, wallTimeMs: 5 },
      });
      store.appendEvent({
        v: 1, runId, seq: g1r.seq + 1, eventId: "eg1j", prev: g1r.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: g1.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      // Occurrence 1 of verify passes against art1.contentHash
      const v1 = store.allocateAndAppendStepIntent({ runId, stepId: "verify" });
      store.appendChainedBatch(runId, [
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: "ev1c", prev,
            at: new Date().toISOString(), actor: "runner", type: "check_result",
            stepId: "verify", attemptId: v1.attemptId,
            data: { checkId: "check_nonempty", passed: true, targetSha: art1.contentHash },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: "ev1r", prev,
            at: new Date().toISOString(), actor: "runner", type: "step_result",
            stepId: "verify", attemptId: v1.attemptId,
            data: { outputs: { status: "ok" }, tokensUsed: 0, wallTimeMs: 1 },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: "ev1j", prev,
            at: new Date().toISOString(), actor: "system", type: "judgement",
            stepId: "verify", attemptId: v1.attemptId,
            data: { final: "continue", ruleHits: ["check_passed"], reasonCodes: ["ok"], engineTokens: 0 },
          },
        }),
      ]);

      // Now generate occurrence 2 produces DIFFERENT verified bytes and continues!
      const g2 = store.allocateAndAppendStepIntent({ runId, stepId: "generate" });
      const art2 = store.writeAndRecordArtifact({
        artifactId: "art_g2", runId, stepId: "generate", attemptId: g2.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("draft version 2 superseding 1"),
      });
      occ2Sha = art2.contentHash;
      expect(occ2Sha).not.toBe(art1.contentHash);
      const g2a = store.appendEvent({
        v: 1, runId, seq: g2.seq + 1, eventId: "eg2a", prev: g2.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: g2.attemptId,
        data: { artefactId: "art_g2", sha256: art2.contentHash, sizeBytes: art2.size },
      });
      const g2r = store.appendEvent({
        v: 1, runId, seq: g2a.seq + 1, eventId: "eg2r", prev: g2a.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "generate", attemptId: g2.attemptId,
        data: { outputs: { output_file: art2.contentHash }, tokensUsed: 10, wallTimeMs: 5 },
      });
      const g2j = store.appendEvent({
        v: 1, runId, seq: g2r.seq + 1, eventId: "eg2j", prev: g2r.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: g2.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      // Store MUST reject run_finished(done) because verify's prior pass was invalidated by generate occ 2!
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: g2j.seq + 1, eventId: "efin", prev: g2j.hash,
          at: new Date().toISOString(), actor: "system", type: "run_finished",
          data: { outcome: "done", reasonCode: "completed" },
        }),
      ).toThrow(/has not completed|has not verified current target/);
    } finally {
      store.close();
      lock.release();
    }

    // Runner resume MUST NOT skip verify; it must re-run verify occ 2 against occ2Sha and then finish done!
    const res = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(res.terminalOutcome).toBe("done");
    expect(res.dispatchedSteps.map((s) => s.stepId)).toEqual(["verify"]);
    expect(res.dispatchedSteps[0]!.occurrence).toBe(2);
    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    const checkEvents = loaded.events.filter((e) => e.type === "check_result");
    expect(checkEvents).toHaveLength(2);
    expect(checkEvents[1]!.data.targetSha).toBe(occ2Sha);
  });

  it("Round 10 Majors 1-5 & Minor 4: sync hook overrun, store-generated eventId, re-entrant close(), createRun/recordArtifact getter lock release, illegal multi-event batch, and own __proto__", async () => {
    // Major 1: Synchronous onStepDispatch hook that stalls past stepTimeoutMs commits ZERO artefact/receipt
    const syncProj = "adv-r10-m1-sync";
    const syncRun = "run-r10-m1-sync";
    const syncYaml = `flow: r10-m1-sync
version: 1
limits:
  budget:
    tokens: 500
    steps: 2
steps:
  - id: only_step
    type: agent
    outputs: [output_file]
`;
    planAndApproveRun({ projectId: syncProj, runId: syncRun, flowYaml: syncYaml, dataRoot: scratchDir });
    const syncRes = await runFlow(syncProj, syncRun, {
      dataRoot: scratchDir,
      stepTimeoutMs: 40,
      onStepDispatch: () => {
        const end = Date.now() + 80;
        while (Date.now() < end) {
          // Synchronous busy-wait past deadline before timer callback can fire
        }
      },
    });
    expect(syncRes.terminalOutcome).toBe("stopped");
    const syncLoaded = loadRunState(syncProj, syncRun, { dataRoot: scratchDir });
    expect(syncLoaded.events.some((e) => e.type === "artefact_recorded")).toBe(false);
    expect(syncLoaded.events.some((e) => e.type === "step_result")).toBe(false);
    expect(syncLoaded.verifiedArtefacts.size).toBe(0);
    const syncStoreRo = openFlowsStore(syncProj, { dataRoot: scratchDir, readonly: true });
    try {
      expect(syncStoreRo.listArtifacts(syncRun)).toHaveLength(0);
    } finally {
      syncStoreRo.close();
    }

    // Majors 2, 3, 4, 5 & Minor 4
    const proj = "adv-r10-majors";
    const runId = "run-r10-majors";
    const lock = acquireOwnerLock(proj, scratchDir);
    const store = openFlowsStore(proj, { dataRoot: scratchDir, ownerLock: lock });
    try {
      store.createAndApproveRun({
        runId, flowRef: "adv-one-step", flowHash: ONE_STEP_HASH,
        flowYamlBytes: ONE_STEP_YAML, source: "builtin", expectedDecisions: [], actorId: "op-1",
      });
      const ev2 = store.getEvents(runId)[1]!;
      store.appendEvent({
        v: 1, runId, seq: 3, eventId: "ev_s", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });
      const i1 = store.allocateAndAppendStepIntent({ runId, stepId: "only_step" });

      // Major 5: Batching artefact_recorded + agent step_result is REJECTED in BOTH batchAppendEvents and appendChainedBatch
      const art = store.writeAndRecordArtifact({
        artifactId: "art_m5", runId, stepId: "only_step", attemptId: i1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("payload"),
      });
      const artEv: FlowEvent = {
        v: 1, runId, seq: i1.seq + 1, eventId: "e_art", prev: i1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "only_step", attemptId: i1.attemptId,
        data: { artefactId: "art_m5", sha256: art.contentHash, sizeBytes: art.size },
      };
      expect(() =>
        store.batchAppendEvents([
          { event: artEv },
          {
            event: {
              v: 1, runId, seq: i1.seq + 2, eventId: "e_res", prev: "0".repeat(64),
              at: new Date().toISOString(), actor: "agent", type: "step_result",
              stepId: "only_step", attemptId: i1.attemptId,
              data: { outputs: { output_file: art.contentHash }, tokensUsed: 5, wallTimeMs: 5 },
            },
          },
        ]),
      ).toThrow(/violates Revision 4 deterministic batching rule/);

      expect(() =>
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "e_art", prev,
              at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
              stepId: "only_step", attemptId: i1.attemptId,
              data: { artefactId: "art_m5", sha256: art.contentHash, sizeBytes: art.size },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "e_res", prev,
              at: new Date().toISOString(), actor: "agent", type: "step_result",
              stepId: "only_step", attemptId: i1.attemptId,
              data: { outputs: { output_file: art.contentHash }, tokensUsed: 5, wallTimeMs: 5 },
            },
          }),
        ]),
      ).toThrow(/violates Revision 4 deterministic batching rule/);
      // Rollback verified: neither event committed
      expect(store.getParsedEvents(runId).some((e) => e.type === "artefact_recorded")).toBe(false);

      // Minor 4: JSON-parsed own "__proto__" in outputs MUST be rejected by materializePlain
      const protoOutputs = JSON.parse('{"__proto__":{"status":"ok"}}') as Record<string, string>;
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: i1.seq + 1, eventId: "e_proto", prev: i1.hash,
          at: new Date().toISOString(), actor: "agent", type: "step_result",
          stepId: "only_step", attemptId: i1.attemptId,
          data: { outputs: protoOutputs, tokensUsed: 1, wallTimeMs: 1 },
        }),
      ).toThrow(/forbidden property '__proto__'/);

      // Major 3: Re-entrant store.close() inside appendChainedBatch builder MUST throw IllegalFlowTransitionError
      // and leave the store open and usable
      expect(() =>
        store.appendChainedBatch(runId, [
          (seq, prev) => {
            store.close();
            return {
              event: {
                v: 1, runId, seq, eventId: "e_fail", prev,
                at: new Date().toISOString(), actor: "runner", type: "step_failed",
                stepId: "only_step", attemptId: i1.attemptId,
                data: { errorCode: "timeout" },
              },
            };
          },
        ]),
      ).toThrow(/Reentrant store mutation/);

      // Major 2: Store-generated eventId prevents private text smuggling via caller eventId
      store.appendEvent(
        {
          v: 1, runId, seq: i1.seq + 1, eventId: "synthetic_private_token", prev: i1.hash,
          at: new Date().toISOString(), actor: "runner", type: "step_failed",
          stepId: "only_step", attemptId: i1.attemptId,
          data: { errorCode: "execution_error" },
        },
        { privateDetail: "synthetic_private_token" },
      );
      const exported = store.exportProjectionLines(runId).join("\n");
      expect(exported).not.toContain("synthetic_private_token");
      const failedEv = store.getParsedEvents(runId).find((e) => e.type === "step_failed")!;
      expect(failedEv.eventId).toMatch(/^ev_[0-9a-f]{24}$/);
    } finally {
      store.close();
      lock.release();
    }

    // Major 4: createRun with metadata getter releasing ownerLock MUST throw OwnerLockRequiredError and commit 0 rows
    const m4Proj = "adv-r10-m4-createrun";
    const m4Lock = acquireOwnerLock(m4Proj, scratchDir);
    const m4Store = openFlowsStore(m4Proj, { dataRoot: scratchDir, ownerLock: m4Lock });
    try {
      const evilMeta: Record<string, string> = {};
      Object.defineProperty(evilMeta, "k", {
        enumerable: true,
        get() {
          m4Lock.release();
          return "v";
        },
      });
      expect(() =>
        m4Store.createRun({
          runId: "run-m4-evil",
          flowHash: ONE_STEP_HASH,
          flowYamlBytes: ONE_STEP_YAML,
          metadata: evilMeta,
        }),
      ).toThrow(OwnerLockRequiredError);
      expect(m4Store.getRun("run-m4-evil")).toBeNull();
    } finally {
      m4Store.close();
      m4Lock.release();
    }

    // Major 4 (Part B): recordArtifact with parameter getter releasing ownerLock MUST throw OwnerLockRequiredError
    const m4bProj = "adv-r10-m4-recart";
    const m4bLock = acquireOwnerLock(m4bProj, scratchDir);
    const m4bStore = openFlowsStore(m4bProj, { dataRoot: scratchDir, ownerLock: m4bLock });
    try {
      m4bStore.createRun({
        runId: "run-m4b",
        flowHash: ONE_STEP_HASH,
        flowYamlBytes: ONE_STEP_YAML,
      });
      const written = m4bStore.writeAndRecordArtifact({
        artifactId: "art_seed", runId: "run-m4b", stepId: "only_step", attemptId: "att_1",
        name: "seed", mediaType: "text/plain", bytes: Buffer.from("seed"),
      });
      const evilArtParams = {
        artifactId: "art_evil",
        runId: "run-m4b",
        stepId: "only_step",
        attemptId: "att_1",
        contentHash: written.contentHash,
        mediaType: "text/plain",
        size: written.size,
        get name() {
          m4bLock.release();
          return "evil";
        },
      };
      expect(() => m4bStore.recordArtifact(evilArtParams)).toThrow(OwnerLockRequiredError);
      expect(m4bStore.getArtifact("run-m4b", "art_evil")).toBeNull();
    } finally {
      m4bStore.close();
      m4bLock.release();
    }

    // Critical 1 (Round 10): Direct proof that verifyOpenedSqliteFileInDirFd catches BOTH
    // unlink+replace AND rename+replace in the acquisition window (SQLite fd != live entry)
    const c1Dir = path.join(scratchDir, "r10-c1-dir");
    fs.mkdirSync(c1Dir, { recursive: true, mode: 0o700 });
    const c1DirFd = openDirFdNoFollow(c1Dir);
    try {
      const fdOwnerPath = `/proc/self/fd/${c1DirFd}/flows.owner`;
      const before1 = snapshotProcFds();
      const db1 = new Database(fdOwnerPath);
      try {
        db1.exec("BEGIN EXCLUSIVE;");
        // Normal live inode matches
        const okStat = verifyOpenedSqliteFileInDirFd(
          c1DirFd,
          before1,
          "flows.owner",
          assertSafeRegularLstatInDirFd(c1DirFd, "flows.owner"),
        );
        expect(okStat).not.toBeNull();

        // Unlink + replace: SQLite holds unlinked old inode, live entry has new inode -> MUST return null!
        fs.unlinkSync(fdOwnerPath);
        fs.writeFileSync(fdOwnerPath, "", { mode: 0o600 });
        const afterUnlink = verifyOpenedSqliteFileInDirFd(
          c1DirFd,
          before1,
          "flows.owner",
          assertSafeRegularLstatInDirFd(c1DirFd, "flows.owner"),
        );
        expect(afterUnlink).toBeNull();
      } finally {
        try {
          db1.exec("ROLLBACK;");
        } catch {
          // ignore
        }
        db1.close();
      }

      // Rename + replace: SQLite holds renamed flows.owner.old, live entry is fresh flows.owner -> MUST return null!
      const before2 = snapshotProcFds();
      const db2 = new Database(fdOwnerPath);
      try {
        db2.exec("BEGIN EXCLUSIVE;");
        fs.renameSync(fdOwnerPath, `/proc/self/fd/${c1DirFd}/flows.owner.old`);
        fs.writeFileSync(fdOwnerPath, "", { mode: 0o600 });
        const afterRename = verifyOpenedSqliteFileInDirFd(
          c1DirFd,
          before2,
          "flows.owner",
          assertSafeRegularLstatInDirFd(c1DirFd, "flows.owner"),
        );
        expect(afterRename).toBeNull();
      } finally {
        try {
          db2.exec("ROLLBACK;");
        } catch {
          // ignore
        }
        db2.close();
      }
    } finally {
      fs.closeSync(c1DirFd);
    }

    // Major 1 (Part B): Mid-batch deadline expiry (deadline valid at entry, expires during builder before COMMIT)
    const mbProj = "adv-r10-m1-midbatch";
    const mbRun = "run-r10-m1-midbatch";
    const mbLock = acquireOwnerLock(mbProj, scratchDir);
    const mbStore = openFlowsStore(mbProj, { dataRoot: scratchDir, ownerLock: mbLock });
    try {
      mbStore.createAndApproveRun({
        runId: mbRun, flowRef: "adv-one-step", flowHash: ONE_STEP_HASH,
        flowYamlBytes: ONE_STEP_YAML, source: "builtin", expectedDecisions: [], actorId: "op-1",
      });
      const ev2 = mbStore.getEvents(mbRun)[1]!;
      mbStore.appendEvent({
        v: 1, runId: mbRun, seq: 3, eventId: "ev_mb_s", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 100, steps: 1 } },
      });
      const mbIntent = mbStore.allocateAndAppendStepIntent({ runId: mbRun, stepId: "only_step" });
      const futureDeadline = Date.now() + 25;
      expect(() =>
        mbStore.appendChainedBatch(
          mbRun,
          [
            (seq, prev) => ({
              event: {
                v: 1, runId: mbRun, seq, eventId: "e_f", prev,
                at: new Date().toISOString(), actor: "runner", type: "step_failed",
                stepId: "only_step", attemptId: mbIntent.attemptId,
                data: { errorCode: "timeout" },
              },
            }),
            (seq, prev) => {
              // Expire deadline mid-batch after item 1 inserted and before item 2/commit
              while (Date.now() <= futureDeadline + 5) {
                // busy wait past deadline
              }
              return {
                event: {
                  v: 1, runId: mbRun, seq, eventId: "e_j", prev,
                  at: new Date().toISOString(), actor: "system", type: "judgement",
                  stepId: "only_step", attemptId: mbIntent.attemptId,
                  data: { final: "stop", ruleHits: ["step_timeout"], reasonCodes: ["timeout"], engineTokens: 0 },
                },
              };
            },
            (seq, prev) => ({
              event: {
                v: 1, runId: mbRun, seq, eventId: "e_fin", prev,
                at: new Date().toISOString(), actor: "system", type: "run_finished",
                data: { outcome: "stopped", reasonCode: "unrecoverable_failure" },
              },
            }),
          ],
          { deadlineMs: futureDeadline },
        ),
      ).toThrow(StepDeadlineExceededError);
      // Full rollback: zero step_failed committed
      expect(mbStore.getParsedEvents(mbRun).some((e) => e.type === "step_failed")).toBe(false);
    } finally {
      mbStore.close();
      mbLock.release();
    }
  });

  it("Round 11 Majors 1-4: artefact receipt deadline, run_started attemptId refusal, deterministic check batch content + 4-event spec example, and 3-step generate -> verify -> package flow", async () => {
    // Major 4: Valid 3-step generate -> verify (no against) -> package flow where package writes DIFFERENT bytes
    // MUST finish done cleanly (never rebind verify to later downstream package step!)
    const threeStepProj = "adv-r11-3step";
    const threeStepRun = "run-r11-3step";
    const threeStepYaml = `flow: r11-three-step
version: 1
limits:
  budget:
    tokens: 5000
    steps: 10
steps:
  - id: generate
    type: agent
    outputs: [output_file]
  - id: verify
    type: check
    run: [check_nonempty]
  - id: package
    type: agent
    outputs: [bundle]
`;
    planAndApproveRun({ projectId: threeStepProj, runId: threeStepRun, flowYaml: threeStepYaml, dataRoot: scratchDir });
    const threeRes = await runFlow(threeStepProj, threeStepRun, { dataRoot: scratchDir });
    expect(threeRes.terminalOutcome).toBe("done");
    expect(threeRes.dispatchedSteps.map((s) => s.stepId)).toEqual(["generate", "verify", "package"]);

    // Majors 1, 2, 3: Direct store proofs
    const proj = "adv-r11-store";
    const lock = acquireOwnerLock(proj, scratchDir);
    const store = openFlowsStore(proj, { dataRoot: scratchDir, ownerLock: lock });
    try {
      const twoStepYaml = `flow: r11-two-step
version: 1
limits:
  budget:
    tokens: 5000
    steps: 10
steps:
  - id: generate
    type: agent
    outputs: [output_file]
  - id: verify
    type: check
    against: generate.output_file
    run: [check_nonempty]
`;
      const twoHash = crypto.createHash("sha256").update(twoStepYaml, "utf8").digest("hex");
      const runId = "run-r11-m23";
      store.createAndApproveRun({
        runId, flowRef: "r11-two-step", flowHash: twoHash,
        flowYamlBytes: twoStepYaml, source: "builtin", expectedDecisions: [], actorId: "op-1",
      });
      const ev2 = store.getEvents(runId)[1]!;

      // Major 2: Optional attemptId on run-level run_started MUST be rejected (cannot smuggle private text)
      expect(() =>
        store.appendEvent(
          {
            v: 1, runId, seq: 3, eventId: "e3_bad", prev: ev2.hash,
            at: new Date().toISOString(), actor: "runner", type: "run_started",
            attemptId: "synthetic_private_token",
            data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 5000, steps: 10 } },
          } as unknown as FlowEvent,
          { privateDetail: "synthetic_private_token" },
        ),
      ).toThrow(/schema validation|Unrecognized key/);
      expect(store.exportProjectionLines(runId).join("\n")).not.toContain("synthetic_private_token");

      store.appendEvent({
        v: 1, runId, seq: 3, eventId: "e3", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 5000, steps: 10 } },
      });

      const g1 = store.allocateAndAppendStepIntent({ runId, stepId: "generate" });

      // Major 1: writeAndRecordArtifact with expired deadlineMs throws StepDeadlineExceededError & commits 0 receipts
      expect(() =>
        store.writeAndRecordArtifact({
          artifactId: "art_expired", runId, stepId: "generate", attemptId: g1.attemptId,
          name: "output_file", mediaType: "text/plain", bytes: Buffer.from("late bytes"),
          deadlineMs: Date.now() - 1,
        }),
      ).toThrow(StepDeadlineExceededError);
      expect(store.getArtifact(runId, "art_expired")).toBeNull();

      const art = store.writeAndRecordArtifact({
        artifactId: "art_ok", runId, stepId: "generate", attemptId: g1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("valid draft"),
      });
      const ga = store.appendEvent({
        v: 1, runId, seq: g1.seq + 1, eventId: "ega", prev: g1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: g1.attemptId,
        data: { artefactId: "art_ok", sha256: art.contentHash, sizeBytes: art.size },
      });
      const gr = store.appendEvent({
        v: 1, runId, seq: ga.seq + 1, eventId: "egr", prev: ga.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "generate", attemptId: g1.attemptId,
        data: { outputs: { output_file: art.contentHash }, tokensUsed: 10, wallTimeMs: 5 },
      });
      store.appendEvent({
        v: 1, runId, seq: gr.seq + 1, eventId: "egj", prev: gr.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: g1.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      const v1 = store.allocateAndAppendStepIntent({ runId, stepId: "verify" });

      // Major 3 (Part A): Passing check_result batched with nonzero tokensUsed on step_result MUST be rejected!
      expect(() =>
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "ec", prev,
              at: new Date().toISOString(), actor: "runner", type: "check_result",
              stepId: "verify", attemptId: v1.attemptId,
              data: { checkId: "check_nonempty", passed: true, targetSha: art.contentHash },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "er", prev,
              at: new Date().toISOString(), actor: "runner", type: "step_result",
              stepId: "verify", attemptId: v1.attemptId,
              data: { outputs: { check: "passed" }, tokensUsed: 42, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "ej", prev,
              at: new Date().toISOString(), actor: "system", type: "judgement",
              stepId: "verify", attemptId: v1.attemptId,
              data: { final: "continue", ruleHits: ["check_passed"], reasonCodes: ["ok"], engineTokens: 0 },
            },
          }),
        ]),
      ).toThrow(/tokensUsed === 0/);

      // Major 3 (Part B): Spec's explicit 4-event successful deterministic batch ending in run_finished(done) SUCCEEDS!
      const fourOut = store.appendChainedBatch(runId, [
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: "ec2", prev,
            at: new Date().toISOString(), actor: "runner", type: "check_result",
            stepId: "verify", attemptId: v1.attemptId,
            data: { checkId: "check_nonempty", passed: true, targetSha: art.contentHash },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: "er2", prev,
            at: new Date().toISOString(), actor: "runner", type: "step_result",
            stepId: "verify", attemptId: v1.attemptId,
            data: { outputs: { check: "passed" }, tokensUsed: 0, wallTimeMs: 1 },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: "ej2", prev,
            at: new Date().toISOString(), actor: "system", type: "judgement",
            stepId: "verify", attemptId: v1.attemptId,
            data: { final: "continue", ruleHits: ["check_passed"], reasonCodes: ["ok"], engineTokens: 0 },
          },
        }),
        (seq, prev) => ({
          event: {
            v: 1, runId, seq, eventId: "efin2", prev,
            at: new Date().toISOString(), actor: "system", type: "run_finished",
            data: { outcome: "done", reasonCode: "completed" },
          },
        }),
      ]);
      expect(fourOut).toHaveLength(4);
      expect(store.getRun(runId)?.status).toBe("finished");
    } finally {
      store.close();
      lock.release();
    }
  });

  it("Round 12 Final (M2, M3, M4): strict runnerVersion & deterministic attemptId, explicit unqualified against preceding-step scope, and consistent passing-check batch facts", async () => {
    // M3: Valid 3-step generate -> verify (against: output_file, unqualified!) -> package (ALSO declaring output_file)
    // MUST finish done cleanly without rebinding verify to later package step!
    const unqualProj = "adv-r12-unqual";
    const unqualRun = "run-r12-unqual";
    const unqualYaml = `flow: r12-unqual-against
version: 1
limits:
  budget:
    tokens: 5000
    steps: 10
steps:
  - id: generate
    type: agent
    outputs: [output_file]
  - id: verify
    type: check
    against: output_file
    run: [check_nonempty]
  - id: package
    type: agent
    outputs: [output_file]
`;
    planAndApproveRun({ projectId: unqualProj, runId: unqualRun, flowYaml: unqualYaml, dataRoot: scratchDir });
    const unqualRes = await runFlow(unqualProj, unqualRun, { dataRoot: scratchDir });
    expect(unqualRes.terminalOutcome).toBe("done");
    expect(unqualRes.dispatchedSteps.map((s) => s.stepId)).toEqual(["generate", "verify", "package"]);

    // M4 & M2: Direct store proofs
    const proj = "adv-r12-m24";
    const lock = acquireOwnerLock(proj, scratchDir);
    const store = openFlowsStore(proj, { dataRoot: scratchDir, ownerLock: lock });
    try {
      const twoStepYaml = `flow: r12-two-step
version: 1
limits:
  budget:
    tokens: 5000
    steps: 10
steps:
  - id: generate
    type: agent
    outputs: [output_file]
  - id: verify
    type: check
    against: generate.output_file
    run: [check_nonempty]
`;
      const twoHash = crypto.createHash("sha256").update(twoStepYaml, "utf8").digest("hex");
      const runId = "run-r12-m24";
      store.createAndApproveRun({
        runId, flowRef: "r12-two-step", flowHash: twoHash,
        flowYamlBytes: twoStepYaml, source: "builtin", expectedDecisions: [], actorId: "op-1",
      });
      const ev2 = store.getEvents(runId)[1]!;

      // M4 (Part A): run_started with private token in runnerVersion MUST be rejected
      expect(() =>
        store.appendEvent(
          {
            v: 1, runId, seq: 3, eventId: "e3_bad_ver", prev: ev2.hash,
            at: new Date().toISOString(), actor: "runner", type: "run_started",
            data: { runnerVersion: "synthetic_private_token", inputIds: {}, budget: { tokens: 5000, steps: 10 } },
          },
          { privateDetail: "synthetic_private_token" },
        ),
      ).toThrow(/schema validation/);

      const r3 = store.appendEvent({
        v: 1, runId, seq: 3, eventId: "e3_ok", prev: ev2.hash,
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 5000, steps: 10 } },
      });

      // M4 (Part B): Direct step_started with caller-chosen attemptId MUST be rejected
      expect(() =>
        store.appendEvent(
          {
            v: 1, runId, seq: 4, eventId: "e4_bad_att", prev: r3.hash,
            at: new Date().toISOString(), actor: "runner", type: "step_started",
            stepId: "generate", attemptId: "synthetic_private_token",
            data: { occurrence: 1, effectKey: buildDeterministicEffectKey(runId, "generate", 1) },
          },
          { privateDetail: "synthetic_private_token" },
        ),
      ).toThrow(/must match deterministic attemptId/);
      expect(store.exportProjectionLines(runId).join("\n")).not.toContain("synthetic_private_token");

      const g1 = store.allocateAndAppendStepIntent({ runId, stepId: "generate" });
      const art = store.writeAndRecordArtifact({
        artifactId: "art_r12", runId, stepId: "generate", attemptId: g1.attemptId,
        name: "output_file", mediaType: "text/plain", bytes: Buffer.from("r12 content"),
      });
      const ga = store.appendEvent({
        v: 1, runId, seq: g1.seq + 1, eventId: "ega", prev: g1.hash,
        at: new Date().toISOString(), actor: "runner", type: "artefact_recorded",
        stepId: "generate", attemptId: g1.attemptId,
        data: { artefactId: "art_r12", sha256: art.contentHash, sizeBytes: art.size },
      });
      const gr = store.appendEvent({
        v: 1, runId, seq: ga.seq + 1, eventId: "egr", prev: ga.hash,
        at: new Date().toISOString(), actor: "agent", type: "step_result",
        stepId: "generate", attemptId: g1.attemptId,
        data: { outputs: { output_file: art.contentHash }, tokensUsed: 5, wallTimeMs: 1 },
      });
      store.appendEvent({
        v: 1, runId, seq: gr.seq + 1, eventId: "egj", prev: gr.hash,
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "generate", attemptId: g1.attemptId,
        data: { final: "continue", ruleHits: ["step_passed"], reasonCodes: ["ok"], engineTokens: 0 },
      });

      const v1 = store.allocateAndAppendStepIntent({ runId, stepId: "verify" });

      // M2 (Part A): Passing check_result batched with contradictory step_result output check: 'failed' REJECTED
      expect(() =>
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "ec_m2a", prev,
              at: new Date().toISOString(), actor: "runner", type: "check_result",
              stepId: "verify", attemptId: v1.attemptId,
              data: { checkId: "check_nonempty", passed: true, targetSha: art.contentHash },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "er_m2a", prev,
              at: new Date().toISOString(), actor: "runner", type: "step_result",
              stepId: "verify", attemptId: v1.attemptId,
              data: { outputs: { check: "failed" }, tokensUsed: 0, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "ej_m2a", prev,
              at: new Date().toISOString(), actor: "system", type: "judgement",
              stepId: "verify", attemptId: v1.attemptId,
              data: { final: "continue", ruleHits: ["check_passed"], reasonCodes: ["ok"], engineTokens: 0 },
            },
          }),
        ]),
      ).toThrow(/contradicts passing check_result/);

      // M2 (Part B): Passing check_result batched with contradictory judgement(continue) reasonCodes: ['timeout'] REJECTED
      expect(() =>
        store.appendChainedBatch(runId, [
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "ec_m2b", prev,
              at: new Date().toISOString(), actor: "runner", type: "check_result",
              stepId: "verify", attemptId: v1.attemptId,
              data: { checkId: "check_nonempty", passed: true, targetSha: art.contentHash },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "er_m2b", prev,
              at: new Date().toISOString(), actor: "runner", type: "step_result",
              stepId: "verify", attemptId: v1.attemptId,
              data: { outputs: { check: "passed" }, tokensUsed: 0, wallTimeMs: 1 },
            },
          }),
          (seq, prev) => ({
            event: {
              v: 1, runId, seq, eventId: "ej_m2b", prev,
              at: new Date().toISOString(), actor: "system", type: "judgement",
              stepId: "verify", attemptId: v1.attemptId,
              data: { final: "continue", ruleHits: ["check_passed"], reasonCodes: ["timeout"], engineTokens: 0 },
            },
          }),
        ]),
      ).toThrow(/reasonCodes \['ok'\]/);
    } finally {
      store.close();
      lock.release();
    }
  });
});
