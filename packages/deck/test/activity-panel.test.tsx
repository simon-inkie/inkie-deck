// @vitest-environment jsdom
/**
 * activity-panel.test.tsx - what the Team tab actually SHOWS.
 *
 * A render test rather than a props-shape test, because every claim this panel
 * makes is a claim about the DOM: that a pill never appears without the
 * evidence behind it, that `unknown` cannot be mistaken for a verdict, that a
 * stale file produces an honest "offline since HH:MM" and NOT a wall of
 * confident pills, and that the runner-up worktrees are reachable rather than
 * dropped. None of those are observable from the view-model alone.
 *
 * Weighted, like the seam suite, towards the offline branches: the sweep is not
 * on cron yet, so those are the states a user will actually see first.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { ActivityPanel } from "~/components/ActivityPanel";
import { formatClockTime } from "~/lib/time";
import type {
  ActivityView,
  AgentActivity,
  AgentWorktree,
} from "~/lib/activity.shared";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = "2026-07-30T10:15:00Z";
const SWEPT = "2026-07-30T10:14:30Z";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

/**
 * The panel links to each agent's live pane, so it needs a router
 * around it. createRoutesStub is the react-router-supported harness for exactly
 * this: real Link behaviour (a real href, real navigation) without a route
 * module or a loader. Rendering the panel bare would now throw.
 */
function renderInRouter(node: React.ReactElement): void {
  const Stub = createRoutesStub([{ path: "/tmux", Component: () => node }]);
  act(() => {
    root.render(<Stub initialEntries={["/tmux"]} />);
  });
}

function render(view: ActivityView): void {
  renderInRouter(<ActivityPanel activity={view} now={NOW} avatars={{}} />);
}

function el(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function click(testId: string): void {
  const node = el(testId);
  if (node === null) throw new Error(`no element with testid ${testId}`);
  act(() => {
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function worktree(over: Partial<AgentWorktree> = {}): AgentWorktree {
  return {
    path: "/home/you/git-repos/inkie-summit",
    branch: "summit/task-599-video-poster-backfill",
    confidence: "low",
    score: 96,
    reasons: ["branch-prefix=summit/", "worktree-name=inkie-summit"],
    alternatives: [
      {
        path: "/home/you/git-repos/inkie-briar3",
        branch: "summit/task-663-gemini-flash-pricing",
        score: 95,
      },
    ],
    pinned: false,
    pinnedBy: null,
    pinnedAt: null,
    guess: null,
    ...over,
  };
}

function agent(over: Partial<AgentActivity> = {}): AgentActivity {
  return {
    agent: "summit",
    status: "done-for-now",
    signal: "idle-no-signal",
    evidence: "idle since 10:12, no open cards and no unread outbound",
    busy: false,
    idleMinutes: 3,
    worktree: worktree(),
    recent: [
      {
        key: "inbox:alex.md:2026-07-30T09:58:58Z",
        at: "2026-07-30T09:58:58Z",
        kind: "inbox",
        label: "Both done. Deck restarted earlier.",
        ref: "alex.md",
      },
    ],
    updated: SWEPT,
    subagentCount: null,
    inference: null,
    ...over,
  };
}

function live(agents: AgentActivity[]): ActivityView {
  return { state: "live", sweptAt: SWEPT, agents, notes: [], generator: "activity-sweep" };
}

// ---------------------------------------------------------------------------
// The live panel
// ---------------------------------------------------------------------------

describe("ActivityPanel - live sweep", () => {
  it("renders one card per agent with its pill", () => {
    render(
      live([
        agent(),
        agent({ agent: "sprout", status: "needs-you", evidence: "card d-91 open since 09:02" }),
        agent({ agent: "quill", status: "working", busy: true, evidence: "pane busy" }),
      ])
    );
    expect(el("activity-panel")?.getAttribute("data-state")).toBe("live");
    for (const name of ["summit", "sprout", "quill"]) {
      expect(el(`activity-agent-${name}`), name).not.toBeNull();
    }
    expect(el("activity-status-sprout")?.getAttribute("data-status")).toBe("needs-you");
    expect(el("activity-status-sprout")?.textContent).toContain("needs you");
    expect(el("activity-status-quill")?.textContent).toContain("working");
  });

  // Requirement: each card offers a button to jump to the agent's thread
  // window. The three claims worth pinning: it goes to the LIVE PANE
  // (not the chat half), it is per-agent, and it sits in the header row where
  // a primary action belongs rather than behind the details toggle.
  it("jumps to that agent's live pane, from the card header, one per card", () => {
    render(live([agent(), agent({ agent: "sprout", status: "needs-you" })]));

    const jump = el("activity-jump-summit");
    expect(jump).not.toBeNull();
    // ?view=tmux is what makes it the terminal and not the messages view.
    expect(jump!.getAttribute("href")).toBe("/threads/summit?view=tmux");
    expect(el("activity-jump-sprout")!.getAttribute("href")).toBe("/threads/sprout?view=tmux");
    // A glyph-only control still has to say what it does.
    expect(jump!.getAttribute("aria-label")).toContain("summit");

    // Header row, beside the pill - NOT inside the (collapsed) details block.
    expect(el("activity-status-summit")!.parentElement!.contains(jump!)).toBe(true);
    expect(el("activity-details-summit")).toBeNull();
  });

  it("offers the jump even on a card with nothing to expand", () => {
    // The no-detail card is the one a details-toggle-shaped implementation
    // would have hidden the jump behind: there is no toggle to open.
    render(live([agent({ agent: "nova", worktree: null, recent: [] })]));
    expect(el("activity-details-toggle-nova")).toBeNull();
    expect(el("activity-jump-nova")?.getAttribute("href")).toBe("/threads/nova?view=tmux");
  });

  it("shows the evidence line WITHOUT any interaction (no pill without its evidence)", () => {
    render(live([agent()]));
    const evidence = el("activity-evidence-summit");
    expect(evidence).not.toBeNull();
    expect(evidence!.textContent).toContain("no open cards and no unread outbound");
  });

  it("falls back to the machine signal when the sweep wrote no evidence sentence", () => {
    render(live([agent({ evidence: "", signal: "idle-no-signal" })]));
    expect(el("activity-evidence-summit")?.textContent).toContain("idle-no-signal");
  });

  it("renders the worktree chip with its branch and a visible confidence", () => {
    render(live([agent()]));
    const chip = el("activity-worktree-summit");
    expect(chip?.getAttribute("data-confidence")).toBe("low");
    expect(chip?.textContent).toContain("inkie-summit");
    expect(chip?.textContent).toContain("summit/task-599-video-poster-backfill");
    expect(el("activity-confidence-summit")?.textContent).toContain("low confidence");
    // The full path is one hover away even though the chip shows the basename.
    expect(chip?.getAttribute("title")).toBe("/home/you/git-repos/inkie-summit");
  });

  it("renders a HIGH confidence chip differently from a LOW one", () => {
    render(live([agent({ agent: "sprout", worktree: worktree({ confidence: "high", score: 92 }) })]));
    expect(el("activity-worktree-sprout")?.getAttribute("data-confidence")).toBe("high");
    expect(el("activity-confidence-sprout")?.textContent).toContain("high confidence");
  });

  it("states 'no worktree resolved' rather than guessing when nothing scored", () => {
    render(
      live([
        agent({
          agent: "fern",
          worktree: worktree({
            path: null,
            branch: null,
            confidence: "none",
            score: 0,
            reasons: ["no candidate worktree scored above zero"],
            alternatives: [],
          }),
        }),
      ])
    );
    const chip = el("activity-worktree-fern");
    expect(chip?.getAttribute("data-confidence")).toBe("none");
    expect(chip?.textContent).toContain("no worktree resolved");
  });

  it("surfaces the alternatives behind the details toggle, with their scores", () => {
    render(live([agent()]));
    // Collapsed: secondary detail is not in the DOM yet.
    expect(el("activity-alternatives-summit")).toBeNull();
    click("activity-details-toggle-summit");
    const alts = el("activity-alternatives-summit");
    expect(alts).not.toBeNull();
    expect(alts!.textContent).toContain("inkie-briar3");
    expect(alts!.textContent).toContain("95");
    // The scorer's reasoning travels with it.
    expect(el("activity-reasons-summit")?.textContent).toContain("branch-prefix=summit/");
  });

  it("shows a pin as a pin, next to what the scorer would have said", () => {
    render(
      live([
        agent({
          agent: "quill",
          worktree: worktree({
            path: "/home/you/git-repos/inkie-quill2",
            branch: "quill/task-691-panel",
            confidence: "pinned",
            score: null,
            pinned: true,
            pinnedBy: "alex",
            reasons: ["pinned override"],
            alternatives: [],
            guess: {
              path: "/home/you/git-repos/inkie-quill",
              branch: "quill/something-else",
              confidence: "low",
              score: 61,
              reasons: [],
              alternatives: [],
            },
          }),
        }),
      ])
    );
    expect(el("activity-confidence-quill")?.textContent).toContain("pinned");
    click("activity-details-toggle-quill");
    const guess = el("activity-pin-guess-quill");
    expect(guess?.textContent).toContain("inkie-quill");
    expect(guess?.textContent).toContain("quill/something-else");
  });

  // A guess is only MEANINGFUL beside a pin, and `asWorktree()` coerces `guess`
  // and `pinned` independently, so a malformed file can set one without the
  // other. These two pin the consequence of that at both ends: the toggle must
  // not appear for a guess it will not render, and when other detail does earn
  // the toggle, the unpinned guess must still stay out of it.
  const unpinnedGuess = worktree({
    pinned: false,
    guess: {
      path: "/home/you/git-repos/inkie-scribe2",
      branch: "scribe/task-663-something",
      confidence: "low",
      score: 41,
      reasons: [],
      alternatives: [],
    },
  });

  it("offers no detail toggle when the only detail is a guess it will not render", () => {
    render(
      live([
        agent({
          agent: "scribe",
          worktree: worktree({ ...unpinnedGuess, reasons: [], alternatives: [] }),
          recent: [],
        }),
      ])
    );
    // The card itself is there; the toggle onto an empty panel is not.
    expect(el("activity-agent-scribe")).not.toBeNull();
    expect(el("activity-details-toggle-scribe")).toBeNull();
    expect(el("activity-details-scribe")).toBeNull();
  });

  it("keeps an unpinned guess out of the details it does open (no pin, no disagreement)", () => {
    render(live([agent({ agent: "scribe", worktree: unpinnedGuess, recent: [] })]));
    // reasons + alternatives earn the toggle here, so it opens onto real content.
    click("activity-details-toggle-scribe");
    expect(el("activity-details-scribe")?.textContent).toContain("branch-prefix=summit/");
    expect(el("activity-pin-guess-scribe")).toBeNull();
    expect(el("activity-details-scribe")?.textContent).not.toContain("inkie-scribe2");
  });

  it("shows the newest completion collapsed and the whole log expanded", () => {
    render(
      live([
        agent({
          recent: [
            { key: "c:1", at: "2026-07-30T10:01:00Z", kind: "commit", label: "newest thing", ref: "wt@1" },
            { key: "c:2", at: "2026-07-30T09:20:00Z", kind: "commit", label: "older thing", ref: "wt@2" },
          ],
        }),
      ])
    );
    expect(el("activity-latest-summit")?.textContent).toContain("newest thing");
    expect(el("activity-recent-summit")).toBeNull();
    click("activity-details-toggle-summit");
    const recent = el("activity-recent-summit");
    expect(recent?.textContent).toContain("newest thing");
    expect(recent?.textContent).toContain("older thing");
  });

  it("summarises the sweep in the header and stamps when it ran", () => {
    render(live([agent(), agent({ agent: "sprout", status: "needs-you" })]));
    const summary = el("activity-summary")?.textContent ?? "";
    expect(summary).toContain("1 needs you");
    expect(summary).toContain("1 idle");
    expect(el("activity-panel")?.textContent).toContain(`swept ${formatClockTime(SWEPT)}`);
  });

  it("collapses the whole panel on the header toggle", () => {
    render(live([agent()]));
    expect(el("activity-grid")).not.toBeNull();
    click("activity-panel-toggle");
    expect(el("activity-grid")).toBeNull();
    expect(el("activity-agent-summit")).toBeNull();
    // The panel itself, and the swept stamp, stay visible.
    expect(el("activity-panel")).not.toBeNull();
  });

  it("says so plainly when a live sweep covered no agents", () => {
    render(live([]));
    expect(el("activity-empty")?.textContent).toContain("covered no agents");
    expect(el("activity-grid")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// unknown is not a verdict
// ---------------------------------------------------------------------------

describe("ActivityPanel - the unknown pill", () => {
  const unswept = agent({
    agent: "nova",
    status: "unknown",
    signal: "not-swept",
    evidence: "no record in the last sweep - the window may have opened since",
    worktree: null,
    recent: [],
  });

  it("reads as 'no observation', never as 'unknown' or as fine", () => {
    render(live([unswept]));
    const pill = el("activity-status-nova");
    expect(pill?.getAttribute("data-status")).toBe("unknown");
    expect(pill?.textContent).toContain("no observation");
    expect(pill?.textContent).not.toContain("done");
  });

  it("is styled distinctly from every real verdict (dashed, no verdict tint)", () => {
    render(live([unswept, agent({ agent: "sprout", status: "done-for-now" })]));
    const unknownClass = el("activity-status-nova")?.className ?? "";
    const doneClass = el("activity-status-sprout")?.className ?? "";
    expect(unknownClass).toContain("border-dashed");
    expect(doneClass).not.toContain("border-dashed");
    expect(unknownClass).not.toBe(doneClass);
  });

  it("still carries its evidence, and offers no detail toggle it cannot fill", () => {
    render(live([unswept]));
    expect(el("activity-evidence-nova")?.textContent).toContain("no record in the last sweep");
    expect(el("activity-details-toggle-nova")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Offline - the branches that actually run today
// ---------------------------------------------------------------------------

describe("ActivityPanel - offline", () => {
  /** A stale view carrying the last document the sweep managed to write. */
  function stale(agents: AgentActivity[]): ActivityView {
    return {
      state: "offline",
      reason: "stale",
      sweptAt: "2026-07-30T07:14:30Z",
      detail: "last sweep was 180 minutes ago (/srv/activity/activity.json)",
      agents,
    };
  }

  it("stale: says offline SINCE the real last-seen time", () => {
    render(stale([]));
    const note = el("activity-offline");
    expect(note?.getAttribute("data-reason")).toBe("stale");
    expect(note?.textContent).toContain(
      `Activity engine offline since ${formatClockTime("2026-07-30T07:14:30Z")}`
    );
    // The observation travels with the verdict.
    expect(note?.textContent).toContain("180 minutes ago");
    // The header summary is a live-only claim and stays out of it.
    expect(el("activity-summary")).toBeNull();
    expect(el("activity-panel")?.textContent).toContain("engine offline");
  });

  it("missing: the state the panel is in RIGHT NOW, until the sweep is on cron", () => {
    render({
      state: "offline",
      reason: "missing",
      sweptAt: null,
      detail: "no state file at /srv/activity/activity.json - the activity sweep has not run yet",
      agents: [],
    });
    const note = el("activity-offline");
    expect(note?.getAttribute("data-reason")).toBe("missing");
    expect(note?.textContent).toContain("Activity engine has not run yet");
    expect(note?.textContent).toContain("/srv/activity/activity.json");
    expect(el("activity-panel")?.textContent).toContain("no data");
    // Nothing readable on disk means nothing to show below the note.
    expect(el("activity-grid")).toBeNull();
  });

  it("corrupt: honest, specific, and not an error boundary", () => {
    render({
      state: "offline",
      reason: "corrupt",
      sweptAt: null,
      detail: "not valid JSON: Unexpected end of JSON input (/srv/activity/activity.json)",
      agents: [],
    });
    const note = el("activity-offline");
    expect(note?.textContent).toContain("Activity state could not be read");
    expect(note?.textContent).toContain("Unexpected end of JSON input");
    expect(el("activity-grid")).toBeNull();
  });

  it("unreadable and unsupported-schema render the same honest shape", () => {
    for (const reason of ["unreadable", "unsupported-schema"] as const) {
      render({ state: "offline", reason, sweptAt: null, detail: `detail for ${reason}`, agents: [] });
      expect(el("activity-offline")?.getAttribute("data-reason")).toBe(reason);
      expect(el("activity-offline")?.textContent).toContain(`detail for ${reason}`);
    }
  });

  it("collapses like the live panel does", () => {
    render({
      state: "offline",
      reason: "missing",
      sweptAt: null,
      detail: "no state file",
      agents: [],
    });
    click("activity-panel-toggle");
    expect(el("activity-offline")).toBeNull();
    expect(el("activity-panel")).not.toBeNull();
  });

  // -------------------------------------------------------------------------
  // Last-known cards under the banner. The rule being pinned: a dead engine
  // costs you the CLAIM, not the DATA. What was true at 07:14 is still shown; what it is
  // not allowed to do is look like a statement about 10:15.
  // -------------------------------------------------------------------------
  describe("stale, with the last document it wrote", () => {
    const agents = [agent(), agent({ agent: "sprout", status: "needs-you" })];

    it("keeps the cards, under the note rather than instead of them", () => {
      render(stale(agents));
      // Both are present, and the note is still the thing above them.
      expect(el("activity-offline")).not.toBeNull();
      expect(el("activity-grid")).not.toBeNull();
      expect(el("activity-agent-summit")).not.toBeNull();
      expect(el("activity-agent-sprout")).not.toBeNull();
      // The facts a dead sweep cannot invalidate travel with them.
      expect(el("activity-worktree-summit")?.textContent).toContain("inkie-summit");
      expect(el("activity-latest-summit")?.textContent).toContain("Both done");
    });

    it("marks the whole grid stale, in data as well as in tint", () => {
      render(stale(agents));
      const grid = el("activity-grid");
      expect(grid?.getAttribute("data-stale")).toBe("true");
      expect(grid?.className).toContain("opacity-");
      expect(el("activity-agent-sprout")?.getAttribute("data-stale")).toBe("true");
    });

    it("strips the verdict tint off the pills: history, not a claim about now", () => {
      render(stale(agents));
      const pill = el("activity-status-sprout");
      // The status is still legible ...
      expect(pill?.getAttribute("data-status")).toBe("needs-you");
      expect(pill?.textContent).toContain("needs you");
      // ... but not in the colour a LIVE needs-you wears, and it says why.
      expect(pill?.getAttribute("data-muted")).toBe("true");
      expect(pill?.getAttribute("title")).toContain("last known");
      expect(pill?.className).not.toContain("bg-accent/15");

      // The comparison that makes that meaningful: the same agent, live.
      render(live(agents));
      const livePill = el("activity-status-sprout");
      expect(livePill?.getAttribute("data-muted")).toBeNull();
      expect(livePill?.className).toContain("bg-accent/15");
    });

    it("says in the banner that the cards below are last-known, not current", () => {
      render(stale(agents));
      const note = el("activity-offline")?.textContent ?? "";
      expect(note).toContain("2 agents");
      expect(note).toContain("last-known");
      // The old copy claimed the opposite of what now renders below it.
      expect(note).not.toContain("Pills are not shown");
    });

    it("still offers the jump to the live pane - the point of a dead sweep", () => {
      render(stale(agents));
      expect(el("activity-jump-summit")?.getAttribute("href")).toBe(
        "/threads/summit?view=tmux"
      );
    });

    it("collapses the stale grid with the panel toggle", () => {
      render(stale(agents));
      click("activity-panel-toggle");
      expect(el("activity-grid")).toBeNull();
      expect(el("activity-offline")).toBeNull();
    });
  });
});

// ---------------------------------------------------------------------------
// Filling the page
//
// jsdom lays nothing out, so these assert the CONTRACT rather than the pixels:
// the panel claims the route column's spare height exactly when it has a grid
// to put in it, and the grid (not the page) is the thing that scrolls. The
// pixels are checked by eye against a real browser, which is what caught the
// stretched-cards case these classes now prevent.
// ---------------------------------------------------------------------------

describe("ActivityPanel - claiming the page height", () => {
  function staleWith(agents: AgentActivity[]): ActivityView {
    return {
      state: "offline",
      reason: "stale",
      sweptAt: "2026-07-30T07:14:30Z",
      detail: "last sweep was 180 minutes ago (/srv/activity/activity.json)",
      agents,
    };
  }

  it("grows to fill the column when there are cards, with the GRID as the scroller", () => {
    render(live([agent()]));
    expect(el("activity-panel")?.className).toContain("flex-1");
    const grid = el("activity-grid");
    expect(grid?.className).toContain("overflow-y-auto");
    // min-h-0 is what makes a flex child scroll instead of growing past its
    // parent and handing the overflow to the page.
    expect(grid?.className).toContain("min-h-0");
    expect(grid?.className).toContain("flex-1");
    // The hard cap this replaced: the panel is sized by its column now, not by
    // a fraction of the viewport it cannot see.
    expect(grid?.className).not.toContain("max-h-");
  });

  it("keeps the last-known grid full height too - stale cards are still cards", () => {
    render(staleWith([agent()]));
    expect(el("activity-panel")?.className).toContain("flex-1");
    expect(el("activity-grid")?.className).toContain("flex-1");
  });

  it("stops claiming the height when collapsed (no dead space under the toggle)", () => {
    render(live([agent()]));
    click("activity-panel-toggle");
    expect(el("activity-panel")?.className).not.toContain("flex-1");
    expect(el("activity-panel")?.className).toContain("shrink-0");
  });

  it("stops claiming the height when there is no grid to put in it", () => {
    // A live sweep that covered nobody, and an offline read with no document:
    // one line of copy each, and a panel that sizes to that line.
    render(live([]));
    expect(el("activity-empty")).not.toBeNull();
    expect(el("activity-panel")?.className).not.toContain("flex-1");

    render(staleWith([]));
    expect(el("activity-offline")).not.toBeNull();
    expect(el("activity-panel")?.className).not.toContain("flex-1");
  });
});

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

describe("ActivityPanel - hostile inputs", () => {
  it("an unparseable `now` degrades to the wall clock instead of throwing", () => {
    // date-fns raises "Invalid time value" on an Invalid Date, which would take
    // the whole route down.
    expect(() => {
      renderInRouter(<ActivityPanel activity={live([agent()])} now="not-a-date" avatars={{}} />);
    }).not.toThrow();
    expect(el("activity-agent-summit")).not.toBeNull();
  });

  it("renders an entry whose timestamps are empty strings", () => {
    render(
      live([
        agent({
          updated: null,
          idleMinutes: null,
          recent: [{ key: "", at: "", kind: "", label: "no timestamp", ref: "" }],
        }),
      ])
    );
    expect(el("activity-latest-summit")?.textContent).toContain("no timestamp");
    click("activity-details-toggle-summit");
    expect(el("activity-recent-summit")?.textContent).toContain("no timestamp");
  });
});

// ---------------------------------------------------------------------------
// The narration line and the sub-agent count
// ---------------------------------------------------------------------------

/**
 * Both fields were being written by the producer before the panel had anywhere
 * to show them. What is graded here is not "does it appear" but the three rules
 * that make showing it safe: prose never displaces the evidence behind the
 * pill, a retained sentence is never rendered bare, and a stale document shows
 * no sentence at all.
 */
describe("ActivityPanel - narration and sub-agents", () => {
  /** A stale view carrying the last document the sweep managed to write. */
  function staleView(agents: AgentActivity[]): ActivityView {
    return {
      state: "offline",
      reason: "stale",
      sweptAt: "2026-07-30T07:14:30Z",
      detail: "last sweep was 180 minutes ago (/srv/activity/activity.json)",
      agents,
    };
  }

  const inference = {
    taskLine: "wiring thread windowing into the message list",
    progressNote: "three of five call sites done",
    current: true,
    staleReason: null,
    paneMoved: false,
    ageSeconds: 240,
    generatedAt: "2026-07-30T10:10:00Z",
    sourceSwept: SWEPT,
    outcome: "ok",
  };

  it("shows the task line and its progress note", () => {
    render(live([agent({ inference })]));
    expect(el("activity-task-summit")?.textContent).toContain("thread windowing");
    expect(el("activity-progress-summit")?.textContent).toContain("three of five");
    expect(el("activity-task-stale-summit")).toBeNull();
  });

  // RULE 1 IS UNCONDITIONAL. Prose sits ABOVE the evidence, never instead of
  // it: the panel's whole value is that a wrong inference is cheap to spot, and
  // a sentence written by a model is the single most important thing to be able
  // to check against what was actually observed.
  it("never displaces the evidence behind the pill", () => {
    render(live([agent({ inference })]));
    const evidence = el("activity-evidence-summit");
    expect(evidence?.textContent).toContain("idle since 10:12");
    const card = el("activity-agent-summit")!;
    const nodes = Array.from(card.querySelectorAll("[data-testid]"));
    const taskAt = nodes.findIndex((n) => n.getAttribute("data-testid") === "activity-task-summit");
    const evAt = nodes.findIndex((n) => n.getAttribute("data-testid") === "activity-evidence-summit");
    expect(taskAt).toBeGreaterThanOrEqual(0);
    expect(evAt).toBeGreaterThan(taskAt);
  });

  // RETAINED PROSE IS NEVER BARE. The producer keeps a stale-but-provably-aged
  // sentence on purpose and marks it; the danger was never stale prose, it was
  // UNMARKED stale prose. The reason AND the age both have to show, because a
  // four-minute-old read and a ninety-minute-old one are not the same claim.
  it("marks a retained sentence with its reason and its age", () => {
    render(
      live([
        agent({
          inference: {
            ...inference,
            current: false,
            staleReason: "signal-moved",
            paneMoved: true,
            ageSeconds: 5400,
          },
        }),
      ])
    );
    expect(el("activity-task-summit")?.textContent).toContain("thread windowing");
    const marker = el("activity-task-stale-summit");
    expect(marker).not.toBeNull();
    expect(marker!.getAttribute("data-reason")).toBe("signal-moved");
    expect(marker!.textContent).toContain("signal-moved");
    expect(marker!.textContent).toContain("90m ago");
  });

  // A DEAD SWEEP FREEZES `current` AT TRUE and lets it age silently, so the
  // record's own freshness flag stops meaning anything the moment the producer
  // dies. Document-level staleness is the only thing that can catch that, which
  // is why this is a hard gate rather than a tint. The worktree survives,
  // because a worktree is a fact and a task line is a claim about now.
  it("shows no task line at all on a stale document", () => {
    render(staleView([agent({ inference })]));
    expect(el("activity-task-summit")).toBeNull();
    expect(el("activity-task-stale-summit")).toBeNull();
    expect(el("activity-progress-summit")).toBeNull();
    expect(el("activity-worktree-summit")).not.toBeNull();
    expect(el("activity-evidence-summit")).not.toBeNull();
  });

  it("shows nothing when there is no narration layer, which is the default", () => {
    render(live([agent()]));
    expect(el("activity-task-summit")).toBeNull();
    expect(el("activity-task-stale-summit")).toBeNull();
  });

  // An empty task line is a producer saying it has nothing. Rendering a blank
  // line with a "last known" caption under it would be worse than rendering
  // neither.
  it("treats an empty task line as absent, marker and all", () => {
    render(
      live([
        agent({
          inference: { ...inference, taskLine: "", current: false, staleReason: "too-old" },
        }),
      ])
    );
    expect(el("activity-task-summit")).toBeNull();
    expect(el("activity-task-stale-summit")).toBeNull();
  });

  it("counts running sub-agents when there are any", () => {
    render(live([agent({ subagentCount: 2 })]));
    expect(el("activity-subagents-summit")?.textContent).toContain("2 sub-agents running");
    render(live([agent({ subagentCount: 1 })]));
    expect(el("activity-subagents-summit")?.textContent).toContain("1 sub-agent running");
  });

  // Absent and zero are different FACTS to a consumer and the same SILENCE to a
  // reader: "0 sub-agents" costs a line on every card to say nothing.
  it("says nothing for zero, and nothing for absent", () => {
    render(live([agent({ subagentCount: 0 })]));
    expect(el("activity-subagents-summit")).toBeNull();
    render(live([agent({ subagentCount: null })]));
    expect(el("activity-subagents-summit")).toBeNull();
  });
});
