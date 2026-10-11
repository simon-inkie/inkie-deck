/**
 * pending-batch.ts - Per-thread PENDING outbound batch state machine.
 *
 * Implements the typing-aware message batching described in the SPEC. The state
 * machine holds submitted messages in a client-side batch and delivers them as a
 * single inbox block after the user settles (no typing, no submit for SETTLE_MS).
 *
 * States per thread:
 *   IDLE       - no pending batch.
 *   PENDING    - has sent messages; settle timer running.
 *   SUSPENDED  - sub-state of PENDING; user is typing a follow-up; settle timer
 *                cleared (HARD SUSPEND). An in-progress draft can never let a
 *                prior message slip out underneath it.
 *
 * Transitions:
 *   SUBMIT     - append text to batch; enter/refresh PENDING; restart settle timer.
 *   TYPE       - if PENDING/SUSPENDED: enter SUSPENDED (clear settle timer).
 *   SETTLE_FIRE- settle timer elapsed; fire the merged body -> IDLE.
 *   SEND_NOW   - immediate delivery; skip settle -> IDLE.
 *   SAFETY_CAP - 5 min of no keystrokes while SUSPENDED with sent content ->
 *                deliver the sent portion, leave draft in textarea.
 *   DELIVERED  - confirm delivery, reset to IDLE.
 *
 * Pure module: state machine logic is a plain reducer; timer side-effects live in
 * the usePendingBatch hook. This separation makes the reducer fully unit-testable
 * without mocks.
 *
 * Per-thread keying: the hook accepts an agentKey. Switching threads does NOT
 * carry over the pending batch (it stays keyed to the previous thread). The caller
 * (threads.$agent.tsx) resets on navigation by passing the new agentKey.
 *
 * OWNERSHIP TRAVELS WITH THE BATCH. `ownerKey` and `dictated` live
 * in the reducer state, stamped at the first SUBMIT, and every write path
 * (deliver, mirror, beacon) addresses the batch by THAT key - never by whichever
 * thread happens to be rendered when the write fires. The two are the same
 * mistake: route-level values describing a batch they do not belong to.
 *
 * The incident that bought this: on a thread switch A -> B with a pending batch,
 * the deliver-on-switch effect below dispatches DELIVERED, but a dispatch during
 * a passive-effect flush does not re-render until every effect in that flush has
 * run. So the route's mirror effect, later in the SAME flush, still saw A's
 * paragraphs while `agent` already read B, and wrote them into B's localStorage
 * slot stamped `agentKey: "B"`. Nothing in the record's own shape revealed the
 * mislabel; recovery later delivered A's text to B as a genuine-looking compose
 * POST. Three of the operator's messages went to the wrong agent that night, with
 * delays from 71 seconds to 45 minutes. Effect ORDER cannot be relied on to
 * prevent this; the key travelling with the paragraphs can.
 *
 * ASCII only - no em-dashes.
 */

import { useReducer, useEffect, useLayoutEffect, useRef, useCallback } from "react";

// ---------------------------------------------------------------------------
// Constants (tunable)
// ---------------------------------------------------------------------------

/** Settle window: genuine quiet (no typing, no submit) after which the batch delivers. */
export const SETTLE_MS = 18_000;

/** Safety cap: max time a sent-portion can sit while a draft is being typed. */
export const SAFETY_CAP_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// State machine types
// ---------------------------------------------------------------------------

export type BatchPhase = "IDLE" | "PENDING" | "SUSPENDED";

export interface PendingBatchState {
  /** Current phase. */
  phase: BatchPhase;
  /**
   * Confirmed (submitted) paragraphs in this batch. Each submit appends one
   * paragraph; they are joined with "\n\n" on delivery so message boundaries
   * are preserved in the written block.
   */
  paragraphs: string[];
  /** Epoch ms of the last submit (for Safety Cap countdown). */
  lastSubmitAt: number;
  /**
   * Which agent thread these paragraphs belong to. Stamped at the first SUBMIT
   * from the hook's agentKey; null in IDLE (there is nothing to own).
   *
   * This is the single identifier every write path must address the batch by.
   * The route's currently-rendered `agent` is NOT interchangeable with it: on
   * the deliver-on-switch commit the route already reads the NEW thread while
   * this state still holds the OLD thread's paragraphs, and that gap is exactly
   * how A's text got written into B's storage slot (see the module docblock).
   */
  ownerKey: string | null;
  /**
   * Did any message in THIS batch come from voice transcription? Renders a
   * "dictated" marker on the written block so the reader knows to expect
   * transcription errors rather than deliberate wording.
   *
   * In state rather than a route-level ref, so the provenance belongs to the
   * batch instead of to "the last
   * dictated submit anywhere in the component". The ref was only ever reset
   * inside onDeliver, so a CANCELLED dictation - or one handed over by the
   * beacon flush, which also resets via batchCancel - left the flag armed and
   * falsely stamped the next plain typed message, on any thread, as dictated.
   */
  dictated: boolean;
}

const IDLE_STATE: PendingBatchState = {
  phase: "IDLE",
  paragraphs: [],
  lastSubmitAt: 0,
  ownerKey: null,
  dictated: false,
};

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export type BatchAction =
  | {
      type: "SUBMIT";
      text: string;
      nowMs: number;
      /**
       * Required, not derived: a submit cannot be dispatched without saying
       * which thread it belongs to. Making this mandatory is deliberate - every
       * call site is a compile error until it declares the owner, which is the
       * property the misdirection incident turned out to depend on.
       */
      ownerKey: string;
      /** This message came from voice transcription. Sticky for the batch. */
      dictated?: boolean;
    }
  | { type: "TYPE" }
  | { type: "SETTLE_FIRE" }
  | { type: "SEND_NOW" }
  | { type: "SAFETY_CAP" }
  | { type: "DELIVERED" }
  | { type: "CANCEL" };

// ---------------------------------------------------------------------------
// Pure reducer
// ---------------------------------------------------------------------------

/**
 * Pure state machine reducer. Contains NO side effects - timers live in the
 * hook. This means the reducer is fully unit-testable without any mocks.
 *
 * SETTLE_FIRE and SEND_NOW do not clear the state here because the hook needs
 * to know the merged body to deliver before resetting. The hook reads the
 * pending body, fires the POST, then dispatches DELIVERED.
 *
 * Exception: SETTLE_FIRE transitions to IDLE immediately (it is the hook's
 * timer callback, and the body is captured before dispatch via a closure over
 * the state ref). SEND_NOW similarly transitions immediately.
 */
export function pendingBatchReducer(
  state: PendingBatchState,
  action: BatchAction
): PendingBatchState {
  switch (action.type) {
    case "SUBMIT": {
      const text = action.text.trim();
      // Ignore empty submits (should not reach here, but be defensive).
      if (!text) return state;
      // A submit only EXTENDS a batch that already belongs to the same thread.
      // A submit for a different owner starts a fresh batch rather than
      // appending, so "every paragraph in here belongs to ownerKey" holds
      // structurally instead of depending on effect timing.
      //
      // Unreachable in the live component: any agentKey change re-runs the
      // deliver-on-switch effect below, React flushes pending passive effects
      // before dispatching the next discrete input event, and that effect
      // resets to IDLE - so a submit can never arrive while state still holds
      // another thread's paragraphs. Kept because the alternative branch is
      // relabelling one thread's text as another's, which is the defect this
      // whole change exists to make impossible.
      const extending = state.phase !== "IDLE" && state.ownerKey === action.ownerKey;
      return {
        phase: "PENDING",
        paragraphs: extending ? [...state.paragraphs, text] : [text],
        lastSubmitAt: action.nowMs,
        ownerKey: action.ownerKey,
        // Sticky across the batch: one dictated message makes the whole
        // delivered block dictated, because they merge into one written body.
        dictated: (extending && state.dictated) || action.dictated === true,
      };
    }

    case "TYPE": {
      // Only meaningful while PENDING. Moves to SUSPENDED (hard suspend).
      // In IDLE or SUSPENDED, TYPE is a no-op (the settle timer is not running).
      if (state.phase !== "PENDING") return state;
      return { ...state, phase: "SUSPENDED" };
    }

    case "SETTLE_FIRE": {
      // Settle timer elapsed while PENDING. Deliver -> IDLE.
      // Should only fire while PENDING (timer cleared on TYPE/SEND_NOW).
      if (state.phase !== "PENDING") return state;
      return IDLE_STATE;
    }

    case "SEND_NOW": {
      // Immediate delivery regardless of phase (PENDING or SUSPENDED).
      if (state.phase === "IDLE") return state;
      return IDLE_STATE;
    }

    case "SAFETY_CAP": {
      // 5 min of silence while SUSPENDED with sent content -> deliver sent
      // portion, leave draft in textarea. Reduce paragraphs to empty (delivery
      // happened); the hook will have captured them before dispatch.
      if (state.phase !== "SUSPENDED" || state.paragraphs.length === 0) return state;
      return IDLE_STATE;
    }

    case "DELIVERED": {
      return IDLE_STATE;
    }

    case "CANCEL": {
      // Discard all held paragraphs without delivering. Full reset to IDLE.
      return IDLE_STATE;
    }

    default:
      return state;
  }
}

// ---------------------------------------------------------------------------
// Derived helpers
// ---------------------------------------------------------------------------

/** Build the merged body from confirmed paragraphs (paragraph-joined). */
export function buildBatchBody(paragraphs: string[]): string {
  return paragraphs.join("\n\n");
}

/**
 * Everything a caller needs to POST a batch, addressed to the thread that OWNS
 * it. Built from the captured state at the moment of delivery, so no field can
 * be picked up from the route's render scope by accident.
 */
export interface BatchDelivery {
  /** Paragraph-joined body of the whole batch. */
  body: string;
  /**
   * The thread this batch belongs to. ALWAYS set, on every delivery path
   * (settle, send-now, safety-cap, deliver-on-switch), not just the switch one.
   *
   * Previously the settle/send-now/cap paths omitted it and let the action fall
   * back to the mounted route's params.agent. That is correct whenever the two
   * agree, and silently wrong when they do not: a settle timer coming due in the
   * gap between the commit that renders thread B and the passive-effect flush
   * that clears the timer still sees phase PENDING, and delivered A's body with
   * no target - so the action wrote it to B. Narrow window, same wrong-inbox
   * outcome as the mirror bug, and closed by addressing every delivery.
   */
  targetAgent: string;
  /** Dictation provenance of THIS batch (see PendingBatchState.dictated). */
  dictated: boolean;
}

/**
 * Build the delivery payload for a captured batch state.
 *
 * fallbackAgent only applies to a batch with no ownerKey, which the reducer
 * cannot produce for a non-IDLE state; it keeps a delivery addressed rather
 * than unaddressed if one ever appears.
 */
export function deliveryFor(
  state: PendingBatchState,
  fallbackAgent: string
): BatchDelivery {
  return {
    body: buildBatchBody(state.paragraphs),
    targetAgent: state.ownerKey ?? fallbackAgent,
    dictated: state.dictated,
  };
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

export interface PendingBatchCallbacks {
  /**
   * Called when the batch should be delivered, on every path (settle, send-now,
   * safety-cap, deliver-on-switch). The delivery carries its own targetAgent and
   * dictated flag, captured from the batch state - the caller must POST what it
   * is given here and must NOT substitute the currently-rendered agent or a
   * component-level dictation flag for either. See BatchDelivery.
   */
  onDeliver: (delivery: BatchDelivery) => void;
}

export interface PendingBatchOptions extends PendingBatchCallbacks {
  /**
   * Settle window in ms (default: SETTLE_MS = 18_000).
   * An in-flight pending batch keeps its current timer; the next arm uses the
   * new value. Changing this between renders does not crash. The SAFETY_CAP_MS
   * is independent and never configurable.
   */
  settleMs?: number;
}

export interface PendingBatchHandle {
  /** Current state - read by the UI to render the pending bubble + badge. */
  state: PendingBatchState;
  /**
   * Call on every standard submit. The hook will buffer the text and start the
   * settle timer. Returns false when the compose should NOT clear its draft
   * (this should always be true in the custom/card-answer path, where the hook
   * is not involved).
   *
   * dictated: this message came from voice transcription. Recorded on the batch
   * itself, so it cannot outlive the batch it describes.
   */
  onSubmit: (text: string, dictated?: boolean) => void;
  /** Call on every keystroke in the composer textarea while PENDING/SUSPENDED. */
  onType: () => void;
  /** Deliver the batch immediately (skip settle). */
  sendNow: () => void;
  /** Discard the held batch without delivering. Clears all timers and resets to IDLE. */
  cancel: () => void;
}

/**
 * usePendingBatch - per-thread batch state machine with timer side-effects.
 *
 * agentKey: the thread's agent name. When the key changes (thread navigation)
 * with a non-IDLE batch, the hook delivers the pending paragraphs to the OLD
 * thread before resetting. The delivery carries the old agent key as targetAgent
 * so the caller can route the POST to the correct inbox even though the current
 * route is already the new thread.
 *
 * onDeliver: called whenever a delivery fires (settle, send-now, safety-cap, or
 * deliver-on-switch). targetAgent is only set on the deliver-on-switch path.
 *
 * TODO: durability on tab-close -- sendBeacon flush
 * When the tab closes/hides while phase !== "IDLE", the pending paragraphs
 * are lost. A flush via navigator.sendBeacon to the compose action would cover
 * the common "closes tab / switches away" case.
 */
export function usePendingBatch(
  agentKey: string,
  { onDeliver, settleMs }: PendingBatchOptions
): PendingBatchHandle {
  const [state, dispatch] = useReducer(pendingBatchReducer, IDLE_STATE);

  // Stable ref to current state so timer callbacks always see fresh values
  // without re-arming (closures over state would go stale).
  const stateRef = useRef(state);
  stateRef.current = state;

  // Stable ref to onDeliver so timers always call the latest version.
  const onDeliverRef = useRef(onDeliver);
  onDeliverRef.current = onDeliver;

  // Stable ref to agentKey so a SUBMIT can stamp the owner without putting
  // agentKey in onSubmit's dep list (which would re-create the callback, and so
  // Compose's onBatchSubmit prop, on every navigation).
  //
  // Updated in a LAYOUT EFFECT, never during render.
  // React can replay or discard render work, so a ref
  // written in the render body can end up holding a key from a render that never
  // committed - and this ref is what onSubmit stamps as `ownerKey`, i.e. the
  // exact ownership guarantee this whole change exists to make structural. A ref
  // that can hold an uncommitted thread key is the same defect one level down.
  //
  // LAYOUT, not passive: the ref must be current before anything in the SAME
  // commit can read it (event handlers, and any effect that reaches onSubmit or
  // sendNow), which a passive effect cannot promise. Same reasoning as the
  // route's durabilityRef. The useRef initialiser covers the first commit, so
  // there is no window where the ref is unset.
  const agentKeyRef = useRef(agentKey);
  useLayoutEffect(() => {
    agentKeyRef.current = agentKey;
  }, [agentKey]);

  // Stable ref to settleMs so armSettle always uses the current value without
  // needing to re-create the callback (avoids timer churn on every render).
  const settleMsRef = useRef(settleMs ?? SETTLE_MS);
  settleMsRef.current = settleMs ?? SETTLE_MS;

  const settleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const safetyCapTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clear both timers helpers.
  const clearSettle = useCallback(() => {
    if (settleTimerRef.current !== null) {
      clearTimeout(settleTimerRef.current);
      settleTimerRef.current = null;
    }
  }, []);

  const clearSafetyCap = useCallback(() => {
    if (safetyCapTimerRef.current !== null) {
      clearTimeout(safetyCapTimerRef.current);
      safetyCapTimerRef.current = null;
    }
  }, []);

  // Arm (or re-arm) the settle timer. Only relevant in PENDING phase.
  // Uses settleMsRef.current so the value is always fresh without needing to
  // re-create this callback on every settleMs change (avoids timer churn).
  const armSettle = useCallback(() => {
    clearSettle();
    settleTimerRef.current = setTimeout(() => {
      settleTimerRef.current = null;
      const s = stateRef.current;
      if (s.phase !== "PENDING" || s.paragraphs.length === 0) return;
      const delivery = deliveryFor(s, agentKeyRef.current);
      dispatch({ type: "SETTLE_FIRE" });
      onDeliverRef.current(delivery);
    }, settleMsRef.current);
  }, [clearSettle]);

  // Arm (or re-arm) the safety cap. Only relevant in SUSPENDED phase.
  const armSafetyCap = useCallback(() => {
    clearSafetyCap();
    safetyCapTimerRef.current = setTimeout(() => {
      safetyCapTimerRef.current = null;
      const s = stateRef.current;
      if (s.phase !== "SUSPENDED" || s.paragraphs.length === 0) return;
      const delivery = deliveryFor(s, agentKeyRef.current);
      dispatch({ type: "SAFETY_CAP" });
      onDeliverRef.current(delivery);
    }, SAFETY_CAP_MS);
  }, [clearSafetyCap]);

  // When agentKey changes: deliver any pending batch to the OLD thread, then reset.
  //
  // Sharp edge: this effect runs AFTER render with the NEW key, so batchFetcher
  // and the route's params.agent both point to the new thread. We capture the old
  // agent key and the merged body into locals BEFORE dispatch clears the state,
  // then pass oldAgent as targetAgent to onDeliver. The caller sets a targetAgent
  // form field so the action can write to the old inbox regardless of which route
  // is currently mounted.
  const prevAgentKeyRef = useRef(agentKey);
  useEffect(() => {
    if (prevAgentKeyRef.current === agentKey) return;
    // Capture OLD agent BEFORE overwriting the ref.
    const oldAgent = prevAgentKeyRef.current;
    prevAgentKeyRef.current = agentKey;
    clearSettle();
    clearSafetyCap();
    // Capture the merged body from stateRef BEFORE dispatch clears it.
    // stateRef is a stable ref updated every render, so it reflects the
    // state at the moment this effect fires (not a stale closure).
    const s = stateRef.current;
    if (s.phase !== "IDLE" && s.paragraphs.length > 0) {
      // Addressed by the batch's OWN key, with oldAgent only as a fallback.
      // The current route is already the NEW thread, so nothing about the
      // delivery may be read from render scope.
      const delivery = deliveryFor(s, oldAgent);
      dispatch({ type: "DELIVERED" });
      onDeliverRef.current(delivery);
    } else {
      dispatch({ type: "DELIVERED" });
    }
  }, [agentKey, clearSettle, clearSafetyCap]);

  // Cleanup on unmount.
  useEffect(() => {
    return () => {
      clearSettle();
      clearSafetyCap();
    };
  }, [clearSettle, clearSafetyCap]);

  // ---------------------------------------------------------------------------
  // Public interface
  // ---------------------------------------------------------------------------

  const onSubmit = useCallback(
    (text: string, dictated = false) => {
      const trimmed = text.trim();
      if (!trimmed) return;
      dispatch({
        type: "SUBMIT",
        text: trimmed,
        nowMs: Date.now(),
        ownerKey: agentKeyRef.current,
        dictated,
      });
      // Clear safety cap (a new submit re-enters PENDING, not SUSPENDED).
      clearSafetyCap();
      // Arm/re-arm the settle timer.
      armSettle();
    },
    [armSettle, clearSafetyCap]
  );

  const onType = useCallback(() => {
    const s = stateRef.current;
    if (s.phase === "IDLE") return;

    if (s.phase === "PENDING") {
      // HARD SUSPEND: clear the settle timer so a prior message cannot slip out.
      clearSettle();
      dispatch({ type: "TYPE" });
    }

    // (Re-)arm safety cap on every keystroke while suspended.
    armSafetyCap();
  }, [clearSettle, armSafetyCap]);

  const sendNow = useCallback(() => {
    const s = stateRef.current;
    if (s.phase === "IDLE" || s.paragraphs.length === 0) return;
    const delivery = deliveryFor(s, agentKeyRef.current);
    clearSettle();
    clearSafetyCap();
    dispatch({ type: "SEND_NOW" });
    onDeliverRef.current(delivery);
  }, [clearSettle, clearSafetyCap]);

  const cancel = useCallback(() => {
    // Clear timers first so neither the settle nor the safety cap can fire
    // after the state is reset. Must NOT call onDeliver - cancel discards.
    clearSettle();
    clearSafetyCap();
    dispatch({ type: "CANCEL" });
  }, [clearSettle, clearSafetyCap]);

  return { state, onSubmit, onType, sendNow, cancel };
}
