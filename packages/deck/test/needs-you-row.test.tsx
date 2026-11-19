// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { createRoutesStub } from "react-router";
import { NeedsYouRow } from "~/routes/home";
import type { NeedsYouItem } from "~/lib/queue-derive";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("Needs you row", () => {
  it("keeps the thread and ticket links independent without nested anchors", () => {
    const now = "2026-06-09T16:00:00Z";
    const item: NeedsYouItem = {
      id: "scribe/action-1",
      kind: "action",
      agentName: "scribe",
      title: "Review the draft",
      deadline: now,
      overdue: false,
      ageDisplay: "in 1 hour",
      createdAt: now,
      deepLink: "/threads/scribe#action-1",
      actionId: "action-1",
      ticket: "https://example.com/issues/1",
    };
    const Stub = createRoutesStub([
      { path: "/", Component: () => <NeedsYouRow item={item} now={now} /> },
    ]);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    act(() => root.render(<Stub initialEntries={["/"]} />));

    expect(container.querySelector("a a")).toBeNull();
    const thread = container.querySelector<HTMLAnchorElement>(`a[href="${item.deepLink}"]`);
    const ticket = container.querySelector<HTMLAnchorElement>(`a[href="${item.ticket}"]`);
    expect(thread).not.toBeNull();
    expect(thread?.getAttribute("aria-label")).toBe("scribe: Review the draft");
    expect(thread?.tabIndex).toBe(0);
    expect(ticket).not.toBeNull();
    expect(ticket?.textContent).toBe("Ticket");
    expect(ticket?.target).toBe("_blank");
    expect(ticket?.rel).toBe("noopener noreferrer");
    expect(ticket?.tabIndex).toBe(0);
    expect(container.querySelector('button[aria-label="Mark as done"]')).not.toBeNull();
  });
});
