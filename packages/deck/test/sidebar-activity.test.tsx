// @vitest-environment jsdom
/**
 * sidebar-activity.test.tsx - the activity status pill in the agent list
 *
 * A render test, because every claim here is a claim about the DOM and about
 * ABSENCE in particular: no pill for an agent the sweep never saw, no pill on
 * an instance with no activity root, no pill for `unknown`. A props-shape test
 * cannot see the difference between "rendered muted" and "not rendered", which
 * is the whole distinction this feature has to get right - the Sidebar has no
 * room for an evidence line, so anything it does show has to be worth trusting
 * on its own.
 *
 * The unconfigured/offline instances arrive here as agents with no `status`
 * key at all (routes/shell.tsx refuses to ship one unless the read was live),
 * so the "a second user renders exactly as before" case is the no-status fixture.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { Sidebar, type SidebarAgent } from "~/components/Sidebar";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

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

/** The Sidebar is Links + useParams, so it needs a router around it. */
function render(agents: SidebarAgent[], activeAgent?: string): void {
  const Stub = createRoutesStub([
    { path: "/threads/:agent", Component: () => <Sidebar agents={agents} /> },
    { path: "/", Component: () => <Sidebar agents={agents} /> },
  ]);
  act(() => {
    root.render(
      <Stub initialEntries={[activeAgent === undefined ? "/" : `/threads/${activeAgent}`]} />
    );
  });
}

function el(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

function sidebarAgent(over: Partial<SidebarAgent> = {}): SidebarAgent {
  return {
    name: "summit",
    preview: "Both done. MC restarted earlier.",
    lastTimestamp: "2026-07-30T09:58:58Z",
    hasUnhandled: false,
    hasUnread: false,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("Sidebar activity pill - present when there is something to say", () => {
  it("renders the pill for a real status, carrying the status as data and as a word", () => {
    render([sidebarAgent({ status: "working" })]);
    const pill = el("sidebar-status-summit");
    expect(pill).not.toBeNull();
    expect(pill!.getAttribute("data-status")).toBe("working");
    // Full text, not the glyph alone. The label IS the accessible name now, so the
    // role="img" + aria-label pair the compact pill needed is gone with it -
    // an img role over real text would hide that text from a screen reader.
    expect(pill!.textContent).toBe("working");
    expect(pill!.getAttribute("role")).toBeNull();
    expect(pill!.getAttribute("aria-label")).toBeNull();
    // The glyph stays alongside it: never colour alone (WCAG 1.4.1).
    expect(pill!.querySelector("svg")).not.toBeNull();
  });

  it("tints each status differently (the same table the Activity panel uses)", () => {
    render([
      sidebarAgent({ name: "quill", status: "working" }),
      sidebarAgent({ name: "sprout", status: "needs-you" }),
      sidebarAgent({ name: "fern", status: "stuck" }),
    ]);
    const classes = ["quill", "sprout", "fern"].map(
      (n) => el(`sidebar-status-${n}`)?.className ?? ""
    );
    expect(new Set(classes).size).toBe(3);
    expect(classes[1]).toContain("accent");
    expect(classes[2]).toContain("destructive");
  });

  it("keeps the dots beside the name and the pill at the end of the row", () => {
    // The requirement: the decision card and message dots sit to the right of
    // the agent's name, and the status pill stays on the right. Three
    // things render, and WHERE each one renders is the whole ask, so this
    // pins the arrangement and not just the presence.
    render([sidebarAgent({ status: "needs-you", hasUnread: true, hasUnhandled: true })]);
    const pill = el("sidebar-status-summit");
    const messageDot = el("sidebar-dot-message-summit");
    const decisionDot = el("sidebar-dot-decision-summit");
    expect(pill).not.toBeNull();
    expect(messageDot).not.toBeNull();
    expect(decisionDot).not.toBeNull();

    // The dots belong to the NAME's cluster, not to the pill's end of the row -
    // and specifically AFTER the name, not just somewhere in the same cluster
    // (a dot rendered before the name would still pass a bare contains check).
    const cluster = messageDot!.parentElement!;
    const clusterChildren = Array.from(cluster.children);
    expect(clusterChildren[0]?.textContent).toBe("summit");
    expect(clusterChildren.indexOf(messageDot!)).toBeGreaterThan(0);
    expect(clusterChildren.indexOf(decisionDot!)).toBeGreaterThan(0);
    expect(cluster.contains(pill!)).toBe(false);

    // ... and the pill is the last thing in the row, which is what puts it at
    // the far right of a `justify-between` row however long the name is.
    const row = pill!.parentElement!;
    expect(row.contains(cluster)).toBe(true);
    expect(row.lastElementChild).toBe(pill);
  });
});

describe("Sidebar activity pill - absent when there is not", () => {
  it("renders NO pill for an agent the sweep did not cover", () => {
    render([sidebarAgent({ name: "quill", status: "working" }), sidebarAgent({ name: "nova" })]);
    expect(el("sidebar-status-quill")).not.toBeNull();
    expect(el("sidebar-status-nova")).toBeNull();
  });

  it("renders NO pill for `unknown` (a shrug is not a status)", () => {
    // The Activity panel can afford "no observation" because the evidence
    // sentence is right beside it. A bare dashed glyph in the agent list
    // could only be read as a verdict, so it does not render at all.
    render([sidebarAgent({ status: "unknown" })]);
    expect(el("sidebar-status-summit")).toBeNull();
  });

  it("renders the sidebar EXACTLY as before on an instance with no activity", () => {
    // A second user's instance and every offline read: shell.tsx ships no status key,
    // so this fixture is that instance. Nothing about the row may change.
    render([sidebarAgent({ hasUnread: true, hasUnhandled: true })]);
    expect(container.querySelector('[data-testid^="sidebar-status-"]')).toBeNull();
    expect(el("sidebar-dot-message-summit")).not.toBeNull();
    expect(el("sidebar-dot-decision-summit")).not.toBeNull();
    expect(container.textContent).toContain("summit");
    expect(container.textContent).toContain("Both done. MC restarted earlier.");
  });

  it("keeps the empty-list copy when there are no agents at all", () => {
    render([]);
    expect(container.textContent).toContain("No agents yet");
    expect(container.querySelector('[data-testid^="sidebar-status-"]')).toBeNull();
  });
});
