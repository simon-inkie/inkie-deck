import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";
import { loadRunState } from "../../app/lib/flows/load-run.server.js";
import { acquireOwnerLock } from "../../app/lib/flows/owner.server.js";
import { readFlowCardStream } from "../../app/lib/flows/reader.server.js";
import {
  planAndApproveRun,
  runFlow,
  submitHandoffReturn,
  type CrashPoint,
} from "../../app/lib/flows/runner.server.js";
import { openFlowsStore } from "../../app/lib/flows/store.server.js";
import { __resetInboxCaches, FileInboxRepository } from "../../app/lib/inbox.server.js";

const CHECK_REWIND_YAML = `
flow: check-rewind-demo
version: 1
limits:
  max_attempts: 3
  max_rewinds: 6
  same_check_fail_limit: 3
  budget:
    tokens: 2000
    steps: 20
steps:
  - id: build
    type: agent
    role: builder
    outputs: [draft]
  - id: verify
    type: check
    against: draft
    run: [check_nonempty]
    on_fail:
      goto: build
`;

const DECISION_FLOW_YAML = `
flow: decision-gate-demo
version: 1
limits:
  max_attempts: 4
  max_rewinds: 6
  budget:
    tokens: 5000
    steps: 25
on_unanswered:
  after_hours: 1
  outcome: stop
steps:
  - id: build
    type: agent
    role: builder
    outputs: [draft]
  - id: review_gate
    type: decision
    always: decide
    title: "Approve build or request rework?"
    options:
      - key: ship
        label: "Ship now"
        end: done
      - key: rework
        label: "Rework draft"
        goto: build
      - key: halt
        label: "Halt run"
        end: stopped
      - key: drop
        label: "Drop run"
        end: dropped
`;

const HANDOFF_REWIND_YAML = `
flow: handoff-rewind-demo
version: 1
limits:
  budget:
    tokens: 5000
    steps: 25
steps:
  - id: build
    type: agent
    role: builder
    outputs: [draft]
  - id: verify
    type: check
    against: draft
    run: [check_nonempty]
  - id: peer_review
    type: handoff
    to: reviewer-agent
    returns:
      verdict: [approved, changes]
    on_return:
      changes:
        goto: build
  - id: final_check
    type: check
    against: draft
    run: [check_nonempty]
`;

const BUDGET_NOTIFY_YAML = `
flow: budget-notify-demo
version: 1
limits:
  budget:
    tokens: 120
    steps: 10
steps:
  - id: draft
    type: agent
    role: builder
    outputs: [draft]
`;

function getActiveHandoffId(projectId: string, runId: string, dataRoot: string): string | null {
  return loadRunState(projectId, runId, { dataRoot }).state.activeHandoff?.handoffId ?? null;
}

function parseBlockMeta(rawMeta: string): Record<string, unknown> {
  if (!rawMeta.trim()) return {};
  const parsed: unknown = YAML.parse(rawMeta);
  return parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
}

describe("Deck Flows Slice 2 - Handoffs, Rewinds, Limits, Inbox Bridge & Crash Recovery", () => {
  let dataRoot = "";
  let inboxRoot = "";
  let prevInboxEnv: string | undefined;
  const projectId = "proj-slice-2";
  const agentName = "flow-bot";
  const participantName = "operator";

  beforeEach(() => {
    prevInboxEnv = process.env["INBOX_ROOT"];
    dataRoot = fs.mkdtempSync("/var/tmp/deck-flows-s2-data-");
    inboxRoot = fs.mkdtempSync("/var/tmp/deck-flows-s2-inbox-");
    fs.mkdirSync(path.join(inboxRoot, agentName, "inbox"), { recursive: true });
    process.env["INBOX_ROOT"] = inboxRoot;
    __resetInboxCaches();
  });

  afterEach(() => {
    __resetInboxCaches();
    if (prevInboxEnv === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = prevInboxEnv;
    }
    if (dataRoot && fs.existsSync(dataRoot)) {
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
    if (inboxRoot && fs.existsSync(inboxRoot)) {
      fs.rmSync(inboxRoot, { recursive: true, force: true });
    }
  });

  it("runs decision card roundtrip through real FileInboxRepository, answerCard, goto rewind, and end outcomes", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const runId = "run-decision-goto-done";
    planAndApproveRun({ projectId, runId, flowYaml: DECISION_FLOW_YAML, dataRoot });

    // 1. Run until decision pauses
    const paused1 = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(paused1.finalStatus).toBe("waiting_decision");
    const firstHandoffId = getActiveHandoffId(projectId, runId, dataRoot);
    expect(firstHandoffId).toBeTruthy();

    // Verify waitingOn reflects active handoff target cleanly
    const view1 = readFlowCardStream(projectId, runId, { dataRoot });
    expect(view1).not.toBeNull();
    expect(view1!.waitingOn).toBe("operator");

    // Verify real markdown decision block exists in FileInboxRepository
    const blocks1 = await repo.readBlocks(agentName, participantName);
    const decisionBlocks1 = blocks1.filter((b) => Boolean(b.card));
    expect(decisionBlocks1).toHaveLength(1);
    const meta1 = parseBlockMeta(decisionBlocks1[0]!.rawMeta);
    expect(meta1["flow-run-id"]).toBe(runId);
    expect(meta1["flow-step-id"]).toBe("review_gate");
    expect(meta1["flow-always-decide"]).toBe(true);

    // 2. Answer "rework" via real FileInboxRepository.answerCard (which invokes applyAnswer)
    await repo.answerCard(agentName, participantName, firstHandoffId!, "rework");

    // 3. Resume: rewinds to build, runs build attempt 2, re-enters review_gate & pauses again
    const paused2 = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(paused2.finalStatus).toBe("waiting_decision");
    const secondHandoffId = getActiveHandoffId(projectId, runId, dataRoot);
    expect(secondHandoffId).toBeTruthy();
    expect(secondHandoffId).not.toBe(firstHandoffId);

    const mid = loadRunState(projectId, runId, { dataRoot });
    expect(mid.state.rewindsUsed).toBe(1);
    expect(mid.events.filter((e) => e.type === "step_rewound")).toHaveLength(1);
    expect(mid.events.filter((e) => e.type === "handoff_returned")).toHaveLength(1);

    // 4. Answer "ship" via real FileInboxRepository.answerCard -> finishes cleanly done
    await repo.answerCard(agentName, participantName, secondHandoffId!, "ship");
    const finished = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(finished.finalStatus).toBe("finished");
    expect(finished.terminalOutcome).toBe("done");

    const finalState = loadRunState(projectId, runId, { dataRoot });
    expect(finalState.state.status).toBe("finished");
    expect(finalState.state.terminalOutcome).toBe("done");
    expect(finalState.state.activeHandoff).toBeNull();
  }, 15_000);

  it("handles dismissDecisionCard and customAnswerCard without leaking private notes into projection or card stream", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };

    // A. Custom answer carrying a sensitive operator note (non-looping rejection + retry card unlock)
    const customRunId = "run-custom-privacy";
    planAndApproveRun({ projectId, runId: customRunId, flowYaml: DECISION_FLOW_YAML, dataRoot });
    const pausedCustom = await runFlow(projectId, customRunId, { dataRoot, inbox });
    expect(pausedCustom.finalStatus).toBe("waiting_decision");
    const customHandoffId = getActiveHandoffId(projectId, customRunId, dataRoot)!;
    const customSecret = "SECRET_CUSTOM_NOTE_DO_NOT_LEAK_123";
    await repo.customAnswerCard(agentName, participantName, customHandoffId, customSecret);
    const customAfter = await runFlow(projectId, customRunId, { dataRoot, inbox });
    expect(customAfter.finalStatus).toBe("waiting_decision");
    // Polling again must NOT emit duplicate return_rejected events or duplicate cards
    const customPoll = await runFlow(projectId, customRunId, { dataRoot, inbox });
    expect(customPoll.finalStatus).toBe("waiting_decision");
    const customLoaded = loadRunState(projectId, customRunId, { dataRoot });
    expect(customLoaded.events.filter((e) => e.type === "return_rejected")).toHaveLength(1);
    const customStreamJson = JSON.stringify(readFlowCardStream(projectId, customRunId, { dataRoot }));
    expect(customStreamJson).not.toContain(customSecret);
    // Operator can still answer the re-emitted retry card cleanly without deadlock
    await repo.answerCard(agentName, participantName, `${customHandoffId}_r1`, "ship");
    const customDone = await runFlow(projectId, customRunId, { dataRoot, inbox });
    expect(customDone.finalStatus).toBe("finished");
    expect(customDone.terminalOutcome).toBe("done");

    // A2. pushBackCard also emits return_rejected once, unlocks via fresh retry card, and settles
    const pushRunId = "run-pushback-recovery";
    planAndApproveRun({ projectId, runId: pushRunId, flowYaml: DECISION_FLOW_YAML, dataRoot });
    const pausedPush = await runFlow(projectId, pushRunId, { dataRoot, inbox });
    expect(pausedPush.finalStatus).toBe("waiting_decision");
    const pushHandoffId = getActiveHandoffId(projectId, pushRunId, dataRoot)!;
    await repo.pushBackCard(agentName, participantName, pushHandoffId, "needs more detail");
    const pushAfter1 = await runFlow(projectId, pushRunId, { dataRoot, inbox });
    expect(pushAfter1.finalStatus).toBe("waiting_decision");
    const pushAfter2 = await runFlow(projectId, pushRunId, { dataRoot, inbox });
    expect(pushAfter2.finalStatus).toBe("waiting_decision");
    const pushRejections = loadRunState(projectId, pushRunId, { dataRoot }).events.filter(
      (e) => e.type === "return_rejected",
    );
    expect(pushRejections).toHaveLength(1);
    expect(pushRejections[0]!.type === "return_rejected" && pushRejections[0]!.data.attemptedChoiceKey).toBe(
      "pushback",
    );
    await repo.answerCard(agentName, participantName, `${pushHandoffId}_r1`, "ship");
    const pushDone = await runFlow(projectId, pushRunId, { dataRoot, inbox });
    expect(pushDone.finalStatus).toBe("finished");
    expect(pushDone.terminalOutcome).toBe("done");

    // B. Dismissed decision carrying a sensitive reason
    const dismissRunId = "run-dismiss-privacy";
    planAndApproveRun({ projectId, runId: dismissRunId, flowYaml: DECISION_FLOW_YAML, dataRoot });
    const pausedDismiss = await runFlow(projectId, dismissRunId, { dataRoot, inbox });
    expect(pausedDismiss.finalStatus).toBe("waiting_decision");
    const dismissHandoffId = getActiveHandoffId(projectId, dismissRunId, dataRoot)!;
    const dismissSecret = "SECRET_DISMISS_REASON_DO_NOT_LEAK_456";
    await repo.dismissDecisionCard(
      agentName,
      participantName,
      dismissHandoffId,
      dismissSecret,
    );

    const dismissedRes = await runFlow(projectId, dismissRunId, { dataRoot, inbox });
    expect(dismissedRes.finalStatus).toBe("stopped");
    expect(dismissedRes.terminalOutcome).toBe("stopped");
    expect(dismissedRes.terminalReason).toBe("decision_dismissed");

    // C. Verify private note in submitHandoffReturn also stays strictly out of public projection
    const noteRunId = "run-submit-note-privacy";
    planAndApproveRun({ projectId, runId: noteRunId, flowYaml: DECISION_FLOW_YAML, dataRoot });
    const pausedNote = await runFlow(projectId, noteRunId, { dataRoot, inbox });
    expect(pausedNote.finalStatus).toBe("waiting_decision");
    const noteHandoffId = getActiveHandoffId(projectId, noteRunId, dataRoot)!;
    const operatorSecret = "SECRET_OPERATOR_NOTE_XYZ_789";
    const submitRes = submitHandoffReturn({
      projectId,
      runId: noteRunId,
      handoffId: noteHandoffId,
      choiceKey: "halt",
      actor: "human",
      actorId: "operator-1",
      note: operatorSecret,
      dataRoot,
    });
    expect(submitRes).toEqual({ accepted: true });

    const noteFinished = await runFlow(projectId, noteRunId, { dataRoot, inbox });
    expect(noteFinished.finalStatus).toBe("stopped");
    expect(noteFinished.terminalOutcome).toBe("stopped");

    const lock = acquireOwnerLock(projectId, dataRoot);
    try {
      const store = openFlowsStore(projectId, { dataRoot, ownerLock: lock });
      try {
        const customLines = store.exportProjectionLines(customRunId).join("\n");
        const dismissLines = store.exportProjectionLines(dismissRunId).join("\n");
        const noteLines = store.exportProjectionLines(noteRunId).join("\n");
        expect(customLines).not.toContain(customSecret);
        expect(dismissLines).not.toContain(dismissSecret);
        expect(noteLines).not.toContain(operatorSecret);

        const noteEvents = store.getParsedEvents(noteRunId);
        const returnedEv = noteEvents.find((e) => e.type === "handoff_returned");
        expect(returnedEv?.privateRef).toBeTruthy();
        expect(store.getPrivateDetail(noteRunId, returnedEv!.privateRef!)).toBe(operatorSecret);
      } finally {
        store.close();
      }
    } finally {
      lock.release();
    }

    const streamJson = JSON.stringify(readFlowCardStream(projectId, noteRunId, { dataRoot }));
    expect(streamJson).not.toContain(operatorSecret);
  }, 15_000);

  it("supports end: dropped option cleanly", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const runId = "run-decision-dropped";
    planAndApproveRun({ projectId, runId, flowYaml: DECISION_FLOW_YAML, dataRoot });

    const paused = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(paused.finalStatus).toBe("waiting_decision");
    const handoffId = getActiveHandoffId(projectId, runId, dataRoot)!;
    await repo.answerCard(agentName, participantName, handoffId, "drop");

    const finished = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(finished.finalStatus).toBe("stopped");
    expect(finished.terminalOutcome).toBe("dropped");
    expect(finished.terminalReason).toBe("operator_dropped");
  }, 15_000);

  it("recovers crash-safely across K_AFTER_HANDOFF_SENT, K_AFTER_INBOX_CARD_WRITTEN, K_AFTER_HANDOFF_RETURNED, and K_AFTER_REWIND", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const runId = "run-crash-recovery";
    planAndApproveRun({ projectId, runId, flowYaml: DECISION_FLOW_YAML, dataRoot });

    const crashAt = (target: CrashPoint) => (point: CrashPoint) => {
      if (point === target) {
        throw new Error(`SIMULATED_CRASH_${point}`);
      }
    };

    // Crash 1: K_AFTER_HANDOFF_SENT
    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        inbox,
        onCrashPoint: crashAt("K_AFTER_HANDOFF_SENT"),
      }),
    ).rejects.toThrow("SIMULATED_CRASH_K_AFTER_HANDOFF_SENT");

    // Resume into K_AFTER_INBOX_CARD_WRITTEN -> card emitted once
    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        inbox,
        onCrashPoint: crashAt("K_AFTER_INBOX_CARD_WRITTEN"),
      }),
    ).rejects.toThrow("SIMULATED_CRASH_K_AFTER_INBOX_CARD_WRITTEN");

    // Resume again with no crash -> still paused with EXACTLY 1 decision card & 1 handoff_sent
    const paused = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(paused.finalStatus).toBe("waiting_decision");
    const firstHandoffId = getActiveHandoffId(projectId, runId, dataRoot)!;
    const blocksAfterResume = await repo.readBlocks(agentName, participantName);
    const matchingCards = blocksAfterResume.filter(
      (b) => b.card?.decisionId === firstHandoffId,
    );
    expect(matchingCards).toHaveLength(1);

    // Answer rework -> crash right after committing handoff_returned (K_AFTER_HANDOFF_RETURNED)
    await repo.answerCard(agentName, participantName, firstHandoffId, "rework");
    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        inbox,
        onCrashPoint: crashAt("K_AFTER_HANDOFF_RETURNED"),
      }),
    ).rejects.toThrow("SIMULATED_CRASH_K_AFTER_HANDOFF_RETURNED");

    // Verify handoff_returned committed once BEFORE crash
    const afterReturnCrash = loadRunState(projectId, runId, { dataRoot });
    expect(afterReturnCrash.events.filter((e) => e.type === "handoff_returned")).toHaveLength(1);

    // Resume into K_AFTER_REWIND -> adopts returned decision ONCE, rewinds to build, then crashes at K_AFTER_REWIND
    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        inbox,
        onCrashPoint: crashAt("K_AFTER_REWIND"),
      }),
    ).rejects.toThrow("SIMULATED_CRASH_K_AFTER_REWIND");

    // Still ONLY ONE handoff_returned and ONE step_rewound!
    const afterRewindCrash = loadRunState(projectId, runId, { dataRoot });
    expect(afterRewindCrash.events.filter((e) => e.type === "handoff_returned")).toHaveLength(1);
    expect(afterRewindCrash.events.filter((e) => e.type === "step_rewound")).toHaveLength(1);

    // Finish cleanly after answering ship on second occurrence
    const paused2 = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(paused2.finalStatus).toBe("waiting_decision");
    const secondHandoffId = getActiveHandoffId(projectId, runId, dataRoot)!;
    await repo.answerCard(agentName, participantName, secondHandoffId, "ship");
    const done = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(done.finalStatus).toBe("finished");
    expect(done.terminalOutcome).toBe("done");
    expect(loadRunState(projectId, runId, { dataRoot }).events.filter((e) => e.type === "step_rewound")).toHaveLength(1);
  }, 15_000);

  it("enforces submitHandoffReturn rejections: unknown_handoff, invalid_option, human_required, duplicate_return, late_return", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const runId = "run-rejections";
    planAndApproveRun({ projectId, runId, flowYaml: DECISION_FLOW_YAML, dataRoot });

    const paused = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(paused.finalStatus).toBe("waiting_decision");
    const handoffId = getActiveHandoffId(projectId, runId, dataRoot)!;

    // 1. Unknown handoffId
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId: "hnd_00000000000000000000",
        choiceKey: "ship",
        actor: "human",
        actorId: "operator",
        dataRoot,
      }),
    ).toEqual({ accepted: false, rejectReason: "unknown_handoff" });

    // 2. Invalid option key
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "nonexistent_option",
        actor: "human",
        actorId: "operator",
        dataRoot,
      }),
    ).toEqual({ accepted: false, rejectReason: "invalid_option" });

    // 3. Agent attempting to answer an always: decide gate
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "ship",
        actor: "agent",
        actorId: "worker-bot",
        dataRoot,
      }),
    ).toEqual({ accepted: false, rejectReason: "human_required" });

    // 4. Valid human return accepted
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "ship",
        actor: "human",
        actorId: "operator-1",
        dataRoot,
      }),
    ).toEqual({ accepted: true });

    // 5. Duplicate return before runner settles the returned handoff
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "halt",
        actor: "human",
        actorId: "operator-1",
        dataRoot,
      }),
    ).toEqual({ accepted: false, rejectReason: "duplicate_return" });

    const mid = loadRunState(projectId, runId, { dataRoot });
    const rejections = mid.events.filter((e) => e.type === "return_rejected");
    expect(rejections.map((r) => r.type === "return_rejected" && r.data.rejectReason)).toEqual([
      "unknown_handoff",
      "invalid_option",
      "human_required",
      "duplicate_return",
    ]);

    // Finish run, then late return is rejected cleanly without mutating finished chain
    const done = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(done.finalStatus).toBe("finished");
    expect(done.terminalOutcome).toBe("done");

    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "ship",
        actor: "human",
        actorId: "operator-1",
        dataRoot,
      }),
    ).toEqual({ accepted: false, rejectReason: "late_return" });
  }, 15_000);

  it("applies on_unanswered expiry safe-default stop when clock passes expiresAt", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const runId = "run-expiry-stop";
    planAndApproveRun({ projectId, runId, flowYaml: DECISION_FLOW_YAML, dataRoot });

    const t0 = new Date("2026-11-24T12:00:00.000Z");
    const paused = await runFlow(projectId, runId, {
      dataRoot,
      inbox,
      now: () => t0,
    });
    expect(paused.finalStatus).toBe("waiting_decision");
    const expiredHandoffId = getActiveHandoffId(projectId, runId, dataRoot)!;
    expect(expiredHandoffId).toBeTruthy();

    const tBeforeExpiry = new Date("2026-11-24T12:30:00.000Z");
    const stillPaused = await runFlow(projectId, runId, {
      dataRoot,
      inbox,
      now: () => tBeforeExpiry,
    });
    expect(stillPaused.finalStatus).toBe("waiting_decision");

    const tAfterExpiry = new Date("2026-11-24T14:00:00.000Z");
    const expired = await runFlow(projectId, runId, {
      dataRoot,
      inbox,
      now: () => tAfterExpiry,
    });
    expect(expired.finalStatus).toBe("stopped");
    expect(expired.terminalOutcome).toBe("stopped");
    expect(expired.terminalReason).toBe("unanswered_expired");

    const loaded = loadRunState(projectId, runId, { dataRoot });
    const returned = loaded.events.find((e) => e.type === "handoff_returned");
    expect(returned?.type === "handoff_returned" && returned.data.resolution).toBe("expired");

    // D3: Expired inbox decision card is marked superseded and no longer answerable
    const blocksAfterExpiry = await repo.readBlocks(agentName, participantName);
    const expiredCard = blocksAfterExpiry.find((b) => b.card?.decisionId === expiredHandoffId)?.card;
    expect(expiredCard?.superseded).toBeTruthy();
    const lateAnswer = await repo.answerCard(agentName, participantName, expiredHandoffId, "ship");
    expect(lateAnswer).toMatchObject({ alreadySuperseded: true });
  }, 15_000);

  it("handles handoff on_return goto rewind, invalidates downstream checks, and re-verifies on new artefact SHA", async () => {
    const runId = "run-handoff-rewind-check-invalidation";
    planAndApproveRun({ projectId, runId, flowYaml: HANDOFF_REWIND_YAML, dataRoot });

    const buildAttempts: number[] = [];
    const paused1 = await runFlow(projectId, runId, {
      dataRoot,
      getStubAgentBytes: ({ step, occurrence }) => {
        buildAttempts.push(occurrence);
        return Buffer.from(`${step.id}-v${occurrence}\n`, "utf8");
      },
    });
    expect(paused1.finalStatus).toBe("waiting_decision");
    const firstHandoff = getActiveHandoffId(projectId, runId, dataRoot)!;
    expect(firstHandoff).toBeTruthy();
    const handoffView = readFlowCardStream(projectId, runId, { dataRoot });
    expect(handoffView?.waitingOn).toBe("reviewer-agent");

    // Peer review requests changes -> triggers step_rewound to build
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId: firstHandoff,
        choiceKey: "changes",
        actor: "agent",
        actorId: "reviewer-agent",
        dataRoot,
      }),
    ).toEqual({ accepted: true });

    const paused2 = await runFlow(projectId, runId, {
      dataRoot,
      getStubAgentBytes: ({ step, occurrence }) => {
        buildAttempts.push(occurrence);
        return Buffer.from(`${step.id}-v${occurrence}\n`, "utf8");
      },
    });
    expect(paused2.finalStatus).toBe("waiting_decision");
    const secondHandoff = getActiveHandoffId(projectId, runId, dataRoot)!;
    expect(secondHandoff).toBeTruthy();
    expect(secondHandoff).not.toBe(firstHandoff);

    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId: secondHandoff,
        choiceKey: "approved",
        actor: "agent",
        actorId: "reviewer-agent",
        dataRoot,
      }),
    ).toEqual({ accepted: true });

    const done = await runFlow(projectId, runId, { dataRoot });
    expect(done.finalStatus).toBe("finished");
    expect(done.terminalOutcome).toBe("done");

    const loaded = loadRunState(projectId, runId, { dataRoot });
    expect(buildAttempts).toEqual([1, 2]);
    // Check `verify` ran BOTH before rewind and after rewind on new SHA
    const verifyChecks = loaded.events.filter(
      (e) => e.type === "check_result" && e.stepId === "verify",
    );
    expect(verifyChecks).toHaveLength(2);
    expect(verifyChecks[0]!.type === "check_result" && verifyChecks[0]!.data.targetSha).not.toBe(
      verifyChecks[1]!.type === "check_result" && verifyChecks[1]!.data.targetSha,
    );
    // Downstream `final_check` ran against attempt 2 SHA
    const finalCheck = loaded.events.find(
      (e) => e.type === "check_result" && e.stepId === "final_check",
    );
    expect(finalCheck?.type === "check_result" && finalCheck.data.targetSha).toBe(
      verifyChecks[1]!.type === "check_result" && verifyChecks[1]!.data.targetSha,
    );
  }, 15_000);

  it("rewinds check on_fail when artefact is empty on attempt 1, then escalates to decide at max_attempts / same_check_repeat", async () => {
    // Part A: fails attempt 1 (0 bytes), rewinds to build, passes attempt 2 (non-empty) -> done
    const passOnRetryRun = "run-check-rewind-pass";
    planAndApproveRun({ projectId, runId: passOnRetryRun, flowYaml: CHECK_REWIND_YAML, dataRoot });
    const doneRes = await runFlow(projectId, passOnRetryRun, {
      dataRoot,
      getStubAgentBytes: ({ occurrence }) =>
        occurrence === 1 ? Buffer.alloc(0) : Buffer.from("valid content\n", "utf8"),
    });
    expect(doneRes.finalStatus).toBe("finished");
    expect(doneRes.terminalOutcome).toBe("done");
    const retryState = loadRunState(projectId, passOnRetryRun, { dataRoot });
    expect(retryState.state.rewindsUsed).toBe(1);

    // Part B: persistently 0-byte output hits same_check_fail_limit (3) -> escalates to decide!
    const escalateRun = "run-check-rewind-escalate";
    planAndApproveRun({ projectId, runId: escalateRun, flowYaml: CHECK_REWIND_YAML, dataRoot });
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };

    const decided = await runFlow(projectId, escalateRun, {
      dataRoot,
      inbox,
      getStubAgentBytes: () => Buffer.alloc(0),
    });
    expect(decided.finalStatus).toBe("waiting_decision");
    const loaded = loadRunState(projectId, escalateRun, { dataRoot });
    expect(loaded.state.rewindsUsed).toBe(2);
    const lastJudgement = [...loaded.events].reverse().find((e) => e.type === "judgement");
    expect(lastJudgement?.type === "judgement" && lastJudgement.data.final).toBe("decide");
    expect(lastJudgement?.type === "judgement" && lastJudgement.data.reasonCodes).toContain(
      "same_check_repeat",
    );
  }, 15_000);

  it("emits idempotent ActionSchema notify card on budget >= 80% without blocking done, and stops on >100% ceiling", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };

    // 100 tokens used out of 120 budget = 83.3% (>= 80% notify)
    const notifyRunId = "run-budget-notify";
    planAndApproveRun({ projectId, runId: notifyRunId, flowYaml: BUDGET_NOTIFY_YAML, dataRoot });
    const notifyDone = await runFlow(projectId, notifyRunId, { dataRoot, inbox });
    expect(notifyDone.finalStatus).toBe("finished");
    expect(notifyDone.terminalOutcome).toBe("done");

    const blocks = await repo.readBlocks(agentName, participantName);
    const actionCards = blocks.filter(
      (b) => Boolean(b.actionCard) && parseBlockMeta(b.rawMeta)["flow-run-id"] === notifyRunId,
    );
    expect(actionCards).toHaveLength(1);
    expect(parseBlockMeta(actionCards[0]!.rawMeta)["flow-reason-code"]).toBe("budget_near");

    // > 100% budget stops run with ceiling_reached
    const tightYaml = `
flow: tight-budget
version: 1
limits:
  budget:
    tokens: 50
    steps: 5
steps:
  - id: draft
    type: agent
    role: builder
    outputs: [draft]
`;
    const stopRunId = "run-budget-exceeded";
    planAndApproveRun({ projectId, runId: stopRunId, flowYaml: tightYaml, dataRoot });
    const stopped = await runFlow(projectId, stopRunId, { dataRoot, inbox });
    expect(stopped.finalStatus).toBe("stopped");
    expect(stopped.terminalOutcome).toBe("stopped");
    expect(stopped.terminalReason).toBe("ceiling_reached");
  }, 15_000);

  it("R1-1: preserves check provenance across judgement(decide) -> handoff_returned(continue) -> run_finished(done)", async () => {
    const yaml = `
flow: check-decide-continue
version: 1
steps:
  - id: build
    type: agent
    role: builder
    outputs: [draft]
  - id: verify
    type: check
    against: draft
    run: [check_nonempty]
`;
    const runId = "run-r1-1-check-provenance";
    planAndApproveRun({ projectId, runId, flowYaml: yaml, dataRoot });

    const paused = await runFlow(projectId, runId, {
      dataRoot,
      evaluateSignals: ({ step }) => (step.id === "verify" ? { hasHumanCriteria: true } : {}),
    });
    expect(paused.finalStatus).toBe("waiting_decision");
    const handoffId = getActiveHandoffId(projectId, runId, dataRoot)!;
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "continue",
        actor: "human",
        actorId: "operator-1",
        dataRoot,
      }),
    ).toEqual({ accepted: true });

    const done = await runFlow(projectId, runId, { dataRoot });
    expect(done.finalStatus).toBe("finished");
    expect(done.terminalOutcome).toBe("done");
    expect(done.terminalReason).toBe("completed");
  }, 15_000);

  it("R1-3: isStepCompletedForCursor preserves earlier decide completion across unrelated later rewinds", async () => {
    const yaml = `
flow: earlier-decide-later-rewind
version: 1
limits:
  max_attempts: 4
  max_rewinds: 4
steps:
  - id: step1
    type: agent
    role: builder
    outputs: [plan]
  - id: step2
    type: agent
    role: builder
    outputs: [code]
  - id: step3
    type: check
    against: step2.code
    run: [check_nonempty]
    on_fail:
      goto: step2
`;
    const runId = "run-r1-3-cursor-scan";
    planAndApproveRun({ projectId, runId, flowYaml: yaml, dataRoot });

    const paused = await runFlow(projectId, runId, {
      dataRoot,
      evaluateSignals: ({ step, occurrence }) =>
        step.id === "step1" && occurrence === 1 ? { agentQuestion: true } : {},
    });
    expect(paused.finalStatus).toBe("waiting_decision");
    const handoffId = getActiveHandoffId(projectId, runId, dataRoot)!;
    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "continue",
        actor: "human",
        actorId: "operator-1",
        dataRoot,
      }),
    ).toEqual({ accepted: true });

    let step2Occ2Seen = false;
    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        getStubAgentBytes: ({ step, occurrence }) => {
          if (step.id === "step2" && occurrence === 1) return Buffer.alloc(0);
          return Buffer.from(`${step.id}-v${occurrence}\n`, "utf8");
        },
        onStepDispatch: ({ stepId, occurrence }) => {
          if (stepId === "step2" && occurrence === 2) step2Occ2Seen = true;
        },
        onCrashPoint: (point) => {
          if (point === "K9_AFTER_JUDGEMENT" && step2Occ2Seen) {
            throw new Error("SIMULATED_CRASH_AFTER_STEP2_OCC2");
          }
        },
      }),
    ).rejects.toThrow("SIMULATED_CRASH_AFTER_STEP2_OCC2");

    const resumed = await runFlow(projectId, runId, { dataRoot });
    expect(resumed.finalStatus).toBe("finished");
    expect(resumed.terminalOutcome).toBe("done");
    expect(resumed.dispatchedSteps.map((s) => s.stepId)).toEqual(["step3"]);
    const loaded = loadRunState(projectId, runId, { dataRoot });
    expect(loaded.state.stepStates["step1"]?.occurrence).toBe(1);
    expect(loaded.state.stepStates["step2"]?.occurrence).toBe(2);
  }, 15_000);

  it("R1-4: staleSha escalates to decide when max_attempts / max_rewinds are exhausted without throwing IllegalFlowTransitionError", async () => {
    const yaml = `
flow: stale-sha-limit
version: 1
limits:
  max_attempts: 2
  max_rewinds: 2
steps:
  - id: build
    type: agent
    role: builder
    outputs: [draft]
  - id: verify
    type: check
    against: draft
    run: [check_nonempty]
`;
    const runId = "run-r1-4-stale-sha-limit";
    planAndApproveRun({ projectId, runId, flowYaml: yaml, dataRoot });

    const paused = await runFlow(projectId, runId, {
      dataRoot,
      evaluateSignals: ({ step }) => (step.id === "verify" ? { staleSha: true } : {}),
    });
    expect(paused.finalStatus).toBe("waiting_decision");
    const mid = loadRunState(projectId, runId, { dataRoot });
    expect(mid.state.rewindsUsed).toBe(1);
    const handoffId = mid.state.activeHandoff!.handoffId;

    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "continue",
        actor: "human",
        actorId: "operator-1",
        dataRoot,
      }),
    ).toEqual({ accepted: true });

    const done = await runFlow(projectId, runId, { dataRoot });
    expect(done.finalStatus).toBe("finished");
    expect(done.terminalOutcome).toBe("done");
  }, 15_000);

  it("R1-5: always: decide rejects non-human dismissed/expired and cannot pass via on_unanswered: continue", async () => {
    const yaml = `
flow: always-decide-guard
version: 1
on_unanswered:
  after_hours: 1
  outcome: continue
steps:
  - id: gate
    type: decision
    always: decide
    title: "Human approval required"
    options:
      - key: approve
        label: "Approve"
        end: done
      - key: stop
        label: "Stop"
        end: stopped
`;
    const runId = "run-r1-5-always-decide-actor";
    planAndApproveRun({ projectId, runId, flowYaml: yaml, dataRoot });

    const t0 = new Date("2026-11-24T12:00:00.000Z");
    const paused = await runFlow(projectId, runId, { dataRoot, now: () => t0 });
    expect(paused.finalStatus).toBe("waiting_decision");
    const handoffId = getActiveHandoffId(projectId, runId, dataRoot)!;

    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "dismissed",
        resolution: "dismissed",
        actor: "agent",
        actorId: "worker-bot",
        dataRoot,
      }),
    ).toEqual({ accepted: false, rejectReason: "human_required" });

    expect(
      submitHandoffReturn({
        projectId,
        runId,
        handoffId,
        choiceKey: "expired",
        resolution: "expired",
        actor: "agent",
        actorId: "worker-bot",
        dataRoot,
      }),
    ).toEqual({ accepted: false, rejectReason: "human_required" });

    // Direct store append with actor: "agent" must also be rejected by TRANSITION_TABLE
    const lock = acquireOwnerLock(projectId, dataRoot);
    try {
      const store = openFlowsStore(projectId, { dataRoot, ownerLock: lock });
      try {
        const events = store.getEvents(runId);
        const tail = events[events.length - 1]!;
        const sent = JSON.parse(tail.line) as { stepId: string; attemptId: string };
        expect(() =>
          store.appendEvent({
            v: 1,
            runId,
            seq: tail.seq + 1,
            eventId: "ev_bad_dismiss",
            prev: tail.hash,
            at: t0.toISOString(),
            actor: "agent",
            type: "handoff_returned",
            stepId: sent.stepId,
            attemptId: sent.attemptId,
            data: {
              handoffId,
              choiceKey: "dismissed",
              resolution: "dismissed",
              actorId: "worker-bot",
            },
          }),
        ).toThrow(/requires actor 'human'/);
        expect(() =>
          store.appendEvent({
            v: 1,
            runId,
            seq: tail.seq + 1,
            eventId: "ev_bad_expire",
            prev: tail.hash,
            at: t0.toISOString(),
            actor: "agent",
            type: "handoff_returned",
            stepId: sent.stepId,
            attemptId: sent.attemptId,
            data: {
              handoffId,
              choiceKey: "expired",
              resolution: "expired",
              actorId: "worker-bot",
            },
          }),
        ).toThrow(/forbids actor 'agent'/);
      } finally {
        store.close();
      }
    } finally {
      lock.release();
    }

    // Expiry on always: decide with on_unanswered: continue MUST NOT bypass gate; defaults to stop
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const tAfter = new Date("2026-11-24T14:00:00.000Z");
    const expired = await runFlow(projectId, runId, { dataRoot, inbox, now: () => tAfter });
    expect(expired.finalStatus).toBe("stopped");
    expect(expired.terminalOutcome).toBe("stopped");
    expect(expired.terminalReason).toBe("unanswered_expired");
  }, 15_000);

  it("R1-6: settled decision 'retry' never falls through to Case B, and Case B on_unanswered: continue advances cleanly", async () => {
    // Part (a): Settled decision option keyed 'retry' + later step crash recovers step2 without rewinding step1
    const retryOptionYaml = `
flow: settled-retry-decision
version: 1
steps:
  - id: gate
    type: decision
    title: "Choose action"
    options:
      - key: retry
        label: "Proceed anyway"
  - id: follow
    type: agent
    role: builder
    outputs: [done_out]
`;
    const runA = "run-r1-6a-settled-retry";
    planAndApproveRun({ projectId, runId: runA, flowYaml: retryOptionYaml, dataRoot });
    const pausedA = await runFlow(projectId, runA, { dataRoot });
    expect(pausedA.finalStatus).toBe("waiting_decision");
    const gateHandoff = getActiveHandoffId(projectId, runA, dataRoot)!;
    expect(
      submitHandoffReturn({
        projectId,
        runId: runA,
        handoffId: gateHandoff,
        choiceKey: "retry",
        actor: "human",
        actorId: "operator-1",
        dataRoot,
      }),
    ).toEqual({ accepted: true });

    await expect(
      runFlow(projectId, runA, {
        dataRoot,
        onCrashPoint: (p) => {
          if (p === "K1_AFTER_INTENT") throw new Error("SIMULATED_K1_FOLLOW");
        },
      }),
    ).rejects.toThrow("SIMULATED_K1_FOLLOW");

    const recoveredA = await runFlow(projectId, runA, { dataRoot });
    expect(recoveredA.finalStatus).toBe("stopped");
    expect(recoveredA.terminalReason).toBe("unrecoverable_failure");
    const loadedA = loadRunState(projectId, runA, { dataRoot });
    expect(loadedA.events.filter((e) => e.type === "step_rewound")).toHaveLength(0);
    expect(loadedA.events.some((e) => e.type === "step_outcome_unknown" && e.stepId === "follow")).toBe(true);

    // Part (b): Case B escalation expiry with on_unanswered: continue advances passed step to step2
    const caseBYaml = `
flow: case-b-expire-continue
version: 1
on_unanswered:
  after_hours: 1
  outcome: continue
steps:
  - id: step1
    type: agent
    role: builder
    outputs: [draft]
  - id: step2
    type: agent
    role: builder
    outputs: [final]
`;
    const runB = "run-r1-6b-case-b-expire";
    planAndApproveRun({ projectId, runId: runB, flowYaml: caseBYaml, dataRoot });
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const t0 = new Date("2026-11-24T12:00:00.000Z");

    const pausedB = await runFlow(projectId, runB, {
      dataRoot,
      inbox,
      now: () => t0,
      evaluateSignals: ({ step, occurrence }) =>
        step.id === "step1" && occurrence === 1 ? { hasHumanCriteria: true } : {},
    });
    expect(pausedB.finalStatus).toBe("waiting_decision");

    const tAfter = new Date("2026-11-24T14:00:00.000Z");
    const finishedB = await runFlow(projectId, runB, {
      dataRoot,
      inbox,
      now: () => tAfter,
    });
    expect(finishedB.finalStatus).toBe("finished");
    expect(finishedB.terminalOutcome).toBe("done");
    expect(finishedB.dispatchedSteps.map((s) => s.stepId)).toEqual(["step2"]);
    const loadedB = loadRunState(projectId, runB, { dataRoot });
    expect(loadedB.state.stepStates["step1"]?.occurrence).toBe(1);
    expect(loadedB.state.stepStates["step2"]?.occurrence).toBe(1);
  }, 15_000);

  it("D2: K4 crash recovery re-evaluates evaluateStepJudgement so budget_near: decide enters waiting_decision", async () => {
    const k4BudgetDecideYaml = `
flow: k4-budget-near-decide
version: 1
limits:
  budget:
    tokens: 120
    steps: 10
steps:
  - id: draft
    type: agent
    role: builder
    outputs: [draft]
    rules:
      - budget_near: decide
  - id: publish
    type: agent
    role: builder
    outputs: [published]
`;
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const runId = "run-d2-k4-budget-decide";
    planAndApproveRun({ projectId, runId, flowYaml: k4BudgetDecideYaml, dataRoot });

    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        inbox,
        onCrashPoint: (point) => {
          if (point === "K4_AFTER_OUTCOME") {
            throw new Error("SIMULATED_K4_BUDGET_DECIDE");
          }
        },
      }),
    ).rejects.toThrow("SIMULATED_K4_BUDGET_DECIDE");

    const preRecovery = loadRunState(projectId, runId, { dataRoot });
    expect(preRecovery.events.some((e) => e.type === "step_result" && e.stepId === "draft")).toBe(true);
    expect(preRecovery.events.some((e) => e.type === "judgement" && e.stepId === "draft")).toBe(false);

    const recovered = await runFlow(projectId, runId, { dataRoot, inbox });
    expect(recovered.finalStatus).toBe("waiting_decision");
    expect(recovered.dispatchedSteps).toEqual([]);

    const mid = loadRunState(projectId, runId, { dataRoot });
    const draftJudgement = mid.events.find((e) => e.type === "judgement" && e.stepId === "draft");
    expect(draftJudgement?.type === "judgement" && draftJudgement.data.final).toBe("decide");
    expect(draftJudgement?.type === "judgement" && draftJudgement.data.ruleHits).toContain("budget_near");
    const sent = mid.events.find((e) => e.type === "handoff_sent" && e.stepId === "draft");
    expect(sent?.type === "handoff_sent" && sent.data.reasonCode).toBe("budget_near");
    expect(mid.events.some((e) => e.type === "step_started" && e.stepId === "publish")).toBe(false);
    expect(mid.state.activeHandoff?.handoffId).toBeTruthy();

    const blocks = await repo.readBlocks(agentName, participantName);
    expect(blocks.some((b) => b.card?.decisionId === mid.state.activeHandoff!.handoffId)).toBe(true);
  }, 15_000);

  it("D3: expiry crash at K_AFTER_HANDOFF_RETURNED supersedes inbox card on 3b recovery without misclassifying as dismissed", async () => {
    const repo = new FileInboxRepository(inboxRoot);
    const inbox = { inboxRoot, agentName, participantName, repo };
    const runId = "run-d3-expiry-crash-supersede";
    planAndApproveRun({ projectId, runId, flowYaml: DECISION_FLOW_YAML, dataRoot });

    const t0 = new Date("2026-11-24T12:00:00.000Z");
    const paused = await runFlow(projectId, runId, {
      dataRoot,
      inbox,
      now: () => t0,
    });
    expect(paused.finalStatus).toBe("waiting_decision");
    const handoffId = getActiveHandoffId(projectId, runId, dataRoot)!;

    const tAfterExpiry = new Date("2026-11-24T14:00:00.000Z");
    await expect(
      runFlow(projectId, runId, {
        dataRoot,
        inbox,
        now: () => tAfterExpiry,
        onCrashPoint: (point) => {
          if (point === "K_AFTER_HANDOFF_RETURNED") {
            throw new Error("SIMULATED_CRASH_AFTER_EXPIRED_RETURN");
          }
        },
      }),
    ).rejects.toThrow("SIMULATED_CRASH_AFTER_EXPIRED_RETURN");

    // Before recovery, handoff_returned(expired) is durable while inbox card is still open
    const mid = loadRunState(projectId, runId, { dataRoot });
    const returnedMid = mid.events.find((e) => e.type === "handoff_returned");
    expect(returnedMid?.type === "handoff_returned" && returnedMid.data.resolution).toBe("expired");
    const blocksBeforeRecovery = await repo.readBlocks(agentName, participantName);
    const openCard = blocksBeforeRecovery.find((b) => b.card?.decisionId === handoffId)?.card;
    expect(openCard?.superseded).toBeUndefined();

    // Recovery runs 3b follow-up, supersedes the card idempotently, and stops as unanswered_expired
    const recovered = await runFlow(projectId, runId, {
      dataRoot,
      inbox,
      now: () => tAfterExpiry,
    });
    expect(recovered.finalStatus).toBe("stopped");
    expect(recovered.terminalOutcome).toBe("stopped");
    expect(recovered.terminalReason).toBe("unanswered_expired");

    const blocksAfterRecovery = await repo.readBlocks(agentName, participantName);
    const closedCard = blocksAfterRecovery.find((b) => b.card?.decisionId === handoffId)?.card;
    expect(closedCard?.superseded).toBeTruthy();

    const lateAnswer = await repo.answerCard(agentName, participantName, handoffId, "ship");
    expect(lateAnswer).toMatchObject({ alreadySuperseded: true });
  }, 15_000);

  it("D4: direct (no-inbox) handoff expires cleanly when options.now passes expiresAt", async () => {
    const runId = "run-d4-direct-expiry";
    planAndApproveRun({ projectId, runId, flowYaml: DECISION_FLOW_YAML, dataRoot });

    const t0 = new Date("2026-11-24T12:00:00.000Z");
    const paused = await runFlow(projectId, runId, {
      dataRoot,
      now: () => t0,
    });
    expect(paused.finalStatus).toBe("waiting_decision");
    const handoffId = getActiveHandoffId(projectId, runId, dataRoot)!;
    expect(handoffId).toBeTruthy();

    const tBeforeExpiry = new Date("2026-11-24T12:45:00.000Z");
    const stillPaused = await runFlow(projectId, runId, {
      dataRoot,
      now: () => tBeforeExpiry,
    });
    expect(stillPaused.finalStatus).toBe("waiting_decision");

    const tAfterExpiry = new Date("2026-11-24T14:00:00.000Z");
    const expired = await runFlow(projectId, runId, {
      dataRoot,
      now: () => tAfterExpiry,
    });
    expect(expired.finalStatus).toBe("stopped");
    expect(expired.terminalOutcome).toBe("stopped");
    expect(expired.terminalReason).toBe("unanswered_expired");

    const loaded = loadRunState(projectId, runId, { dataRoot });
    const returned = loaded.events.find((e) => e.type === "handoff_returned");
    expect(returned?.type === "handoff_returned").toBe(true);
    if (returned?.type === "handoff_returned") {
      expect(returned.actor).toBe("system");
      expect(returned.data).toEqual({
        handoffId,
        choiceKey: "unanswered_expired",
        resolution: "expired",
        actorId: "system",
      });
    }
  }, 15_000);
});
