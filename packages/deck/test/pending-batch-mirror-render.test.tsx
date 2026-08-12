// @vitest-environment jsdom
/**
 * pending-batch-mirror-render.test.tsx - the misdirected-message regression.
 *
 * THE INCIDENT (2026-07-29). Three of Alex's messages were written into the
 * wrong agent's inbox, 71 seconds to 45 minutes after he sent them, with a
 * reboot in between. Single writes, correct-looking, wrong thread.
 *
 * Cause: switching threads with a pending batch. On the A -> B commit the hook's
 * deliver-on-switch effect delivers A's paragraphs and dispatches DELIVERED, but
 * a dispatch during a passive-effect flush does not re-render until every effect
 * in that flush has run. The route's mirror effect, later in the SAME flush, saw
 * `agent` = B and `pendingBatch.paragraphs` = A's, and wrote A's text into B's
 * localStorage slot stamped `agentKey: "B"`. Nothing in the record revealed the
 * mislabel, and recovery later delivered it as a genuine compose POST to B.
 *
 * WHY THIS FILE IS A RENDER TEST. The bug is not in any single function. Every
 * piece was correct on its own, which is why the reducer and storage unit suites
 * (both extensive, both green throughout) never saw it - it lives entirely in
 * WHICH COMMIT'S state a second effect reads. Only real React reconciliation
 * with the real hook reproduces that. Verified before the fix landed: the
 * harness below, against the pre-fix code, wrote
 *   mc.pendingBatch.v1.agentB = {"agentKey":"agentB","paragraphs":["text for
 *   agentA"],"dictated":false,...}
 *
 * The harness is not the route, so it asserts on the two seams the route now
 * delegates to - the real usePendingBatch hook and the real mirrorPendingBatch -
 * rather than on a copy of the route's decisions. Keep it in step with
 * threads.$agent.tsx's batch effects; the ORDER of the three effects below is
 * load-bearing and matches the route.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act, useEffect, useLayoutEffect, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { usePendingBatch, type BatchDelivery } from "~/lib/pending-batch";
import {
  KEY_PREFIX,
  MIN_RECOVERY_AGE_MS,
  clearBatch,
  mirrorPendingBatch,
  saveBatch,
  takeRecoveredBatch,
} from "~/lib/batch-durability";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Long enough that the settle timer never fires inside a test. */
const NEVER_SETTLES_MS = 60_000;

const deliveries: BatchDelivery[] = [];
/** What the mirror effect saw on each run: the poisoning window, observed. */
const mirrorPasses: Array<{
  renderedAgent: string;
  ownerKey: string | null;
  paragraphs: string[];
  wrote: boolean;
}> = [];
/** Every batch the beacon would have flushed, and where to. */
const beaconTargets: Array<{ owner: string; body: string }> = [];

/**
 * threads.$agent.tsx's flush(), reduced to its ADDRESSING decision - the one
 * line the owner stamp exists to feed: `const owner = ownerKey ?? agent`.
 *
 * Both flush triggers below call this, so neither is guarding a private copy of
 * the rule.
 */
function recordFlush(
  snapshot: { ownerKey: string | null; paragraphs: string[] },
  renderedAgent: string
) {
  const { ownerKey, paragraphs } = snapshot;
  if (!paragraphs.length) return;
  beaconTargets.push({ owner: ownerKey ?? renderedAgent, body: paragraphs.join("\n\n") });
}

/**
 * The route's batch wiring (threads.$agent.tsx), in declaration order:
 * usePendingBatch's own effects, then durabilityRef's layout effect, then
 * recovery, then the mirror.
 *
 * flushOnSwitch arms a flush from INSIDE the agent-change commit (see the test
 * of that name). Off by default, because it fires on every agent change and only
 * one test wants that.
 */
function BatchHost({ agent, flushOnSwitch = false }: { agent: string; flushOnSwitch?: boolean }) {
  // Declared above usePendingBatch, as in the route: onDeliver resets it, so a
  // forward reference would be a latent TDZ if the hook ever delivered
  // synchronously during the hook call (CodeRabbit).
  const durabilityRef = useRef({
    ownerKey: null as string | null,
    paragraphs: [] as string[],
    dictated: false,
  });

  const { state: pendingBatch, onSubmit } = usePendingBatch(agent, {
    settleMs: NEVER_SETTLES_MS,
    onDeliver: (delivery) => {
      deliveries.push(delivery);
      clearBatch(delivery.targetAgent);
      durabilityRef.current = { ownerKey: null, paragraphs: [], dictated: false };
    },
  });

  useLayoutEffect(() => {
    durabilityRef.current = {
      ownerKey: pendingBatch.ownerKey,
      paragraphs: pendingBatch.paragraphs,
      dictated: pendingBatch.dictated,
    };
  }, [pendingBatch.ownerKey, pendingBatch.paragraphs, pendingBatch.dictated]);

  // A flush landing INSIDE the agent-change commit: layout-effect time, so after
  // the refresh above and before the passive flush that delivers and clears the
  // ref. Declared after it deliberately - this is the reading order a hidden-tab
  // handler would see. Nothing else in the harness can observe that window.
  useLayoutEffect(() => {
    if (!flushOnSwitch) return;
    recordFlush(durabilityRef.current, agent);
  }, [agent, flushOnSwitch]);

  const recoveryDoneRef = useRef(false);
  useEffect(() => {
    takeRecoveredBatch(agent, Date.now(), "token");
    recoveryDoneRef.current = true;
  }, [agent]);

  useEffect(() => {
    const wrote = mirrorPendingBatch(pendingBatch, recoveryDoneRef.current, agent, Date.now());
    mirrorPasses.push({
      renderedAgent: agent,
      ownerKey: pendingBatch.ownerKey,
      paragraphs: pendingBatch.paragraphs,
      wrote,
    });
  }, [agent, pendingBatch.ownerKey, pendingBatch.paragraphs, pendingBatch.dictated]);

  return React.createElement(
    "div",
    null,
    React.createElement(
      "button",
      {
        "data-testid": "submit-dictated",
        onClick: () => onSubmit(`text for ${agent}`, true),
      },
      "submit"
    ),
    // Stands in for the pagehide/visibilitychange handler: reads the same
    // durabilityRef and addresses the flush the same way the route does.
    React.createElement(
      "button",
      {
        "data-testid": "beacon",
        onClick: () => recordFlush(durabilityRef.current, agent),
      },
      "beacon"
    )
  );
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  deliveries.length = 0;
  mirrorPasses.length = 0;
  beaconTargets.length = 0;
  window.localStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  window.localStorage.clear();
});

async function render(agent: string, flushOnSwitch = false) {
  await act(async () => {
    root.render(React.createElement(BatchHost, { agent, flushOnSwitch }));
  });
}

async function click(testid: string) {
  await act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
  });
}

/** Every localStorage record, so an assertion can look for text ANYWHERE. */
function allRecords(): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < window.localStorage.length; i += 1) {
    const k = window.localStorage.key(i)!;
    out.push([k, window.localStorage.getItem(k)!]);
  }
  return out;
}

describe("thread switch with a pending batch", () => {
  it("presents the OLD batch under the NEW agent (the window the bug lived in)", async () => {
    // Pins the MECHANISM, not just the outcome. If React ever stopped handing a
    // stale state to later effects in the same flush, this fails and the guard
    // below becomes dead weight worth deleting - so the guard's justification is
    // itself under test, rather than asserted in a comment.
    await render("agentA");
    await click("submit-dictated");
    await render("agentB");

    const straddling = mirrorPasses.filter(
      (p) => p.renderedAgent === "agentB" && p.ownerKey === "agentA"
    );
    expect(straddling).toHaveLength(1);
    expect(straddling[0]!.paragraphs).toEqual(["text for agentA"]);
    // Seeing it is fine. Writing it is the bug.
    expect(straddling[0]!.wrote).toBe(false);
  });

  it("leaves NO record of thread A's text anywhere in storage", async () => {
    await render("agentA");
    await click("submit-dictated");
    // Positive control in the same run: while A is on screen and pending, the
    // mirror really does write, so the absence asserted below is a fact about
    // the switch and not about a mirror that never fires in this harness.
    expect(window.localStorage.getItem(`${KEY_PREFIX}agentA`)).not.toBeNull();
    expect(mirrorPasses.some((p) => p.wrote)).toBe(true);

    await render("agentB");

    // The exact poisoning: B's slot holding A's text, stamped as B's.
    expect(window.localStorage.getItem(`${KEY_PREFIX}agentB`)).toBeNull();
    // A's own record is gone too, cleared by the delivery, so it cannot be
    // recovered and delivered a second time.
    expect(window.localStorage.getItem(`${KEY_PREFIX}agentA`)).toBeNull();
    // And nothing under any other key is holding it either.
    for (const [key, raw] of allRecords()) {
      expect(raw, `record at ${key}`).not.toContain("text for agentA");
    }
  });

  it("still delivers the old thread's batch, to the old thread, with its own dictated flag", async () => {
    await render("agentA");
    await click("submit-dictated");
    await render("agentB");

    expect(deliveries).toEqual([
      { body: "text for agentA", targetAgent: "agentA", dictated: true },
    ]);
  });

  it("cannot leave a poisoned record for the new thread's recovery to deliver", async () => {
    await render("agentA");
    await click("submit-dictated");
    await render("agentB");

    // The delayed half of the incident: recovery on B, once the record is old
    // enough to look abandoned, POSTs it as a genuine compose. Nothing to find.
    const later = takeRecoveredBatch("agentB", Date.now() + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(later.recovered).toBeNull();
    expect(later.expired).toBeNull();

    // Control: a record that genuinely IS agentB's is still recovered, so the
    // null above is the poisoning being absent, not recovery being broken.
    saveBatch("agentB", ["a real abandoned batch"], false, Date.now());
    const real = takeRecoveredBatch("agentB", Date.now() + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(real.recovered!.paragraphs).toEqual(["a real abandoned batch"]);
  });

  it("keeps mirroring normally for the thread that owns the batch", async () => {
    // The guard must not have bought correctness by disabling durability. A
    // batch composed on the thread on screen is still mirrored, on every submit.
    await render("agentA");
    await click("submit-dictated");
    await click("submit-dictated");

    const record = JSON.parse(window.localStorage.getItem(`${KEY_PREFIX}agentA`)!);
    expect(record.agentKey).toBe("agentA");
    expect(record.paragraphs).toEqual(["text for agentA", "text for agentA"]);
    expect(record.dictated).toBe(true);
    expect(deliveries).toHaveLength(0);
  });

  it("flushes the pending batch, addressed by owner, on the thread that owns it", async () => {
    // The base case only: agentA is on screen AND owns the batch, so this would
    // pass with the flush addressed either way. It is here to pin that the
    // beacon still flushes at all, with the right body - NOT the switch gap. The
    // test below is the one with teeth on the addressing (CodeRabbit: the old
    // comment here described a switch this body never crosses).
    await render("agentA");
    await click("submit-dictated");
    await click("beacon");
    expect(beaconTargets).toEqual([{ owner: "agentA", body: "text for agentA" }]);
  });

  it("addresses a flush landing INSIDE the switch commit to the owner, not the new thread", async () => {
    // The divergence, verified rather than assumed: at layout-effect time on the
    // A -> B commit, `agent` already reads agentB while durabilityRef still holds
    // agentA's paragraphs. The refresh effect's deps have not changed (the
    // reducer has not been told anything yet) and the passive flush that delivers
    // and clears the ref has not run. It is the ONLY point in this harness where
    // the ref and render scope disagree - one effect later the ref is empty,
    // which is why the previous version of this test could not reach it.
    //
    // Browser reachability is narrower than "any hidden tab in that gap", and the
    // commit message overstated it: the route registers pagehide and
    // visibilitychange in a PASSIVE effect keyed on `agent`, so the handler alive
    // during this window is still the previous one, closing over agentA. The
    // pre-fix code was therefore not observed misdirecting a beacon, and this
    // does not claim to reproduce one.
    //
    // What it does pin is the rule the fix is made of: a flush that reads a batch
    // it does not own follows the BATCH, not the screen. Regress `ownerKey ??
    // agent` back to `agent` and this goes red, which is what stops the beacon
    // path drifting back to render scope the next time this file is edited.
    await render("agentA", true);
    await click("submit-dictated");
    // Armed from mount, so it also ran on the agentA commit - with nothing held,
    // hence no entry. If this is non-empty the switch is not what fired below.
    expect(beaconTargets).toEqual([]);

    await render("agentB", true);

    expect(beaconTargets).toEqual([{ owner: "agentA", body: "text for agentA" }]);
    // And the ordinary switch behaviour is unchanged by the flush: still exactly
    // one delivery, still to agentA, still nothing left under B.
    expect(deliveries).toEqual([
      { body: "text for agentA", targetAgent: "agentA", dictated: true },
    ]);
    expect(window.localStorage.getItem(`${KEY_PREFIX}agentB`)).toBeNull();
  });
});
