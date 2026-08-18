/**
 * card-timestamp.test.ts - TASK-719 dated card stamp, at the component level.
 *
 * The Cards tab is a flat list with no day dividers, so a bare clock time gives
 * no age signal: two of Alex's pending cards were already dead (their MRs had
 * merged days earlier) and nothing on screen said so. Timestamp therefore gains
 * an opt-in `withDate`, gated on the Cards-tab `postAction` seam.
 *
 * The load-bearing half of this file is the NON-REGRESSION suite: without the
 * prop, Timestamp must render byte-identically to before, because MessageBubble
 * (thread view), FilesPanel and home all share it and already have their own
 * day dividers.
 *
 * The vitest environment is "node" (no jsdom), but react-dom/server's
 * renderToStaticMarkup renders this component to an HTML string without a DOM,
 * so we pin the actual output rather than inspecting source. Same technique as
 * markdown-image-link.test.ts.
 *
 * No JSX here: the file is a .test.ts, so the element is built with
 * React.createElement.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect } from "vitest";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoutesStub } from "react-router";
import { parseBlock } from "~/lib/blocks/parse";
import { Timestamp } from "~/components/Timestamp";
import { DecisionCard } from "~/components/DecisionCard";
import { ActionCard } from "~/components/ActionCard";

const NOW = "2026-07-24T12:00:00Z";

/**
 * Renders Timestamp to a static HTML string.
 *
 * Note on the pinned markup below: react-dom/server emits the time attribute
 * as authored ("dateTime"), not lowercased. HTML attribute names are
 * case-insensitive, so this is the same attribute the browser sees.
 */
function render(props: { iso: string; now?: string; withDate?: boolean }): string {
  return renderToStaticMarkup(React.createElement(Timestamp, props));
}

const CLASSES = "font-mono text-[11px] uppercase tracking-wide text-muted-foreground";

describe("Timestamp without withDate (non-regression: thread view untouched)", () => {
  it("renders exactly the clock-time markup it rendered before TASK-719", () => {
    // 14:30Z in June is 15:30 BST; title is the relative phrasing; the ISO stays
    // on the machine-readable dateTime attribute.
    expect(render({ iso: "2026-06-04T14:30:00Z", now: "2026-06-06T14:30:00Z" })).toBe(
      `<time dateTime="2026-06-04T14:30:00Z" title="2 days ago" class="${CLASSES}">15:30</time>`
    );
  });

  it("still renders the bare clock time for a card far older than 48h", () => {
    // The exact case that would flip to a dated stamp if the prop leaked.
    const html = render({ iso: "2026-07-19T09:40:00Z", now: NOW });
    expect(html).toContain(">10:40</time>");
    expect(html).not.toContain("19 Jul");
  });

  it("renders nothing visible (and does not throw) for an unparseable timestamp", () => {
    expect(() => render({ iso: "not-a-date", now: NOW })).not.toThrow();
    expect(render({ iso: "not-a-date", now: NOW })).toBe(
      `<time dateTime="not-a-date" title="" class="${CLASSES}"></time>`
    );
  });
});

describe("Timestamp with withDate (Cards tab)", () => {
  it("shows the relative age while the card is fresh", () => {
    const html = render({ iso: "2026-07-24T10:00:00Z", now: NOW, withDate: true });
    expect(html).toContain(">about 2 hours ago</time>");
  });

  it("shows an absolute London stamp once the card is 48h or older", () => {
    const html = render({ iso: "2026-07-19T09:40:00Z", now: NOW, withDate: true });
    expect(html).toContain(">19 Jul, 10:40</time>");
  });

  it("puts the full absolute timestamp (with year) on the hover title", () => {
    const html = render({ iso: "2026-07-19T09:40:00Z", now: NOW, withDate: true });
    expect(html).toContain('title="19 Jul 2026, 10:40 (5 days ago)"');
  });

  it("keeps the machine-readable dateTime attribute", () => {
    const html = render({ iso: "2026-07-19T09:40:00Z", now: NOW, withDate: true });
    expect(html).toContain('dateTime="2026-07-19T09:40:00Z"');
  });

  it("withDate={false} is identical to omitting the prop (the Boolean(postAction) off-path)", () => {
    const off = render({ iso: "2026-07-19T09:40:00Z", now: NOW, withDate: false });
    const bare = render({ iso: "2026-07-19T09:40:00Z", now: NOW });
    expect(off).toBe(bare);
  });

  it("does not throw on an unparseable timestamp", () => {
    expect(() => render({ iso: "not-a-date", now: NOW, withDate: true })).not.toThrow();
    expect(render({ iso: "not-a-date", now: NOW, withDate: true })).toContain('title=""');
  });

  // The component turns the `now` prop into a Date with no validation, so a
  // garbage value reaches the helpers as an Invalid Date. Before the sink guard
  // in time.ts this threw RangeError out of formatCardTooltip and took the page
  // down with it. The stamp itself is still perfectly readable, so the render
  // must survive on the wall clock rather than blank out.
  it("renders (does not throw) when the now prop is garbage", () => {
    expect(() =>
      render({ iso: "2026-07-19T09:40:00Z", now: "not-a-date", withDate: true })
    ).not.toThrow();
    const html = render({ iso: "2026-07-19T09:40:00Z", now: "not-a-date", withDate: true });
    expect(html).toContain('dateTime="2026-07-19T09:40:00Z"');
    expect(html).toContain("19 Jul 2026, 10:40 (");
  });
});

// ---------------------------------------------------------------------------
// Card-level wiring (Atlas peer review): the tests above prove Timestamp CAN
// date, never that the cards ASK it to. Without these, deleting all four
// withDate={Boolean(postAction)} call sites leaves the suite green.
//
// Both cards call useFetcher, so they need a data-router context: createRoutesStub
// supplies one and renders under renderToStaticMarkup in the node env, no jsdom.
// Blocks come from the real parseBlock rather than a hand-built object literal,
// so the fixture cannot drift from the parser's actual output shape.
// ---------------------------------------------------------------------------

/** Fixed clock. The blocks below are timestamped 3 days back, well past 48h. */
const CARD_NOW = "2026-07-25T12:00:00Z";

const DECISION_RAW = [
  `## 2026-07-22T13:40:00Z - from: scribe - status: sent - subject: ad spend decision`,
  `decision-id: TASK-500-q1`,
  `options:`,
  `  - key: A`,
  `    label: "Hold"`,
  `    detail: "Conservative."`,
  ``,
  `Choose a spend level.`,
  ``,
].join("\n");

const ACTION_RAW = [
  `## 2026-07-22T13:40:00Z - from: quill - status: sent - subject: review the spec`,
  `action-id: TASK-500-review`,
  `priority: high`,
  ``,
  `Please review before merge.`,
  ``,
].join("\n");

/** Renders a card inside a stub data router and returns the static HTML. */
function renderCard(element: React.ReactElement): string {
  const Stub = createRoutesStub([{ path: "/", Component: () => element }]);
  return renderToStaticMarkup(React.createElement(Stub, {}));
}

describe("DecisionCard passes withDate on the Cards-tab seam", () => {
  const block = parseBlock(DECISION_RAW);

  it("renders the dated stamp when postAction is set (Cards tab)", () => {
    const html = renderCard(
      React.createElement(DecisionCard, { block, now: CARD_NOW, postAction: "/threads/scribe" })
    );
    expect(html).toContain(">22 Jul, 14:40</time>");
    expect(html).toContain('title="22 Jul 2026, 14:40 (3 days ago)"');
  });

  it("renders the bare clock time when postAction is omitted (thread view)", () => {
    const html = renderCard(React.createElement(DecisionCard, { block, now: CARD_NOW }));
    expect(html).toContain(">14:40</time>");
    expect(html).not.toContain("22 Jul,");
  });

  // The thread view sets postAction too (that is what reveals Dismiss and
  // Supersede inline), so the case above no longer models what
  // threads.$agent.tsx actually renders. This pins the real shape: postAction
  // set AND withDate false. Without it, re-coupling the stamp format to
  // postAction leaves the suite green while every card in the thread silently
  // grows a date the surrounding bubbles do not have.
  it("renders the bare clock time in the thread view's actual shape (postAction set, withDate false)", () => {
    const html = renderCard(
      React.createElement(DecisionCard, {
        block,
        now: CARD_NOW,
        postAction: "/threads/scribe",
        withDate: false,
      })
    );
    expect(html).toContain(">14:40</time>");
    expect(html).not.toContain("22 Jul,");
  });
});

describe("ActionCard passes withDate on the Cards-tab seam", () => {
  const block = parseBlock(ACTION_RAW);

  it("renders the dated stamp when postAction is set (Cards tab)", () => {
    const html = renderCard(
      React.createElement(ActionCard, { block, now: CARD_NOW, postAction: "/threads/quill" })
    );
    expect(html).toContain(">22 Jul, 14:40</time>");
    expect(html).toContain('title="22 Jul 2026, 14:40 (3 days ago)"');
  });

  it("renders the bare clock time when postAction is omitted (thread view)", () => {
    const html = renderCard(React.createElement(ActionCard, { block, now: CARD_NOW }));
    expect(html).toContain(">14:40</time>");
    expect(html).not.toContain("22 Jul,");
  });

  // Same as the DecisionCard case above: the thread view sets postAction (for
  // Supersede) and pins withDate false, so this is the shape the route really
  // renders.
  it("renders the bare clock time in the thread view's actual shape (postAction set, withDate false)", () => {
    const html = renderCard(
      React.createElement(ActionCard, {
        block,
        now: CARD_NOW,
        postAction: "/threads/quill",
        withDate: false,
      })
    );
    expect(html).toContain(">14:40</time>");
    expect(html).not.toContain("22 Jul,");
  });
});

// Both cards render a SECOND Timestamp in their collapsed/resolved variant (a
// dismissed decision, a done action), which is a separate call site from the
// open-card header banner above. These pin the other two of the four.
const DECISION_DISMISSED_RAW = [
  `## 2026-07-22T13:40:00Z - from: scribe - status: read - subject: ad spend decision`,
  `decision-id: TASK-500-q1`,
  `dismissed: 2026-07-24T09:00:00Z`,
  `options:`,
  `  - key: A`,
  `    label: "Hold"`,
  `    detail: "Conservative."`,
  ``,
  `Choose a spend level.`,
  ``,
].join("\n");

const ACTION_DONE_RAW = [
  `## 2026-07-22T13:40:00Z - from: quill - status: read - subject: review the spec`,
  `action-id: TASK-500-review`,
  `done: 2026-07-24T09:00:00Z`,
  ``,
  `Please review before merge.`,
  ``,
].join("\n");

describe("resolved card variants pass withDate too (the other two call sites)", () => {
  it("DecisionCard: dismissed card dates its stamp on the Cards tab only", () => {
    const block = parseBlock(DECISION_DISMISSED_RAW);
    const withPost = renderCard(
      React.createElement(DecisionCard, { block, now: CARD_NOW, postAction: "/threads/scribe" })
    );
    expect(withPost).toContain(">22 Jul, 14:40</time>");
    const without = renderCard(React.createElement(DecisionCard, { block, now: CARD_NOW }));
    expect(without).toContain(">14:40</time>");
    expect(without).not.toContain("22 Jul,");
  });

  it("ActionCard: done card dates its stamp on the Cards tab only", () => {
    const block = parseBlock(ACTION_DONE_RAW);
    const withPost = renderCard(
      React.createElement(ActionCard, { block, now: CARD_NOW, postAction: "/threads/quill" })
    );
    expect(withPost).toContain(">22 Jul, 14:40</time>");
    const without = renderCard(React.createElement(ActionCard, { block, now: CARD_NOW }));
    expect(without).toContain(">14:40</time>");
    expect(without).not.toContain("22 Jul,");
  });
});
