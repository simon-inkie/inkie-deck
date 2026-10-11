import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLAIM_KEY_PREFIX,
  KEY_PREFIX,
  MAX_RECOVERY_AGE_MS,
  MIN_RECOVERY_AGE_MS,
  clearBatch,
  flushViaBeacon,
  mirrorPendingBatch,
  saveBatch,
  shouldMirrorBatch,
  takeRecoveredBatch,
} from "~/lib/batch-durability";

/**
 * Cover for a delivery defect: a message that was never written anywhere
 * because it only ever existed in the browser tab that composed it. The operator lost a link this way.
 */

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(k: string) {
    return this.map.has(k) ? (this.map.get(k) as string) : null;
  }
  key(i: number) {
    return Array.from(this.map.keys())[i] ?? null;
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
}

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.stubGlobal("window", { localStorage: new MemoryStorage() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("batch durability mirror", () => {
  it("survives the tab: a saved batch is recoverable", () => {
    saveBatch("quill", ["the link", "and the ask"], false, NOW);
    const { recovered } = takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(recovered).not.toBeNull();
    expect(recovered!.agentKey).toBe("quill");
    expect(recovered!.paragraphs).toEqual(["the link", "and the ask"]);
  });

  it("recovers AT MOST ONCE: draining removes the record", () => {
    // A duplicate is indistinguishable from a repeated instruction to the
    // reader, so at-most-once beats at-least-once here.
    saveBatch("quill", ["only once"], false, NOW);
    expect(takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t").recovered).not.toBeNull();
    expect(takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t").recovered).toBeNull();
  });

  it("only ever touches its OWN thread (never reads or deletes another agent's)", () => {
    saveBatch("quill", ["for quill"], false, NOW);
    saveBatch("atlas", ["for atlas"], false, NOW);
    const r = takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(r.recovered!.agentKey).toBe("quill");
    // atlas's record must be untouched, not delivered and not deleted.
    const stillThere = takeRecoveredBatch("atlas", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(stillThere.recovered!.paragraphs).toEqual(["for atlas"]);
  });

  it("clears on delivery so a delivered batch is never resurrected", () => {
    saveBatch("quill", ["delivered"], false, NOW);
    clearBatch("quill");
    expect(takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t").recovered).toBeNull();
  });

  it("an emptied batch clears rather than persisting an empty record", () => {
    saveBatch("quill", ["x"], false, NOW);
    saveBatch("quill", [], false, NOW);
    expect(takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t").recovered).toBeNull();
  });

  it("ages out stale batches instead of delivering them days later", () => {
    saveBatch("quill", ["ancient"], false, NOW);
    const { recovered, expired } = takeRecoveredBatch("quill", NOW + MAX_RECOVERY_AGE_MS + 1, "t");
    expect(recovered).toBeNull();
    expect(expired).not.toBeNull();
  });

  it("leaves a LIVE tab's batch alone (cross-tab: do not send someone's half-written message)", () => {
    saveBatch("quill", ["still typing"], false, NOW);
    // A second tab mounting moments later must not drain it.
    const fresh = takeRecoveredBatch("quill", NOW + 1000, "t");
    expect(fresh.recovered).toBeNull();
    expect(fresh.skippedLive).toBe(true);
    // And it must still be there afterwards.
    const later = takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(later.recovered).not.toBeNull();
    expect(later.recovered!.paragraphs).toEqual(["still typing"]);
  });

  it("preserves the dictation flag across recovery", () => {
    saveBatch("quill", ["spoken"], true, NOW);
    expect(takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t").recovered!.dictated).toBe(true);
  });

  it("survives a corrupt record without throwing, and removes it", () => {
    window.localStorage.setItem(`${KEY_PREFIX}quill`, "{not json");
    expect(() => takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t")).not.toThrow();
    expect(window.localStorage.getItem(`${KEY_PREFIX}quill`)).toBeNull();
  });

  it("never throws when storage is unavailable (private mode / SSR)", () => {
    vi.stubGlobal("window", undefined);
    expect(() => saveBatch("quill", ["x"], false, NOW)).not.toThrow();
    expect(() => clearBatch("quill")).not.toThrow();
    expect(takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t").recovered).toBeNull();
  });

  it("an empty saveBatch WIPES the mirror, which is why recovery must run first", () => {
    // Review finding: on mount pendingBatch.paragraphs is [] because the
    // hook knows nothing about a prior session. If the mirror effect runs before
    // the recovery effect, this call destroys the record recovery was about to
    // read, and reopening the SAME thread recovers nothing - the exact scenario
    // the feature exists for. This test pins the destructive property so the
    // ordering constraint in threads.$agent.tsx is never "tidied" away.
    saveBatch("quill", ["the link"], false, NOW);
    saveBatch("quill", [], false, NOW); // what an ungated mount effect does
    expect(
      takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t").recovered
    ).toBeNull();
  });

  it("a losing claim leaves the record for the winner rather than deleting it", () => {
    saveBatch("quill", ["contested"], false, NOW);
    // Simulate another tab winning: its token is already in the claim slot and
    // stays there, so our read-back mismatches.
    const s = window.localStorage;
    const realSet = s.setItem.bind(s);
    s.setItem = (k: string, v: string) => {
      realSet(k, k.startsWith(CLAIM_KEY_PREFIX) ? "other-tab" : v);
    };
    const r = takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "mine");
    s.setItem = realSet;
    expect(r.recovered).toBeNull();
    // The record must survive for whoever did win the claim.
    expect(s.getItem(`${KEY_PREFIX}quill`)).not.toBeNull();
  });

  it("a claim-key cleanup failure does not discard the already-claimed record", () => {
    // Review finding: setItem(claimKey)/removeItem(key)/
    // removeItem(claimKey) used to share one try block. If the FIRST removeItem
    // (the actual record) succeeded but the second (claim-key cleanup) threw,
    // the catch returned none and the already-recovered record was discarded -
    // gone from storage AND gone from the return value. This pins that a claim
    // cleanup failure after a successful record removal still returns the batch.
    saveBatch("quill", ["do not lose me"], false, NOW);
    const s = window.localStorage;
    const realRemove = s.removeItem.bind(s);
    s.removeItem = (k: string) => {
      if (k.startsWith(CLAIM_KEY_PREFIX)) throw new Error("quota");
      realRemove(k);
    };
    const r = takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    s.removeItem = realRemove;
    expect(r.recovered).not.toBeNull();
    expect(r.recovered!.paragraphs).toEqual(["do not lose me"]);
  });

  it("a data key and a claim key can never collide, whatever the agentKey", () => {
    // Review finding: the claim key used to be `${dataKey}.claim`,
    // so agentKey "a.claim" produced the same string as agentKey "a"'s claim key.
    // Recovering one agent could then claim/delete another's record. The two
    // prefixes now diverge before any agentKey-controlled text appears, so no
    // agentKey value can construct a collision.
    saveBatch("a", ["a's message"], false, NOW);
    saveBatch("a.claim", ["a.claim's message"], false, NOW);
    const forA = takeRecoveredBatch("a", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(forA.recovered!.paragraphs).toEqual(["a's message"]);
    const forAClaim = takeRecoveredBatch("a.claim", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(forAClaim.recovered!.paragraphs).toEqual(["a.claim's message"]);
  });
});

describe("storage key version", () => {
  it("is v2, so every record the pre-2026-07-29 writer left behind is inert", () => {
    // The bump IS the defusal. Poisoned v1 records (thread A's text stamped as
    // thread B's) are indistinguishable from good ones, and they are already
    // sitting in users' browsers waiting for recovery to deliver
    // them to the wrong inbox. Reading under a new prefix is what makes them
    // permanently unreachable; a code fix alone cannot unwrite them.
    expect(KEY_PREFIX).toBe("mc.pendingBatch.v2.");
    expect(CLAIM_KEY_PREFIX).toBe("mc.pendingBatchClaim.v2.");
  });

  it("cannot read a v1 record, however well-formed", () => {
    const poisoned = JSON.stringify({
      agentKey: "atlas", // stamped as atlas...
      paragraphs: ["a message the user typed to quill"], // ...carrying quill's text
      dictated: false,
      savedAt: NOW,
    });
    window.localStorage.setItem("mc.pendingBatch.v1.atlas", poisoned);
    const r = takeRecoveredBatch("atlas", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(r.recovered).toBeNull();
    expect(r.expired).toBeNull();
    expect(r.skippedLive).toBe(false);
    // Left in place rather than tidied: a dead localStorage key costs nothing,
    // and reading one to delete it is the code path being retired.
    expect(window.localStorage.getItem("mc.pendingBatch.v1.atlas")).toBe(poisoned);
  });

  it("the two prefixes still diverge before any agentKey text", () => {
    // The v1 property that stopped agentKey "a.claim" colliding with agent "a"'s
    // claim key has to survive the bump.
    expect(CLAIM_KEY_PREFIX.startsWith(KEY_PREFIX)).toBe(false);
    expect(KEY_PREFIX.startsWith(CLAIM_KEY_PREFIX)).toBe(false);
  });
});

describe("shouldMirrorBatch (the route's per-render mirror-effect guard)", () => {
  it("mirrors once recovery is done and there is something to mirror", () => {
    expect(shouldMirrorBatch(true, 1, "quill", "quill")).toBe(true);
    expect(shouldMirrorBatch(true, 3, "quill", "quill")).toBe(true);
  });

  it("never mirrors before recovery has had its turn", () => {
    expect(shouldMirrorBatch(false, 1, "quill", "quill")).toBe(false);
  });

  it("never mirrors a batch belonging to a thread other than the rendered one", () => {
    // The deliver-on-switch commit: `agent` already reads the new thread while
    // the reducer state still holds the old thread's paragraphs, because the
    // DELIVERED dispatch cannot re-render until this whole effect flush ends.
    // Mirroring at that moment is how thread A's text got written into thread
    // B's slot. The deliver-on-switch effect has already delivered these
    // paragraphs and cleared their mirror; there is nothing here to save.
    expect(shouldMirrorBatch(true, 1, "agentA", "agentB")).toBe(false);
    // And an unowned batch is never mirrored, whatever is rendered.
    expect(shouldMirrorBatch(true, 1, null, "agentB")).toBe(false);
  });

  it("never mirrors an empty batch, which is why an empty saveBatch cannot be a side effect of a mount", () => {
    // Review finding: a SECOND tab mounting on the same agent
    // thread starts with paragraphCount 0. Its own first pass through the
    // mirror effect used to call saveBatch(agent, [], ...) unconditionally,
    // which clearBatch's - wiping a FIRST tab's live, not-yet-delivered
    // mirror that takeRecoveredBatch had correctly just left alone
    // (skippedLive) moments earlier in the SAME mount. This pins that the
    // guard refuses to mirror an empty batch under any recovery state, so
    // that clearing on empty can only ever be an explicit caller decision
    // (delivery, cancel), never an accident of paragraphCount being 0.
    expect(shouldMirrorBatch(true, 0, "quill", "quill")).toBe(false);
    expect(shouldMirrorBatch(false, 0, "quill", "quill")).toBe(false);
  });
});

describe("mirrorPendingBatch (guard plus write, so the key is not the caller's to pick)", () => {
  it("writes under the batch's OWN key", () => {
    const wrote = mirrorPendingBatch(
      { ownerKey: "quill", paragraphs: ["mine"], dictated: true },
      true,
      "quill",
      NOW
    );
    expect(wrote).toBe(true);
    const r = takeRecoveredBatch("quill", NOW + MIN_RECOVERY_AGE_MS + 1, "t");
    expect(r.recovered!.agentKey).toBe("quill");
    // The payload, not just its labels: the owner-keyed write exists to get this
    // text back to the right thread, so a round-trip that lost it would be no
    // use however correctly it was addressed.
    expect(r.recovered!.paragraphs).toEqual(["mine"]);
    expect(r.recovered!.dictated).toBe(true);
  });

  it("writes NOTHING ANYWHERE when the rendered thread is not the owner", () => {
    // The incident, at storage level: agentA's paragraphs, agentB on screen.
    // Neither slot may end up holding them - not agentB's (the mislabel that
    // misdirected three of the operator's messages) and not agentA's either (the
    // deliver-on-switch effect has already delivered and cleared them, so
    // re-writing agentA's record would resurrect a delivered batch).
    const wrote = mirrorPendingBatch(
      { ownerKey: "agentA", paragraphs: ["text for agentA"], dictated: false },
      true,
      "agentB",
      NOW
    );
    expect(wrote).toBe(false);
    expect(window.localStorage.getItem(`${KEY_PREFIX}agentB`)).toBeNull();
    expect(window.localStorage.getItem(`${KEY_PREFIX}agentA`)).toBeNull();
  });

  it("does not write an unowned batch even onto the thread that is rendered", () => {
    expect(
      mirrorPendingBatch({ ownerKey: null, paragraphs: ["orphan"], dictated: false }, true, "quill", NOW)
    ).toBe(false);
    expect(window.localStorage.getItem(`${KEY_PREFIX}quill`)).toBeNull();
  });

  it("still refuses before recovery and on an empty batch", () => {
    expect(
      mirrorPendingBatch({ ownerKey: "quill", paragraphs: ["x"], dictated: false }, false, "quill", NOW)
    ).toBe(false);
    expect(
      mirrorPendingBatch({ ownerKey: "quill", paragraphs: [], dictated: false }, true, "quill", NOW)
    ).toBe(false);
    expect(window.localStorage.getItem(`${KEY_PREFIX}quill`)).toBeNull();
  });
});

describe("beacon flush", () => {
  it("posts the compose payload and reports acceptance", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon });
    const ok = flushViaBeacon("/threads/quill", "the body", true, "quill");
    expect(ok).toBe(true);
    const [url, fd] = sendBeacon.mock.calls[0]!;
    expect(url).toBe("/threads/quill");
    expect((fd as FormData).get("intent")).toBe("compose");
    expect((fd as FormData).get("body")).toBe("the body");
    expect((fd as FormData).get("dictated")).toBe("1");
    expect((fd as FormData).get("targetAgent")).toBe("quill");
  });

  it("reports false when the browser refuses, which is why the mirror exists", () => {
    vi.stubGlobal("navigator", { sendBeacon: vi.fn().mockReturnValue(false) });
    expect(flushViaBeacon("/threads/quill", "body", false, "quill")).toBe(false);
  });

  it("does not beacon an empty body", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    vi.stubGlobal("navigator", { sendBeacon });
    expect(flushViaBeacon("/threads/quill", "", false, "quill")).toBe(false);
    expect(sendBeacon).not.toHaveBeenCalled();
  });

  it("degrades quietly where sendBeacon is unavailable", () => {
    vi.stubGlobal("navigator", {});
    expect(flushViaBeacon("/threads/quill", "body", false, "quill")).toBe(false);
  });
});
