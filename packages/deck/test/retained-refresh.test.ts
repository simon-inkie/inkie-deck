/**
 * retained-refresh.test.ts
 *
 * Unit tests for refreshesRetainedBlocks, the pure gate exported from
 * threads.$agent.tsx that decides whether a completing fetcher must re-fetch
 * the retained BELOW-WINDOW block range. Same shape as action-intent.test.ts: a named pure
 * export from the route, imported directly, node env, no DOM and no router.
 *
 * The behaviour under test is a RISING EDGE, not a single boolean: the route
 * holds the previous value in a ref and fires the refetch on the true -> false
 * transition. So the tests replay whole fetcher lifecycles through the same
 * transition rule the route uses (replayLifecycle below) and assert whether a
 * refresh fired, rather than only probing one frame.
 *
 * The cost claim is the point of this file. Auto-resolve made compose able to
 * flip an existing card, but compose is overwhelmingly a plain reply, and putting
 * "compose" in CARD_ACTION_INTENTS would have fired a below-window refetch on
 * every message ever sent. The plain-reply lifecycles below assert the gate is
 * false at EVERY frame, so there is no edge to fire on.
 *
 * ASCII only.
 */
import { describe, it, expect } from "vitest";
import {
  refreshesRetainedBlocks,
  type RefreshGateFetcher,
} from "~/routes/threads.$agent";

// ---------------------------------------------------------------------------
// Lifecycle helpers
// ---------------------------------------------------------------------------

function form(intent: string): FormData {
  const fd = new FormData();
  fd.set("intent", intent);
  return fd;
}

/**
 * The three frames react-router puts a submitting fetcher through:
 *
 * 1. submitting - formData set, data still undefined (the action has not
 *    returned; a fresh fetcher key carries no prior data).
 * 2. loading    - formData STILL set, data now the action's return value,
 *    while revalidation runs. This is the only frame the return shape is
 *    visible alongside the intent.
 * 3. idle       - formData cleared, fetcher done.
 */
function lifecycle(intent: string, actionData: unknown): RefreshGateFetcher[] {
  return [
    { state: "submitting", formData: form(intent), data: undefined },
    { state: "loading", formData: form(intent), data: actionData },
    { state: "idle", formData: undefined, data: actionData },
  ];
}

/** The route's rule: fire when the gate was true and has just gone false. */
function replayLifecycle(frames: RefreshGateFetcher[]): {
  fired: boolean;
  gate: boolean[];
} {
  const gate = frames.map(refreshesRetainedBlocks);
  let fired = false;
  let prev = false;
  for (const cur of gate) {
    if (prev && !cur) fired = true;
    prev = cur;
  }
  return { fired, gate };
}

// ---------------------------------------------------------------------------
// The cost guard: a plain reply must never cost a below-window refetch
// ---------------------------------------------------------------------------

describe("plain compose reply does not refresh retained blocks", () => {
  it("never opens the gate at any frame, so no edge can fire", () => {
    // Plain-reply branch of the action returns a bare { ok: true }.
    const { fired, gate } = replayLifecycle(lifecycle("compose", { ok: true }));
    expect(gate).toEqual([false, false, false]);
    expect(fired).toBe(false);
  });

  it("stays shut when the action has not returned yet", () => {
    expect(
      refreshesRetainedBlocks({
        state: "submitting",
        formData: form("compose"),
        data: undefined,
      })
    ).toBe(false);
  });

  it("stays shut for a compose whose data is a non-object or null", () => {
    for (const data of [undefined, null, "ok", 0, true]) {
      expect(
        refreshesRetainedBlocks({
          state: "loading",
          formData: form("compose"),
          data,
        })
      ).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// The fix: an auto-resolve DOES refresh, same as a card action
// ---------------------------------------------------------------------------

describe("compose that auto-resolved a card refreshes retained blocks", () => {
  it("fires when the card was resolved by this reply (alreadyAnswered false)", () => {
    const { fired, gate } = replayLifecycle(
      lifecycle("compose", { ok: true, alreadyAnswered: false })
    );
    expect(gate).toEqual([false, true, false]);
    expect(fired).toBe(true);
  });

  it("fires on the idempotent no-op too (alreadyAnswered true)", () => {
    // Presence of the key, not its value, is the auto-resolve signal: `true`
    // means customAnswerCard found the card already answered, which still
    // means the retained copy can be behind the file.
    const { fired } = replayLifecycle(
      lifecycle("compose", { ok: true, alreadyAnswered: true })
    );
    expect(fired).toBe(true);
  });

  it("matches, frame for frame, what an in-set card intent gets today", () => {
    const custom = replayLifecycle(lifecycle("custom", { ok: true, alreadyAnswered: false }));
    const compose = replayLifecycle(
      lifecycle("compose", { ok: true, alreadyAnswered: false })
    );
    // The auto-resolve compose is the same seam (customAnswerCard) as the
    // "custom" intent, so it must produce the same refresh, not a lookalike.
    expect(compose.fired).toBe(custom.fired);
    expect(compose.gate.slice(1)).toEqual(custom.gate.slice(1));
  });
});

// ---------------------------------------------------------------------------
// Existing card-action behaviour must be untouched
// ---------------------------------------------------------------------------

describe("card-action intents are unchanged", () => {
  const cardIntents = [
    "answer",
    "custom",
    "pushback",
    "done",
    "dismiss",
    "doneNote",
    "dismissDecision",
    "supersedeDecision",
    "supersedeAction",
  ];

  it("opens the gate from the first frame, before any data exists", () => {
    for (const intent of cardIntents) {
      expect(
        refreshesRetainedBlocks({
          state: "submitting",
          formData: form(intent),
          data: undefined,
        })
      ).toBe(true);
    }
  });

  it("fires a refresh across the full lifecycle", () => {
    for (const intent of cardIntents) {
      expect(replayLifecycle(lifecycle(intent, { ok: true })).fired).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Frames that must never match
// ---------------------------------------------------------------------------

describe("non-matching fetcher frames", () => {
  it("an idle fetcher never opens the gate, whatever it is carrying", () => {
    expect(
      refreshesRetainedBlocks({
        state: "idle",
        formData: form("answer"),
        data: { ok: true, alreadyAnswered: false },
      })
    ).toBe(false);
  });

  it("a REVALIDATING fetcher never opens the gate", () => {
    // react-router re-marks other fetchers as state "loading" with their
    // PREVIOUS data carried over and no formData. A compose fetcher that
    // auto-resolved a card earlier would otherwise re-fire here every time
    // any unrelated navigation revalidated the page.
    expect(
      refreshesRetainedBlocks({
        state: "loading",
        formData: undefined,
        data: { ok: true, alreadyAnswered: false },
      })
    ).toBe(false);
  });

  it("an unrelated intent never opens the gate", () => {
    for (const intent of ["react", "pin", "delete", ""]) {
      expect(
        refreshesRetainedBlocks({
          state: "submitting",
          formData: form(intent),
          data: { ok: true, alreadyAnswered: false },
        })
      ).toBe(false);
    }
  });
});
