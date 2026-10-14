/**
 * card-reply-link.test.ts
 *
 * Unit tests for the cross-route "reply to this card" deep link: the href the
 * Cards tab builds, and the predicate the thread route validates it with.
 *
 * WHAT THIS PROTECTS. "OR write something..." on a card rendered inline in its
 * own thread just lifts state on a mounted component. The same button on the
 * CARDS TAB crosses a route boundary, the thread component mounts fresh, and
 * the reply context has to travel in the URL or it is gone - which is exactly
 * what went wrong: the navigation carried ?anchor (scroll only) and nothing
 * else, so the user's typed answer left as a plain chat message instead of the
 * card's option-C answer.
 *
 * The href tests are named for the OUTCOME (the link carries the reply context
 * / does not disturb the window cursor), not for the string it happens to
 * produce, so the assertions cannot be inverted without the name going wrong.
 *
 * ASCII only.
 */
import { describe, it, expect } from "vitest";
import {
  ANCHOR_PARAM,
  REPLY_PARAM,
  buildCardReplyHref,
  canSeedCardReply,
  type CardReplyCandidateBlock,
} from "~/lib/card-reply-link";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function openCard(decisionId: string): CardReplyCandidateBlock {
  return { card: { decisionId } };
}

function plainBlock(): CardReplyCandidateBlock {
  return {};
}

/** Parse the href the way the browser + router would, so the tests assert on
 *  the parts that actually reach the loader and the component. */
function parts(href: string): {
  pathname: string;
  params: URLSearchParams;
  hash: string;
} {
  const url = new URL(href, "http://mc.test");
  return {
    pathname: url.pathname,
    params: url.searchParams,
    hash: decodeURIComponent(url.hash.slice(1)),
  };
}

// ---------------------------------------------------------------------------
// buildCardReplyHref
// ---------------------------------------------------------------------------

describe("buildCardReplyHref", () => {
  it("carries the reply context across the route boundary", () => {
    const { pathname, params } = parts(
      buildCardReplyHref("scribe", "TASK-413-q1")
    );
    expect(pathname).toBe("/threads/scribe");
    // The whole point of the fix: the thread page is told WHICH card is being
    // answered, not merely where to scroll.
    expect(params.get(REPLY_PARAM)).toBe("TASK-413-q1");
  });

  it("still extends the loader window and scrolls to the card", () => {
    const { params, hash } = parts(buildCardReplyHref("scribe", "TASK-413-q1"));
    // anchor is a LOADER input (windowed thread loading). Losing it would shrink the
    // read window back to the tail and unmount the card being answered.
    expect(params.get(ANCHOR_PARAM)).toBe("TASK-413-q1");
    expect(hash).toBe("TASK-413-q1");
  });

  it("survives ids and agent names that need escaping", () => {
    const { pathname, params, hash } = parts(
      buildCardReplyHref("scribe", "a b&c=d#e")
    );
    expect(pathname).toBe("/threads/scribe");
    expect(params.get(REPLY_PARAM)).toBe("a b&c=d#e");
    expect(params.get(ANCHOR_PARAM)).toBe("a b&c=d#e");
    expect(hash).toBe("a b&c=d#e");
  });
});

// ---------------------------------------------------------------------------
// canSeedCardReply - a decisionId in the URL is user input, not a fact
// ---------------------------------------------------------------------------

describe("canSeedCardReply", () => {
  it("opens reply mode for a card this thread is still waiting on", () => {
    expect(canSeedCardReply([openCard("TASK-413-q1")], "TASK-413-q1")).toBe(true);
  });

  it("leaves the composer ordinary when the id belongs to no loaded card", () => {
    // The stale-link case: the card was long ago archived out of this thread,
    // or the id came from a hand-edited URL, or it is another agent's card.
    expect(
      canSeedCardReply([openCard("TASK-413-q1"), plainBlock()], "TASK-999-gone")
    ).toBe(false);
  });

  it("leaves the composer ordinary when the card is already answered", () => {
    expect(
      canSeedCardReply(
        [{ card: { decisionId: "TASK-413-q1", answered: "B" } }],
        "TASK-413-q1"
      )
    ).toBe(false);
  });

  it("leaves the composer ordinary when the card was dismissed", () => {
    expect(
      canSeedCardReply(
        [{ card: { decisionId: "d1", dismissed: "2026-08-05T10:00:00Z" } }],
        "d1"
      )
    ).toBe(false);
  });

  it("leaves the composer ordinary when the card was superseded", () => {
    expect(
      canSeedCardReply(
        [{ card: { decisionId: "d1", superseded: "2026-08-05T10:00:00Z" } }],
        "d1"
      )
    ).toBe(false);
  });

  it("leaves the composer ordinary when there is no seed at all", () => {
    // The overwhelmingly common case - every ordinary thread open.
    expect(canSeedCardReply([openCard("d1")], null)).toBe(false);
    expect(canSeedCardReply([openCard("d1")], undefined)).toBe(false);
    expect(canSeedCardReply([openCard("d1")], "")).toBe(false);
  });

  it("leaves the composer ordinary on an empty thread", () => {
    expect(canSeedCardReply([], "d1")).toBe(false);
  });
});
