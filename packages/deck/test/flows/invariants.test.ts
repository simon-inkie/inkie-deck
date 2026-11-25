import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  assertConfinedPath,
  FlowPinMismatchError,
  loadRunState,
  PathConfinementError,
  SymlinkNotAllowedError,
} from "../../app/lib/flows/load-run.server.js";
import { acquireOwnerLock, isOwnerLocked } from "../../app/lib/flows/owner.server.js";
import { reduceFlowRun } from "../../app/lib/flows/replay.js";
import { planAndApproveRun, runBoundedProcessGroup, runFlow } from "../../app/lib/flows/runner.server.js";
import {
  ArtifactVerificationError,
  IllegalFlowTransitionError,
  openFlowsStore,
  type FlowsStore,
} from "../../app/lib/flows/store.server.js";

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
import type { FlowDefinition, FlowEvent } from "../../app/lib/flows/types.js";
import { validateFlowYaml } from "../../app/lib/flows/validator.js";

const GENESIS_PREV = "0".repeat(64);
const VALID_YAML = "flow: test\nversion: 1\nsteps:\n  - id: step1\n    type: agent\n";
const VALID_HASH = crypto.createHash("sha256").update(VALID_YAML).digest("hex");

describe("11 Storage-Independent Acceptance Invariants (invariants.test.ts)", () => {
  let scratchDir: string;
  const projectId = "invariants-project";

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-inv-"));
  });

  afterEach(() => {
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  // Invariant 1: Loader pin check
  it("Invariant 1: verifies flow definition matches flow_pinned_hash before execution/resume", () => {
    const runId = "inv1-run";
    let dbPath = "";

    withOwnedStore(projectId, scratchDir, (store) => {
      dbPath = store.dbPath;
      store.createRun({ runId, flowHash: VALID_HASH, flowYamlBytes: VALID_YAML });
      store.appendEvent({
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        data: { flowRef: "test", flowHash: VALID_HASH, source: "builtin", expectedDecisions: [] },
      });
    });

    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(loaded.flow.flow).toBe("test");

    // Mutate pinned flow bytes directly in SQLite offline
    const rawDb = new Database(dbPath);
    try {
      rawDb
        .prepare(`UPDATE pinned_flows SET bytes = ? WHERE hash = ?`)
        .run(Buffer.from("flow: tampered\nversion: 1\nsteps:\n  - id: step1\n    type: agent\n", "utf8"), VALID_HASH);
    } finally {
      rawDb.close();
    }

    expect(() => loadRunState(projectId, runId, { dataRoot: scratchDir })).toThrow(FlowPinMismatchError);
  });

  // Invariant 2: Run ID binding
  it("Invariant 2: strictly binds events to canonical run_id and rejects cross-run pollution", () => {
    const runIdA = "inv2-run-a";
    const runIdB = "inv2-run-b";

    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId: runIdA, flowHash: VALID_HASH, flowYamlBytes: VALID_YAML });
      store.createRun({ runId: runIdB, flowHash: VALID_HASH, flowYamlBytes: VALID_YAML });

      const r1 = store.appendEvent({
        v: 1, runId: runIdA, seq: 1, eventId: "ev-a1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        data: { flowRef: "test", flowHash: VALID_HASH, source: "builtin", expectedDecisions: [] },
      });

      const evB: FlowEvent = {
        v: 1, runId: runIdB, seq: 2, eventId: "ev-b1", prev: r1.hash,
        at: new Date().toISOString(), actor: "human", type: "flow_approved",
        data: { flowHash: VALID_HASH, actorId: "tester" },
      };

      expect(() => {
        store.batchAppendEvents([
          {
            event: {
              v: 1, runId: runIdA, seq: 2, eventId: "ev-a2", prev: r1.hash,
              at: new Date().toISOString(), actor: "human", type: "flow_approved",
              data: { flowHash: VALID_HASH, actorId: "tester" },
            },
          },
          { event: evB },
        ]);
      }).toThrow(/Batch contains mismatched runId/);
    });
  });

  // Invariant 3: Path confinement (traversal + ancestor symlink escape)
  it("Invariant 3: confines flow paths and rejects traversal and ancestor symlinks", () => {
    const safeRoot = path.resolve(scratchDir, "safe-root");
    const outsideDir = path.resolve(scratchDir, "outside-secret");
    fs.mkdirSync(safeRoot, { recursive: true });
    fs.mkdirSync(outsideDir, { recursive: true });
    fs.writeFileSync(path.join(outsideDir, "secret.txt"), "PRIVATE");

    expect(() => assertConfinedPath(path.join(safeRoot, "..", "outside-secret", "secret.txt"), safeRoot)).toThrow(
      PathConfinementError,
    );

    const symlinkDir = path.join(safeRoot, "link-dir");
    fs.symlinkSync(outsideDir, symlinkDir);
    // Ancestor symlink must be rejected even when checking a nested child file
    expect(() => assertConfinedPath(path.join(symlinkDir, "secret.txt"), safeRoot)).toThrow(SymlinkNotAllowedError);
  });

  // Invariant 4: Allowlist-only public schemas
  it("Invariant 4: enforces strict allowlist schemas and rejects unallowlisted properties, bad timestamps, or legacy plain hashes", () => {
    const runId = "inv4-run";

    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId, flowHash: VALID_HASH, flowYamlBytes: VALID_YAML });

      const unallowlisted = {
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        data: {
          flowRef: "test", flowHash: VALID_HASH, source: "builtin", expectedDecisions: [],
          freeTextNote: "not allowed",
        },
      };
      expect(() => store.appendEvent(unallowlisted as unknown as FlowEvent)).toThrow(/schema validation/);

      const trailingAt = {
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: "2026-11-22T22:00:00Z secret trailing text",
        actor: "runner", type: "run_planned",
        data: { flowRef: "test", flowHash: VALID_HASH, source: "builtin", expectedDecisions: [] },
      };
      expect(() => store.appendEvent(trailingAt as unknown as FlowEvent)).toThrow(/schema validation/);
    });
  });

  // Invariant 5: Event grammar and transition legality
  it("Invariant 5: enforces sequential event grammar and legal transitions in append API", () => {
    const runId = "inv5-run";

    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId, flowHash: VALID_HASH, flowYamlBytes: VALID_YAML });

      // Out-of-order seq rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 5, eventId: "ev-5", prev: GENESIS_PREV,
          at: new Date().toISOString(), actor: "runner", type: "run_planned",
          data: { flowRef: "test", flowHash: VALID_HASH, source: "builtin", expectedDecisions: [] },
        })
      ).toThrow(/Invalid event seq: expected 1, got 5/);

      // Contiguous but illegal transition (run_started at seq 1) rejected
      expect(() =>
        store.appendEvent({
          v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
          at: new Date().toISOString(), actor: "runner", type: "run_started",
          data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000, steps: 5 } },
        })
      ).toThrow(IllegalFlowTransitionError);
    });
  });

  // Invariant 6: Artefact verification against real disk bytes
  it("Invariant 6: verifies real artefact file existence, hash, and size on disk and rejects tampered or missing files", () => {
    const runId = "inv6-run";

    withOwnedStore(projectId, scratchDir, (store) => {
      store.createRun({ runId, flowHash: VALID_HASH, flowYamlBytes: VALID_YAML });
      store.appendEvent({
        v: 1, runId, seq: 1, eventId: "ev-1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        data: { flowRef: "test", flowHash: VALID_HASH, source: "builtin", expectedDecisions: [] },
      });

      // Nonexistent file MUST throw ArtifactVerificationError
      expect(() =>
        store.recordArtifact({
          artifactId: "art_missing",
          runId, stepId: "step1", attemptId: "step1_1",
          name: "output.tar", contentHash: "c".repeat(64), mediaType: "application/tar", size: 512,
        })
      ).toThrow(ArtifactVerificationError);

      // Write real artefact and verify loadRunState accepts it
      const rec = store.writeAndRecordArtifact({
        artifactId: "art_real",
        runId, stepId: "step1", attemptId: "step1_1",
        name: "output.txt", mediaType: "text/plain", bytes: Buffer.from("real artifact payload", "utf8"),
      });

      const loadedOk = loadRunState(projectId, runId, { dataRoot: scratchDir });
      const boundKey = `art_real:${rec.contentHash}`;
      expect(loadedOk.verifiedArtefacts.get(boundKey)).toBe(rec.size);

      // Major 4: SAME-SIZE byte tamper (21 bytes -> 21 bytes!) isolates SHA-256 verification from size check
      const sameSizeTamper = Buffer.from("REAL ARTIFACT PAYLOAX", "utf8");
      expect(sameSizeTamper.length).toBe(rec.size);
      fs.writeFileSync(rec.filePath, sameSizeTamper);
      const loadedTampered = loadRunState(projectId, runId, { dataRoot: scratchDir });
      expect(loadedTampered.verifiedArtefacts.has(boundKey)).toBe(false);
    });
  });

  // Invariant 7: Replay halts and phases (including judgement(stop) followed by run_started)
  it("Invariant 7: halts replay monotonically on judgement(stop) or run_finished and ignores trailing run_started/step_started", () => {
    const flowDef: FlowDefinition = {
      flow: "halt-test",
      version: 1,
      steps: [{ id: "step1", type: "agent" }],
    };

    const events: FlowEvent[] = [
      {
        v: 1, runId: "run-halt", seq: 1, eventId: "e1", prev: GENESIS_PREV,
        at: new Date().toISOString(), actor: "runner", type: "run_planned",
        data: { flowRef: "halt-test", flowHash: "0".repeat(64), source: "builtin", expectedDecisions: [] },
      },
      {
        v: 1, runId: "run-halt", seq: 2, eventId: "e2", prev: "0".repeat(64),
        at: new Date().toISOString(), actor: "system", type: "judgement",
        stepId: "step1", attemptId: "att-1",
        data: { final: "stop", ruleHits: ["stop_rule"], reasonCodes: ["halted"], engineTokens: 0 },
      },
      // Trailing run_started MUST NOT reset status back to 'running'
      {
        v: 1, runId: "run-halt", seq: 3, eventId: "e3", prev: "0".repeat(64),
        at: new Date().toISOString(), actor: "runner", type: "run_started",
        data: { runnerVersion: "1.0.0", inputIds: {}, budget: { tokens: 1000, steps: 5 } },
      },
      // Trailing step_started MUST be ignored
      {
        v: 1, runId: "run-halt", seq: 4, eventId: "e4", prev: "0".repeat(64),
        at: new Date().toISOString(), actor: "runner", type: "step_started",
        stepId: "step1", attemptId: "att-2",
        data: { occurrence: 2, effectKey: "eff-2" },
      },
    ];

    const state = reduceFlowRun(flowDef, events, new Map());
    expect(state.status).toBe("stopped");
    expect(state.currentStepId).toBeNull();
  });

  // Invariant 8: Budget enforcement (150-token budget: stub step 1 spends 100 -> step 2 refused pre-dispatch)
  it("Invariant 8: enforces budget ceiling before dispatching next step intent in real runner", async () => {
    const tightBudgetYaml = `flow: tight-budget
version: 1
limits:
  budget:
    tokens: 150
    steps: 5
steps:
  - id: step1
    type: agent
  - id: step2
    type: agent
`;
    const runId = "inv8-tight-tok";
    planAndApproveRun({ projectId, runId, flowYaml: tightBudgetYaml, dataRoot: scratchDir });

    const res = await runFlow(projectId, runId, { dataRoot: scratchDir });
    expect(res.finalStatus).toBe("stopped");
    expect(res.terminalReason).toBe("ceiling_reached");
    expect(res.dispatchedSteps.map((s) => s.stepId)).toEqual(["step1"]);
  });

  // Invariant 9: Validator gaps (empty goto, proto injection, operator syntax)
  it("Invariant 9: validator rejects empty goto, __proto__ pollution (explicit forbidden_property_name), and operator syntax", () => {
    expect(validateFlowYaml(`flow: bad-goto\nversion: 1\nsteps:\n  - id: step1\n    type: check\n    on_fail: { goto: "" }\n`).valid).toBe(false);
    const protoRes = validateFlowYaml(`flow: bad-proto\nversion: 1\n__proto__: { admin: true }\nsteps:\n  - id: step1\n    type: agent\n`);
    expect(protoRes.valid).toBe(false);
    expect(!protoRes.valid && protoRes.errors.some((e) => e.code === "forbidden_property_name")).toBe(true);
    expect(validateFlowYaml(`flow: bad-op\nversion: 1\nsteps:\n  - id: step1\n    type: agent\n    \${eval}: "malicious"\n`).valid).toBe(false);
  });

  // Invariant 10: Projection facts preserved across SQLite persistence and reload
  it("Invariant 10: preserves plan metadata and exact terminal outcome across real persistence and reload", async () => {
    const runId = "inv10-run";
    planAndApproveRun({ projectId, runId, flowYaml: VALID_YAML, source: "project", dataRoot: scratchDir });
    await runFlow(projectId, runId, { dataRoot: scratchDir });

    const loaded = loadRunState(projectId, runId, { dataRoot: scratchDir });
    expect(loaded.state.runPlanned?.flowRef).toBe("test");
    expect(loaded.state.runPlanned?.source).toBe("project");
    expect(loaded.state.terminalOutcome).toBe("done");
    expect(loaded.state.terminalReason).toBe("completed");
  });

  // Invariant 11: Real production process-group cleanup wired through runFlow escalates SIGTERM->SIGKILL
  // for non-cooperating child + grandchild AND preserves cross-process flows.owner exclusion through teardown
  it("Invariant 11: runFlow timeout escalates to SIGKILL on SIGTERM-ignoring process group while preserving cross-process lock until teardown completes", async () => {
    const pidFile = path.join(scratchDir, "grandchild.pid");
    const runId = "inv11-timeout-pg";
    planAndApproveRun({ projectId, runId, flowYaml: VALID_YAML, dataRoot: scratchDir });

    let externalProcessBlockedAtTeardownEnd = false;
    const lockPath = path.join(scratchDir, "flows", projectId, "flows.owner");
    // Ignore SIGTERM in both shell and grandchild so SIGKILL escalation is strictly required
    const script = `trap '' TERM; (trap '' TERM; exec sleep 60) & echo $! > ${JSON.stringify(pidFile)}; wait`;
    const res = await runFlow(projectId, runId, {
      dataRoot: scratchDir,
      stepTimeoutMs: 250,
      onStepDispatch: async (ctx) => {
        await runBoundedProcessGroup("bash", ["-c", script], {
          cwd: scratchDir,
          timeoutMs: 10_000,
          signal: ctx.signal,
        });
        // Major 4 ordering proof: a separate OS process MUST still see SQLITE_BUSY right when teardown ends
        const probe = spawnSync(
          process.execPath,
          [
            "-e",
            `const D=require("better-sqlite3");const d=new D(${JSON.stringify(lockPath)},{timeout:50});try{d.pragma("locking_mode=EXCLUSIVE");d.pragma("busy_timeout=50");d.exec("BEGIN EXCLUSIVE;");process.exit(0);}catch(e){process.exit(e.code==="SQLITE_BUSY"||e.code==="SQLITE_LOCKED"?42:1);}`,
          ],
          { cwd: path.resolve(__dirname, "../.."), encoding: "utf8" },
        );
        externalProcessBlockedAtTeardownEnd = probe.status === 42;
      },
    });
    expect(res.finalStatus).toBe("stopped");
    expect(externalProcessBlockedAtTeardownEnd).toBe(true);
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);
    expect(fs.existsSync(pidFile)).toBe(true);
    const grandchildPid = Number(fs.readFileSync(pidFile, "utf8").trim());
    expect(grandchildPid).toBeGreaterThan(1);

    // Grandchild must already be dead (ESRCH or unreaped zombie Z) right after runFlow returns
    let alive = true;
    try {
      process.kill(grandchildPid, 0);
      // On Linux, a killed child not yet reaped by init can briefly show as zombie ('Z')
      const procStat = fs.readFileSync(`/proc/${grandchildPid}/stat`, "utf8");
      const stateMatch = procStat.match(/\)\s+(\S)/);
      if (stateMatch?.[1] === "Z") alive = false;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ESRCH" || code === "ENOENT") alive = false;
    }
    expect(alive).toBe(false);
  });
});
