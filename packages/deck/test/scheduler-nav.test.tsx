// @vitest-environment jsdom
/**
 * scheduler-nav.test.tsx - the Nudges nav entries in the app shell, and the
 * fact that they are ABSENT unless this instance's gate says otherwise.
 *
 * A render test, because every claim here is a claim about ABSENCE, and a
 * props-shape test cannot tell "rendered, hidden by CSS" from "not rendered".
 * The distinction matters: /scheduler writes the system crontab, so an
 * instance that is not allowed to use it must not be advertising a route to
 * it. Follows sidebar-activity.test.tsx, which pins the sibling Activity
 * feature's presence-and-absence the same way.
 *
 * The link appears TWICE - a text NavLink in the top bar (desktop) and an icon
 * Link in the agent strip (mobile) - off ONE flag. Both are asserted, because
 * a gate that closes one surface and leaves the other open is the shape this
 * mistake actually takes.
 *
 * The gate itself (which env produces cronAdminOn) is instance.test.ts's job,
 * and the server-side refusal that makes it load-bearing is
 * scheduler-route.test.ts's. This file only covers what the shell renders once
 * the flag has been decided.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { AppShell } from "~/components/AppShell";
import type { SidebarAgent } from "~/components/Sidebar";

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

interface ShellFlags {
  cronAdminOn?: boolean;
  activityNavOn?: boolean;
}

const AGENTS: SidebarAgent[] = [
  {
    name: "sprout",
    preview: "on it",
    lastTimestamp: "2026-07-30T09:58:58Z",
    hasUnhandled: false,
    hasUnread: false,
  },
];

/** Render the shell at "/" with an outlet child, as the real route tree does. */
function render(flags: ShellFlags = {}): void {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <AppShell agents={AGENTS} needsItems={[]} needsCount={0} workCards={[]} {...flags} />
      ),
      children: [{ index: true, Component: () => <div>page body</div> }],
    },
  ]);
  act(() => {
    root.render(<Stub initialEntries={["/"]} />);
  });
}

/** Every anchor pointing at the scheduler route, desktop and mobile alike. */
function schedulerLinks(): HTMLAnchorElement[] {
  return Array.from(container.querySelectorAll<HTMLAnchorElement>('a[href="/scheduler"]'));
}

function el(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

// ---------------------------------------------------------------------------

describe("Nudges nav - shown when the instance gate is open", () => {
  it("renders a top-bar link to /scheduler labelled Nudges", () => {
    render({ cronAdminOn: true });

    const desktop = schedulerLinks().find((a) => a.textContent === "Nudges");
    expect(desktop).toBeDefined();
  });

  it("renders the mobile agent-strip entry too", () => {
    render({ cronAdminOn: true });

    const strip = el("agent-strip-crons");
    expect(strip).not.toBeNull();
    expect(strip!.getAttribute("href")).toBe("/scheduler");
    // Icon-only at this size, so the accessible name has to come from the label.
    expect(strip!.getAttribute("aria-label")).toBe("Nudges");
    expect(strip!.querySelector("svg")).not.toBeNull();
  });

  it("opens BOTH surfaces off the one flag", () => {
    // The regression this guards: a gate applied to the top bar only, leaving
    // the mobile strip advertising a route the instance cannot use.
    render({ cronAdminOn: true });

    expect(schedulerLinks()).toHaveLength(2);
  });

  it("keeps the always-on nav entries alongside it", () => {
    render({ cronAdminOn: true });

    expect(container.querySelector('a[href="/cards"]')).not.toBeNull();
    expect(container.querySelector('a[href="/projects"]')).not.toBeNull();
  });
});

describe("Nudges nav - absent when the instance gate is closed", () => {
  it("renders NO link to /scheduler when cronAdminOn is false", () => {
    render({ cronAdminOn: false });

    expect(schedulerLinks()).toHaveLength(0);
    expect(el("agent-strip-crons")).toBeNull();
  });

  it("renders NO link when the flag is omitted entirely", () => {
    // The prop defaults to false, so an instance whose loader never decided
    // the question is closed rather than open. Default-deny is the only safe
    // default for a surface that writes the crontab.
    render();

    expect(schedulerLinks()).toHaveLength(0);
    expect(el("agent-strip-crons")).toBeNull();
  });

  it("does not leak the word Nudges into the shell when closed", () => {
    render({ cronAdminOn: false });

    expect(container.textContent).not.toContain("Nudges");
  });

  it("leaves the rest of the nav exactly as it was", () => {
    render({ cronAdminOn: false });

    expect(container.querySelector('a[href="/cards"]')).not.toBeNull();
    expect(container.querySelector('a[href="/projects"]')).not.toBeNull();
    expect(el("agent-strip")).not.toBeNull();
    expect(el("agent-strip-btn-sprout")).not.toBeNull();
  });
});

describe("Nudges nav - independent of the sibling Activity gate", () => {
  it("shows Activity without Nudges", () => {
    // Two separate flags on two separate features. Wiring either one to the
    // other would hand an instance a surface its own gate had refused.
    render({ cronAdminOn: false, activityNavOn: true });

    expect(container.querySelector('a[href="/tmux"]')).not.toBeNull();
    expect(schedulerLinks()).toHaveLength(0);
  });

  it("shows Nudges without Activity", () => {
    render({ cronAdminOn: true, activityNavOn: false });

    expect(container.querySelector('a[href="/tmux"]')).toBeNull();
    expect(schedulerLinks()).toHaveLength(2);
  });

  it("shows both when both are open", () => {
    render({ cronAdminOn: true, activityNavOn: true });

    expect(container.querySelector('a[href="/tmux"]')).not.toBeNull();
    expect(schedulerLinks()).toHaveLength(2);
  });

  it("shows neither when both are closed", () => {
    render();

    expect(container.querySelector('a[href="/tmux"]')).toBeNull();
    expect(schedulerLinks()).toHaveLength(0);
  });
});
