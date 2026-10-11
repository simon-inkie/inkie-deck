/**
 * message-chime.test.ts - the chime's pure detection logic.
 *
 * Proves:
 *   1. First render (prev=null) never chimes - history is baseline.
 *   2. A new unread arrival (timestamp advanced + hasUnread) chimes.
 *   3. The user's own send (timestamp advanced, NOT unread) stays silent.
 *   4. An unchanged unread thread does not re-chime every poll.
 *   5. A brand-new agent appearing WITH an unread message chimes.
 */
import { describe, it, expect } from "vitest";
import { detectNewArrivals } from "~/lib/message-chime.js";

const T1 = "2026-06-12T11:00:00Z";
const T2 = "2026-06-12T11:05:00Z";

describe("detectNewArrivals", () => {
  it("baselines on first render - no chime for history", () => {
    expect(
      detectNewArrivals(null, [
        { name: "quill", lastTimestamp: T1, hasUnread: true },
      ])
    ).toEqual([]);
  });

  it("chimes when an agent's unread timestamp advances", () => {
    const prev = new Map([["quill", T1]]);
    expect(
      detectNewArrivals(prev, [
        { name: "quill", lastTimestamp: T2, hasUnread: true },
      ])
    ).toEqual(["quill"]);
  });

  it("stays silent for the user's own send (advanced but read)", () => {
    const prev = new Map([["quill", T1]]);
    expect(
      detectNewArrivals(prev, [
        { name: "quill", lastTimestamp: T2, hasUnread: false },
      ])
    ).toEqual([]);
  });

  it("does not re-chime an unchanged unread thread", () => {
    const prev = new Map([["quill", T2]]);
    expect(
      detectNewArrivals(prev, [
        { name: "quill", lastTimestamp: T2, hasUnread: true },
      ])
    ).toEqual([]);
  });

  it("chimes for a brand-new agent arriving unread", () => {
    const prev = new Map([["quill", T1]]);
    expect(
      detectNewArrivals(prev, [
        { name: "quill", lastTimestamp: T1, hasUnread: false },
        { name: "echo", lastTimestamp: T2, hasUnread: true },
      ])
    ).toEqual(["echo"]);
  });
});
