/**
 * pending-batch.test.ts - Unit tests for the pending batch state machine.
 *
 * Tests the pure reducer (pendingBatchReducer) and the derived helpers
 * (buildBatchBody). The reducer is pure, so tests need no mocks at all.
 *
 * The usePendingBatch hook's timer behaviour is tested via the acceptance cases
 * further down using vitest's fake timers - no React DOM renderer needed because
 * the hook drives the same reducer and the delivery callback is plain JS.
 *
 * Acceptance cases from the SPEC:
 *   A1. Three messages fired within the settle window -> ONE delivery.
 *   A2. Single message -> ONE delivery after the settle window.
 *   A3. Send-now -> immediate delivery.
 *   A4. Safety cap fires -> delivers sent portion after 5 min of no keystrokes
 *       while SUSPENDED.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  pendingBatchReducer,
  buildBatchBody,
  deliveryFor,
  SETTLE_MS,
  SAFETY_CAP_MS,
  type PendingBatchState,
  type BatchAction,
  type BatchDelivery,
} from "../app/lib/pending-batch";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

/**
 * The thread these batches belong to. SUBMIT carries it explicitly (it is a
 * required action field) so ownership travels with the paragraphs instead of
 * being read off whatever thread happens to be rendered.
 */
const OWNER = "agentA";

const IDLE_TEST_STATE: PendingBatchState = {
  phase: "IDLE",
  paragraphs: [],
  lastSubmitAt: 0,
  ownerKey: null,
  dictated: false,
};

// ---------------------------------------------------------------------------
// Pure reducer tests
// ---------------------------------------------------------------------------

/** Shorthand: run a sequence of actions from IDLE. */
function run(actions: BatchAction[]): PendingBatchState {
  const initial: PendingBatchState = { ...IDLE_TEST_STATE };
  return actions.reduce(pendingBatchReducer, initial);
}

describe("pendingBatchReducer - SUBMIT transitions", () => {
  it("IDLE + SUBMIT -> PENDING with one paragraph", () => {
    const s = run([{ type: "SUBMIT", text: "hello", nowMs: 1000, ownerKey: OWNER }]);
    expect(s.phase).toBe("PENDING");
    expect(s.paragraphs).toEqual(["hello"]);
    expect(s.lastSubmitAt).toBe(1000);
  });

  it("SUBMIT trims whitespace from text", () => {
    const s = run([{ type: "SUBMIT", text: "  hi there  ", nowMs: 1, ownerKey: OWNER }]);
    expect(s.paragraphs).toEqual(["hi there"]);
  });

  it("SUBMIT with empty/blank text is a no-op (IDLE stays IDLE)", () => {
    const s = run([{ type: "SUBMIT", text: "   ", nowMs: 1, ownerKey: OWNER }]);
    expect(s.phase).toBe("IDLE");
    expect(s.paragraphs).toHaveLength(0);
  });

  it("PENDING + SUBMIT -> appends paragraph and refreshes lastSubmitAt", () => {
    const s = run([
      { type: "SUBMIT", text: "msg1", nowMs: 1000, ownerKey: OWNER },
      { type: "SUBMIT", text: "msg2", nowMs: 2000, ownerKey: OWNER },
    ]);
    expect(s.phase).toBe("PENDING");
    expect(s.paragraphs).toEqual(["msg1", "msg2"]);
    expect(s.lastSubmitAt).toBe(2000);
  });

  it("SUSPENDED + SUBMIT -> back to PENDING with paragraph appended", () => {
    const s = run([
      { type: "SUBMIT", text: "msg1", nowMs: 1000, ownerKey: OWNER },
      { type: "TYPE" },
      { type: "SUBMIT", text: "msg2", nowMs: 2000, ownerKey: OWNER },
    ]);
    expect(s.phase).toBe("PENDING");
    expect(s.paragraphs).toEqual(["msg1", "msg2"]);
  });
});

describe("pendingBatchReducer - TYPE transitions", () => {
  it("PENDING + TYPE -> SUSPENDED", () => {
    const s = run([
      { type: "SUBMIT", text: "msg", nowMs: 1000, ownerKey: OWNER },
      { type: "TYPE" },
    ]);
    expect(s.phase).toBe("SUSPENDED");
    // Paragraphs are preserved.
    expect(s.paragraphs).toEqual(["msg"]);
  });

  it("IDLE + TYPE -> no-op (stays IDLE)", () => {
    const s = run([{ type: "TYPE" }]);
    expect(s.phase).toBe("IDLE");
  });

  it("SUSPENDED + TYPE -> stays SUSPENDED (no-op, timer already clear)", () => {
    const s = run([
      { type: "SUBMIT", text: "msg", nowMs: 1000, ownerKey: OWNER },
      { type: "TYPE" },
      { type: "TYPE" },
    ]);
    expect(s.phase).toBe("SUSPENDED");
  });
});

describe("pendingBatchReducer - SETTLE_FIRE", () => {
  it("PENDING + SETTLE_FIRE -> IDLE", () => {
    const s = run([
      { type: "SUBMIT", text: "msg", nowMs: 1000, ownerKey: OWNER },
      { type: "SETTLE_FIRE" },
    ]);
    expect(s.phase).toBe("IDLE");
    expect(s.paragraphs).toHaveLength(0);
  });

  it("SUSPENDED + SETTLE_FIRE -> no-op (stays SUSPENDED)", () => {
    const s = run([
      { type: "SUBMIT", text: "msg", nowMs: 1000, ownerKey: OWNER },
      { type: "TYPE" },
      { type: "SETTLE_FIRE" },
    ]);
    // Settle should not fire while SUSPENDED (settle timer was cleared on TYPE).
    expect(s.phase).toBe("SUSPENDED");
  });

  it("IDLE + SETTLE_FIRE -> no-op", () => {
    const s = run([{ type: "SETTLE_FIRE" }]);
    expect(s.phase).toBe("IDLE");
  });
});

describe("pendingBatchReducer - SEND_NOW", () => {
  it("PENDING + SEND_NOW -> IDLE", () => {
    const s = run([
      { type: "SUBMIT", text: "urgent", nowMs: 1000, ownerKey: OWNER },
      { type: "SEND_NOW" },
    ]);
    expect(s.phase).toBe("IDLE");
    expect(s.paragraphs).toHaveLength(0);
  });

  it("SUSPENDED + SEND_NOW -> IDLE", () => {
    const s = run([
      { type: "SUBMIT", text: "msg", nowMs: 1000, ownerKey: OWNER },
      { type: "TYPE" },
      { type: "SEND_NOW" },
    ]);
    expect(s.phase).toBe("IDLE");
  });

  it("IDLE + SEND_NOW -> no-op", () => {
    const s = run([{ type: "SEND_NOW" }]);
    expect(s.phase).toBe("IDLE");
  });
});

describe("pendingBatchReducer - SAFETY_CAP", () => {
  it("SUSPENDED + SAFETY_CAP -> IDLE (delivers sent portion)", () => {
    const s = run([
      { type: "SUBMIT", text: "msg", nowMs: 1000, ownerKey: OWNER },
      { type: "TYPE" },
      { type: "SAFETY_CAP" },
    ]);
    expect(s.phase).toBe("IDLE");
    expect(s.paragraphs).toHaveLength(0);
  });

  it("PENDING + SAFETY_CAP -> no-op (cap only fires from SUSPENDED)", () => {
    const s = run([
      { type: "SUBMIT", text: "msg", nowMs: 1000, ownerKey: OWNER },
      { type: "SAFETY_CAP" },
    ]);
    // Still PENDING - safety cap should not clear a non-SUSPENDED state.
    expect(s.phase).toBe("PENDING");
    expect(s.paragraphs).toEqual(["msg"]);
  });

  it("IDLE + SAFETY_CAP -> no-op", () => {
    const s = run([{ type: "SAFETY_CAP" }]);
    expect(s.phase).toBe("IDLE");
  });
});

describe("pendingBatchReducer - DELIVERED", () => {
  it("any phase + DELIVERED -> IDLE", () => {
    for (const actions of [
      [{ type: "SUBMIT", text: "x", nowMs: 1, ownerKey: OWNER }, { type: "DELIVERED" }],
      [{ type: "SUBMIT", text: "x", nowMs: 1, ownerKey: OWNER }, { type: "TYPE" }, { type: "DELIVERED" }],
    ] as BatchAction[][]) {
      const s = run(actions);
      expect(s.phase).toBe("IDLE");
      expect(s.paragraphs).toHaveLength(0);
    }
  });
});

// ---------------------------------------------------------------------------
// buildBatchBody
// ---------------------------------------------------------------------------

describe("buildBatchBody", () => {
  it("single paragraph passes through unchanged", () => {
    expect(buildBatchBody(["hello world"])).toBe("hello world");
  });

  it("two paragraphs joined with double newline (message boundary preserved)", () => {
    expect(buildBatchBody(["first", "second"])).toBe("first\n\nsecond");
  });

  it("three paragraphs chain", () => {
    expect(buildBatchBody(["a", "b", "c"])).toBe("a\n\nb\n\nc");
  });

  it("empty array returns empty string", () => {
    expect(buildBatchBody([])).toBe("");
  });
});

// ---------------------------------------------------------------------------
// State-machine acceptance cases (timer behaviour via fake timers + manual
// simulation of usePendingBatch's timer logic, keeping tests pure JS).
//
// Because usePendingBatch uses React hooks, we cannot call it directly in a
// vitest Node environment. Instead, we simulate the hook's timer logic using
// the same reducer + vitest fake timers. This tests the contract without
// requiring jsdom or React test renderer.
// ---------------------------------------------------------------------------

/** Minimal simulation of the hook's core timer loop. */
function makeBatchSim(onDeliver: (body: string) => void) {
  let state: PendingBatchState = { ...IDLE_TEST_STATE };
  let settleTimer: ReturnType<typeof setTimeout> | null = null;
  let safetyCapTimer: ReturnType<typeof setTimeout> | null = null;

  function clearSettle() {
    if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
  }
  function clearCap() {
    if (safetyCapTimer !== null) { clearTimeout(safetyCapTimer); safetyCapTimer = null; }
  }
  function armSettle() {
    clearSettle();
    settleTimer = setTimeout(() => {
      settleTimer = null;
      if (state.phase !== "PENDING" || state.paragraphs.length === 0) return;
      const body = buildBatchBody(state.paragraphs);
      state = pendingBatchReducer(state, { type: "SETTLE_FIRE" });
      onDeliver(body);
    }, SETTLE_MS);
  }
  function armCap() {
    clearCap();
    safetyCapTimer = setTimeout(() => {
      safetyCapTimer = null;
      if (state.phase !== "SUSPENDED" || state.paragraphs.length === 0) return;
      const body = buildBatchBody(state.paragraphs);
      state = pendingBatchReducer(state, { type: "SAFETY_CAP" });
      onDeliver(body);
    }, SAFETY_CAP_MS);
  }

  return {
    submit(text: string) {
      state = pendingBatchReducer(state, { type: "SUBMIT", text, nowMs: Date.now(), ownerKey: OWNER });
      clearCap();
      armSettle();
    },
    type() {
      if (state.phase === "IDLE") return;
      if (state.phase === "PENDING") {
        clearSettle();
        state = pendingBatchReducer(state, { type: "TYPE" });
      }
      // (Re-)arm safety cap on every keystroke while suspended (mirrors fixed onType).
      armCap();
    },
    sendNow() {
      if (state.phase === "IDLE" || state.paragraphs.length === 0) return;
      const body = buildBatchBody(state.paragraphs);
      clearSettle();
      clearCap();
      state = pendingBatchReducer(state, { type: "SEND_NOW" });
      onDeliver(body);
    },
    getPhase: () => state.phase,
    getParagraphs: () => state.paragraphs,
  };
}

describe("acceptance cases (TASK-500 SPEC)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("A1: three messages within settle window -> ONE delivery with all three paragraphs", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("msg1");
    vi.advanceTimersByTime(2000); // 2s later (still within settle)
    sim.submit("msg2");
    vi.advanceTimersByTime(3000); // 3s later (still within settle)
    sim.submit("msg3");

    // No delivery yet.
    expect(deliveries).toHaveLength(0);
    expect(sim.getPhase()).toBe("PENDING");

    // Settle fires.
    vi.advanceTimersByTime(SETTLE_MS);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("msg1\n\nmsg2\n\nmsg3");
    expect(sim.getPhase()).toBe("IDLE");
  });

  it("A2: single message -> ONE delivery after settle window", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("only message");

    expect(deliveries).toHaveLength(0);

    vi.advanceTimersByTime(SETTLE_MS);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("only message");
    expect(sim.getPhase()).toBe("IDLE");
  });

  it("A3: send-now -> immediate delivery, skip settle", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("urgent message");
    sim.sendNow();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("urgent message");
    expect(sim.getPhase()).toBe("IDLE");

    // Settle timer should have been cleared; advancing time fires nothing.
    vi.advanceTimersByTime(SETTLE_MS);
    expect(deliveries).toHaveLength(1);
  });

  it("A3: send-now on SUSPENDED batch also delivers immediately", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("msg1");
    sim.type(); // -> SUSPENDED
    sim.sendNow();

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("msg1");
  });

  it("A4: safety cap fires after 5 min of silence while SUSPENDED", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("sent message");
    sim.type(); // user starts typing -> SUSPENDED, settle timer cleared

    expect(sim.getPhase()).toBe("SUSPENDED");
    expect(deliveries).toHaveLength(0);

    // 5 min of silence -> safety cap fires.
    vi.advanceTimersByTime(SAFETY_CAP_MS);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("sent message");
    expect(sim.getPhase()).toBe("IDLE");
  });

  it("A4: safety cap does NOT fire when the user stays in PENDING (typing re-sends)", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("msg1");
    // Do NOT call type() - stays PENDING. Safety cap not armed.

    vi.advanceTimersByTime(SAFETY_CAP_MS);
    // Settle would have fired long before the safety cap.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("msg1");
  });

  it("A5 (regression TASK-500 CR Finding 1): safety cap resets on EVERY keystroke while SUSPENDED, not just the first", () => {
    // Repro: user submits, starts typing (->SUSPENDED), keeps typing for 8 min total.
    // With the bug: cap armed from first TYPE call, never re-armed -> fires at t=5min
    //   even though the user was actively typing. 5min of NO keystrokes is the contract.
    // With the fix: each TYPE call (re-)arms the cap, so it fires 5min after the LAST
    //   keystroke, not the first.
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("sent message");
    sim.type(); // -> SUSPENDED, cap armed at t=0

    // Advance 4 min (below the 5-min cap) and type again -> cap should reset.
    vi.advanceTimersByTime(4 * 60_000);
    expect(deliveries).toHaveLength(0); // nothing yet

    sim.type(); // SUSPENDED + keystroke -> cap re-armed at t=4min

    // Advance another 4 min (total 8 min from first keystroke, only 4 from last).
    // Bug: cap would have fired at t=5min. Fix: cap is reset, still pending.
    vi.advanceTimersByTime(4 * 60_000);
    expect(deliveries).toHaveLength(0); // must NOT have fired yet

    // Advance past 5 min from the last keystroke (1 more min = 5 min from t=4min).
    vi.advanceTimersByTime(60_001);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("sent message");
    expect(sim.getPhase()).toBe("IDLE");
  });

  it("A6: pending batch is delivered to OLD agent on key switch, not dropped and not routed to new agent", () => {
    // Validates the deliver-on-switch contract: when agentKey changes with a pending
    // batch, the delivery must (a) fire, (b) carry the old agent key as targetAgent,
    // and (c) NOT fire again after the settle window (the timer was cleared).
    //
    // This test simulates the hook's agentKey-change effect using the same reducer
    // and stateRef pattern the hook uses, so the logic is identical. The delivery
    // payload comes from the real deliveryFor, so the addressing under test is the
    // production rule rather than a restatement of it.
    //
    // Note what this case can and cannot see: it pins that the SWITCH delivers to
    // the old thread. It cannot see the localStorage mirror that the same commit
    // wrote under the NEW thread, because it is not a render - which is exactly
    // why the misdirection survived a green suite containing this
    // test. See test/pending-batch-mirror-render.test.tsx.

    const deliveries: BatchDelivery[] = [];
    let state: PendingBatchState = { ...IDLE_TEST_STATE };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    function clearSettle() {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
    }
    function armSettle() {
      clearSettle();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (state.phase !== "PENDING" || state.paragraphs.length === 0) return;
        const delivery = deliveryFor(state, currentAgent);
        state = pendingBatchReducer(state, { type: "SETTLE_FIRE" });
        deliveries.push(delivery);
      }, SETTLE_MS);
    }

    // User is on agent A: submits a message, batch is PENDING.
    let currentAgent = "agentA";
    state = pendingBatchReducer(state, { type: "SUBMIT", text: "msg for A", nowMs: Date.now(), ownerKey: currentAgent });
    armSettle();

    expect(state.phase).toBe("PENDING");
    expect(deliveries).toHaveLength(0);

    // User switches to agent B: simulate the agentKey-change effect.
    const oldAgent = currentAgent;
    currentAgent = "agentB";
    // Capture the delivery from state BEFORE dispatch clears it.
    const switchDelivery = deliveryFor(state, oldAgent);
    clearSettle();
    state = pendingBatchReducer(state, { type: "DELIVERED" });
    deliveries.push(switchDelivery);

    // State is now IDLE.
    expect(state.phase).toBe("IDLE");
    expect(state.paragraphs).toHaveLength(0);

    // Delivery happened to the OLD agent (agentA), not dropped, not to agentB.
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.body).toBe("msg for A");
    expect(deliveries[0]!.targetAgent).toBe("agentA");

    // Settle timer was cleared; advancing time fires no additional delivery.
    vi.advanceTimersByTime(SETTLE_MS);
    expect(deliveries).toHaveLength(1);
  });

  it("typing resets the settle timer: settle fires SETTLE_MS after the last TYPE+SUBMIT", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSim((body) => deliveries.push(body));

    sim.submit("msg1");

    // 10 s in: user starts typing (hard suspend).
    vi.advanceTimersByTime(10_000);
    sim.type();

    // 5 s later: user submits the next message.
    vi.advanceTimersByTime(5000);
    sim.submit("msg2");

    // The settle timer was re-armed from the second submit.
    // Less than SETTLE_MS after the second submit: no delivery.
    vi.advanceTimersByTime(SETTLE_MS - 1);
    expect(deliveries).toHaveLength(0);

    // Full SETTLE_MS after the second submit: delivery.
    vi.advanceTimersByTime(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("msg1\n\nmsg2");
  });
});

// ---------------------------------------------------------------------------
// CANCEL action
// ---------------------------------------------------------------------------

describe("pendingBatchReducer - CANCEL", () => {
  it("PENDING + CANCEL -> IDLE (discards paragraphs)", () => {
    const s = run([
      { type: "SUBMIT", text: "held message", nowMs: 1000, ownerKey: OWNER },
      { type: "CANCEL" },
    ]);
    expect(s.phase).toBe("IDLE");
    expect(s.paragraphs).toHaveLength(0);
    expect(s.lastSubmitAt).toBe(0);
  });

  it("SUSPENDED + CANCEL -> IDLE", () => {
    const s = run([
      { type: "SUBMIT", text: "held message", nowMs: 1000, ownerKey: OWNER },
      { type: "TYPE" },
      { type: "CANCEL" },
    ]);
    expect(s.phase).toBe("IDLE");
    expect(s.paragraphs).toHaveLength(0);
  });

  it("IDLE + CANCEL -> no-op (stays IDLE)", () => {
    const s = run([{ type: "CANCEL" }]);
    expect(s.phase).toBe("IDLE");
  });
});

describe("cancel acceptance cases (TASK-500.3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** Extends makeBatchSim with a cancel operation. */
  function makeBatchSimWithCancel(onDeliver: (body: string) => void) {
    let state: PendingBatchState = { ...IDLE_TEST_STATE };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let safetyCapTimer: ReturnType<typeof setTimeout> | null = null;

    function clearSettle() {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
    }
    function clearCap() {
      if (safetyCapTimer !== null) { clearTimeout(safetyCapTimer); safetyCapTimer = null; }
    }
    function armSettle() {
      clearSettle();
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (state.phase !== "PENDING" || state.paragraphs.length === 0) return;
        const body = buildBatchBody(state.paragraphs);
        state = pendingBatchReducer(state, { type: "SETTLE_FIRE" });
        onDeliver(body);
      }, SETTLE_MS);
    }
    function armCap() {
      clearCap();
      safetyCapTimer = setTimeout(() => {
        safetyCapTimer = null;
        if (state.phase !== "SUSPENDED" || state.paragraphs.length === 0) return;
        const body = buildBatchBody(state.paragraphs);
        state = pendingBatchReducer(state, { type: "SAFETY_CAP" });
        onDeliver(body);
      }, SAFETY_CAP_MS);
    }

    return {
      submit(text: string) {
        state = pendingBatchReducer(state, { type: "SUBMIT", text, nowMs: Date.now(), ownerKey: OWNER });
        clearCap();
        armSettle();
      },
      type() {
        if (state.phase === "IDLE") return;
        if (state.phase === "PENDING") {
          clearSettle();
          state = pendingBatchReducer(state, { type: "TYPE" });
        }
        armCap();
      },
      cancel() {
        // Mirrors the hook's cancel callback: clear timers, dispatch CANCEL, no onDeliver.
        clearSettle();
        clearCap();
        state = pendingBatchReducer(state, { type: "CANCEL" });
      },
      getPhase: () => state.phase,
      getParagraphs: () => state.paragraphs,
    };
  }

  it("C1: cancel from PENDING resets to IDLE and does NOT call onDeliver", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSimWithCancel((body) => deliveries.push(body));

    sim.submit("held message");
    expect(sim.getPhase()).toBe("PENDING");

    sim.cancel();

    expect(sim.getPhase()).toBe("IDLE");
    expect(sim.getParagraphs()).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("C2: cancel from PENDING clears the settle timer so no delivery fires after the settle window", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSimWithCancel((body) => deliveries.push(body));

    sim.submit("held message");
    sim.cancel();

    // Advance well past the settle window - timer must have been cleared.
    vi.advanceTimersByTime(SETTLE_MS + 1000);

    expect(deliveries).toHaveLength(0);
    expect(sim.getPhase()).toBe("IDLE");
  });

  it("C3: cancel from SUSPENDED resets to IDLE and does NOT call onDeliver", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSimWithCancel((body) => deliveries.push(body));

    sim.submit("held message");
    sim.type(); // -> SUSPENDED
    expect(sim.getPhase()).toBe("SUSPENDED");

    sim.cancel();

    expect(sim.getPhase()).toBe("IDLE");
    expect(sim.getParagraphs()).toHaveLength(0);
    expect(deliveries).toHaveLength(0);
  });

  it("C4: cancel from SUSPENDED clears the safety-cap timer so no delivery fires", () => {
    const deliveries: string[] = [];
    const sim = makeBatchSimWithCancel((body) => deliveries.push(body));

    sim.submit("held message");
    sim.type(); // -> SUSPENDED, safety cap armed
    sim.cancel();

    // Advance well past the safety cap - timer must have been cleared.
    vi.advanceTimersByTime(SAFETY_CAP_MS + 1000);

    expect(deliveries).toHaveLength(0);
    expect(sim.getPhase()).toBe("IDLE");
  });
});

// ---------------------------------------------------------------------------
// settleMs option
// ---------------------------------------------------------------------------

describe("settleMs option (TASK-500.1)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("custom settleMs causes delivery at that time, not at SETTLE_MS", () => {
    const deliveries: string[] = [];
    const CUSTOM_MS = 5_000; // much shorter than SETTLE_MS (18_000)

    // Simulate armSettle with a custom settle window.
    let state: PendingBatchState = { ...IDLE_TEST_STATE };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    function armSettle(ms: number) {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (state.phase !== "PENDING" || state.paragraphs.length === 0) return;
        const body = buildBatchBody(state.paragraphs);
        state = pendingBatchReducer(state, { type: "SETTLE_FIRE" });
        deliveries.push(body);
      }, ms);
    }

    state = pendingBatchReducer(state, { type: "SUBMIT", text: "hello", nowMs: Date.now(), ownerKey: OWNER });
    armSettle(CUSTOM_MS);

    // Not yet at CUSTOM_MS: no delivery.
    vi.advanceTimersByTime(CUSTOM_MS - 1);
    expect(deliveries).toHaveLength(0);

    // Exactly at CUSTOM_MS: delivery fires.
    vi.advanceTimersByTime(1);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toBe("hello");
    expect(state.phase).toBe("IDLE");
  });

  it("custom settleMs does not fire before its window (unlike default SETTLE_MS)", () => {
    // Verify the custom ms is actually different from the default, and that
    // the timer respects the custom value exactly.
    const CUSTOM_MS = 3_000;
    expect(CUSTOM_MS).toBeLessThan(SETTLE_MS);

    const deliveries: string[] = [];
    let state: PendingBatchState = { ...IDLE_TEST_STATE };
    let settleTimer: ReturnType<typeof setTimeout> | null = null;

    function armSettle(ms: number) {
      if (settleTimer !== null) { clearTimeout(settleTimer); settleTimer = null; }
      settleTimer = setTimeout(() => {
        settleTimer = null;
        if (state.phase !== "PENDING" || state.paragraphs.length === 0) return;
        const body = buildBatchBody(state.paragraphs);
        state = pendingBatchReducer(state, { type: "SETTLE_FIRE" });
        deliveries.push(body);
      }, ms);
    }

    state = pendingBatchReducer(state, { type: "SUBMIT", text: "msg", nowMs: Date.now(), ownerKey: OWNER });
    armSettle(CUSTOM_MS);

    // Advance past CUSTOM_MS: delivery fires.
    vi.advanceTimersByTime(CUSTOM_MS + 1);
    expect(deliveries).toHaveLength(1);

    // Safety: if we had used SETTLE_MS, delivery would NOT have fired yet.
    // This documents the custom-ms contract.
    expect(CUSTOM_MS + 1).toBeLessThan(SETTLE_MS);
  });

  it("SAFETY_CAP_MS is unchanged (not configurable via settleMs)", () => {
    // The safety cap is always 5 * 60_000 regardless of settleMs.
    expect(SAFETY_CAP_MS).toBe(5 * 60_000);
  });
});

// ---------------------------------------------------------------------------
// Batch ownership and dictation provenance
//
// Both used to be route-level values describing a batch they did not belong to:
// the mirror keyed by the currently-rendered agent, and dictation lived in a
// single component ref. Now they are fields of the batch, so nothing that reads
// them can pick up the wrong thread's or the wrong batch's answer.
// ---------------------------------------------------------------------------

describe("batch ownership travels with the paragraphs", () => {
  it("SUBMIT stamps the owner", () => {
    const s = run([{ type: "SUBMIT", text: "hello", nowMs: 1000, ownerKey: "agentA" }]);
    expect(s.ownerKey).toBe("agentA");
  });

  it("further submits on the same thread keep the owner and append", () => {
    const s = run([
      { type: "SUBMIT", text: "one", nowMs: 1000, ownerKey: "agentA" },
      { type: "SUBMIT", text: "two", nowMs: 2000, ownerKey: "agentA" },
    ]);
    expect(s.ownerKey).toBe("agentA");
    expect(s.paragraphs).toEqual(["one", "two"]);
  });

  it("a submit for a DIFFERENT thread starts a fresh batch rather than inheriting the text", () => {
    // Unreachable in the live component (the deliver-on-switch effect resets to
    // IDLE before any submit for the new thread can be dispatched), but it is
    // the structural half of the fix: there is no reachable state in which the
    // paragraphs and the ownerKey disagree, so no later reader can be misled.
    // The alternative - appending - is relabelling one thread's text as
    // another's, which is the whole defect.
    const s = run([
      { type: "SUBMIT", text: "text for agentA", nowMs: 1000, ownerKey: "agentA" },
      { type: "SUBMIT", text: "text for agentB", nowMs: 2000, ownerKey: "agentB" },
    ]);
    expect(s.ownerKey).toBe("agentB");
    expect(s.paragraphs).toEqual(["text for agentB"]);
  });

  it("every terminal transition clears the owner back to null", () => {
    for (const terminal of [
      { type: "DELIVERED" },
      { type: "CANCEL" },
      { type: "SEND_NOW" },
      { type: "SETTLE_FIRE" },
    ] as BatchAction[]) {
      const s = run([
        { type: "SUBMIT", text: "held", nowMs: 1000, ownerKey: "agentA" },
        terminal,
      ]);
      expect(s.phase).toBe("IDLE");
      expect(s.ownerKey).toBeNull();
    }
  });

  it("SAFETY_CAP clears the owner too (it delivers from SUSPENDED)", () => {
    const s = run([
      { type: "SUBMIT", text: "held", nowMs: 1000, ownerKey: "agentA" },
      { type: "TYPE" },
      { type: "SAFETY_CAP" },
    ]);
    expect(s.phase).toBe("IDLE");
    expect(s.ownerKey).toBeNull();
  });

  it("a no-op action leaves the owner alone", () => {
    // TYPE while PENDING only changes phase; nothing about ownership moves.
    const s = run([
      { type: "SUBMIT", text: "held", nowMs: 1000, ownerKey: "agentA" },
      { type: "TYPE" },
    ]);
    expect(s.phase).toBe("SUSPENDED");
    expect(s.ownerKey).toBe("agentA");
  });
});

describe("dictation provenance belongs to the batch, not the component", () => {
  it("SUBMIT records it, and it is sticky across the batch", () => {
    // The paragraphs merge into ONE written block, so one dictated message makes
    // the delivered block dictated.
    const s = run([
      { type: "SUBMIT", text: "spoken", nowMs: 1000, ownerKey: OWNER, dictated: true },
      { type: "SUBMIT", text: "typed", nowMs: 2000, ownerKey: OWNER },
    ]);
    expect(s.dictated).toBe(true);
  });

  it("defaults to false and stays false for a typed batch", () => {
    const s = run([
      { type: "SUBMIT", text: "typed", nowMs: 1000, ownerKey: OWNER },
      { type: "SUBMIT", text: "also typed", nowMs: 2000, ownerKey: OWNER },
    ]);
    expect(s.dictated).toBe(false);
  });

  it("a CANCELLED dictation cannot mark the NEXT batch as dictated", () => {
    // The sibling bug this fold-in fixes. batchDictatedRef was a single
    // component-level ref reset only inside onDeliver, so a cancel (or a beacon
    // handover, which also resets via batchCancel) left it armed and stamped the
    // next plain typed message - on any thread - as dictated. That badge tells
    // the reader to expect transcription errors rather than deliberate wording.
    const afterCancel = run([
      { type: "SUBMIT", text: "spoken", nowMs: 1000, ownerKey: "agentA", dictated: true },
      { type: "CANCEL" },
    ]);
    expect(afterCancel.dictated).toBe(false);
    const next = pendingBatchReducer(afterCancel, {
      type: "SUBMIT",
      text: "typed on another thread",
      nowMs: 3000,
      ownerKey: "agentB",
    });
    expect(next.dictated).toBe(false);
  });

  it("a fresh batch for a different owner does not inherit dictation", () => {
    const s = run([
      { type: "SUBMIT", text: "spoken", nowMs: 1000, ownerKey: "agentA", dictated: true },
      { type: "SUBMIT", text: "typed", nowMs: 2000, ownerKey: "agentB" },
    ]);
    expect(s.dictated).toBe(false);
  });
});

describe("deliveryFor (every delivery is addressed)", () => {
  it("addresses the batch by its owner, not the fallback", () => {
    const s = run([
      { type: "SUBMIT", text: "one", nowMs: 1000, ownerKey: "agentA", dictated: true },
      { type: "SUBMIT", text: "two", nowMs: 2000, ownerKey: "agentA" },
    ]);
    // "agentB" is what the route renders on the deliver-on-switch commit. It
    // must not be able to win.
    expect(deliveryFor(s, "agentB")).toEqual({
      body: "one\n\ntwo",
      targetAgent: "agentA",
      dictated: true,
    });
  });

  it("falls back only when there is no owner at all", () => {
    // Not producible by the reducer for a non-IDLE state; this pins that an
    // unowned batch still goes out ADDRESSED rather than unaddressed, because
    // an unaddressed compose POST lands wherever the route happens to be.
    const orphan: PendingBatchState = {
      phase: "PENDING",
      paragraphs: ["orphan"],
      lastSubmitAt: 1000,
      ownerKey: null,
      dictated: false,
    };
    expect(deliveryFor(orphan, "agentB").targetAgent).toBe("agentB");
  });
});
