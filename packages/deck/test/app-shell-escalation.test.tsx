// @vitest-environment jsdom
/**
 * app-shell-escalation.test.tsx - the top-bar escalation alert (top-bar
 * escalation SPEC, the UI half).
 *
 * Mirrors activity-panel.test.tsx's render style: createRoot/act,
 * createRoutesStub (AppShell is Links + NavLink + useParams/useLocation, so
 * it needs a real router around it, same reasoning as the panel and the
 * Sidebar).
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { AppShell } from "~/components/AppShell";
import type { EscalatedAgent } from "~/lib/activity.shared";

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

/** AppShell needs a router (Link/NavLink/useLocation/useParams throughout). */
function render(escalated: EscalatedAgent[]): void {
  const Stub = createRoutesStub([
    {
      path: "/",
      Component: () => (
        <AppShell
          agents={[]}
          needsItems={[]}
          needsCount={0}
          workCards={[]}
          escalated={escalated}
        />
      ),
    },
  ]);
  act(() => {
    root.render(<Stub initialEntries={["/"]} />);
  });
}

function el(testId: string): HTMLElement | null {
  return container.querySelector(`[data-testid="${testId}"]`);
}

/** Radix DropdownMenuTrigger opens on pointerdown, not a bare click. */
function open(testId: string): void {
  const node = el(testId);
  if (node === null) throw new Error(`no element with testid ${testId}`);
  act(() => {
    node.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, button: 0 }));
    node.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function escalated(over: Partial<EscalatedAgent> = {}): EscalatedAgent {
  return {
    agent: "quill",
    status: "stuck",
    statusSince: "2026-08-14T11:00:00Z",
    durationMs: 45 * 60 * 1000,
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("AppShell - top-bar escalation alert", () => {
  it("renders nothing when no agent is escalated", () => {
    render([]);
    expect(el("escalation-alert")).toBeNull();
  });

  it("a single escalated agent is a direct link straight to that agent's thread", () => {
    render([escalated({ agent: "quill" })]);
    const alert = el("escalation-alert");
    expect(alert).not.toBeNull();
    expect(alert!.tagName).toBe("A");
    expect(alert!.getAttribute("href")).toBe("/threads/quill");
    expect(alert!.getAttribute("aria-label")).toContain("quill");
    // No dropdown mounted for the single-agent case.
    expect(document.querySelector('[data-testid="escalation-item-quill"]')).toBeNull();
  });

  it("multiple escalated agents render a dropdown, not a direct link", () => {
    render([
      escalated({ agent: "quill" }),
      escalated({ agent: "scribe", status: "needs-you" }),
    ]);
    const alert = el("escalation-alert");
    expect(alert).not.toBeNull();
    expect(alert!.tagName).toBe("BUTTON");
    expect(alert!.getAttribute("aria-label")).toContain("2");
  });

  it("the dropdown lists each escalated agent with its agent name, status and wedged duration, each deep-linking to its thread", () => {
    render([
      escalated({ agent: "quill", status: "stuck", durationMs: 65 * 60 * 1000 }),
      escalated({ agent: "scribe", status: "needs-you", durationMs: 30 * 60 * 1000 }),
    ]);
    open("escalation-alert");

    const quillItem = document.querySelector('[data-testid="escalation-item-quill"]');
    const scribeItem = document.querySelector('[data-testid="escalation-item-scribe"]');
    expect(quillItem).not.toBeNull();
    expect(scribeItem).not.toBeNull();

    expect(quillItem!.getAttribute("href")).toBe("/threads/quill");
    expect(quillItem!.textContent).toContain("quill");
    expect(quillItem!.textContent).toContain("stuck");
    expect(quillItem!.textContent).toContain("wedged 1h 5m");

    expect(scribeItem!.getAttribute("href")).toBe("/threads/scribe");
    expect(scribeItem!.textContent).toContain("scribe");
    expect(scribeItem!.textContent).toContain("needs you");
    expect(scribeItem!.textContent).toContain("wedged 30m");
  });

  // TASK-783: the single-agent fast path used to render a bare TriangleAlert
  // plus a "1" badge, with the agent/status/duration only in the aria-label.
  // A sighted user got a red triangle and no reason, before OR after the
  // click. textContent is the right assertion surface precisely because it
  // excludes attributes: an aria-label-only regression cannot satisfy it.
  it("a single escalated agent shows agent, status and duration as visible text, not only in the aria-label", () => {
    render([escalated({ agent: "quill", status: "stuck", durationMs: 45 * 60 * 1000 })]);
    const alert = el("escalation-alert");
    expect(alert).not.toBeNull();
    // Exact equality, not toContain: also pins that the redundant "1" count
    // badge went away when the agent got named in words.
    expect(alert!.textContent).toBe("quill stuck for 45m");

    const reason = el("escalation-reason");
    expect(reason).not.toBeNull();
    // Visible to a sighted user, not smuggled back behind a screen-reader-only
    // wrapper (the shape a "fix" that misses the point takes).
    expect(reason!.getAttribute("aria-hidden")).toBeNull();
    expect(reason!.className).not.toContain("sr-only");
    expect(reason!.hasAttribute("hidden")).toBe(false);
  });

  it("the visible reason speaks statusLabel's phrasing and formatDurationHm's hours-and-minutes form", () => {
    render([escalated({ agent: "scribe", status: "needs-you", durationMs: 65 * 60 * 1000 })]);
    // "needs you", not the raw "needs-you" enum; "1h 5m", not "65m".
    expect(el("escalation-alert")!.textContent).toBe("scribe needs you for 1h 5m");
  });

  it("the visible reason is inside the same link, so it is still one click to the thread", () => {
    render([escalated({ agent: "quill" })]);
    const alert = el("escalation-alert");
    expect(alert!.tagName).toBe("A");
    expect(alert!.getAttribute("href")).toBe("/threads/quill");
    // The reason is a child of the anchor, not a sibling control next to it.
    expect(alert!.contains(el("escalation-reason"))).toBe(true);
    expect(alert!.querySelectorAll("a").length).toBe(0);
    expect(alert!.querySelectorAll("button").length).toBe(0);
  });

  // WCAG 2.5.3 Label in Name: speech users say what they see, so the visible
  // label has to be a contiguous substring of the accessible name. Asserted as
  // a PREFIX, not a bare toContain: the pre-fix badge text "1" is a substring
  // of "... for 1h 5m", so toContain alone would have stayed green through the
  // very bug this file is about.
  it("the accessible name opens with the visible label verbatim, then adds the destination", () => {
    render([escalated({ agent: "scribe", status: "needs-you", durationMs: 65 * 60 * 1000 })]);
    const alert = el("escalation-alert");
    const label = alert!.getAttribute("aria-label") ?? "";
    expect(label.startsWith(alert!.textContent ?? "")).toBe(true);
    expect(label).toBe("scribe needs you for 1h 5m - go to thread");
  });

  it("stays a visually distinct control from the needs-you bell - not folded into its badge count", () => {
    render([escalated()]);
    const alert = el("escalation-alert");
    const bell = container.querySelector('[aria-label^="Needs you"]');
    expect(alert).not.toBeNull();
    expect(bell).not.toBeNull();
    expect(alert).not.toBe(bell);
    // Distinct destructive tint vs the bell's muted-foreground default class.
    expect(alert!.className).toContain("destructive");
    expect(bell!.className).not.toContain("destructive");
  });
});
