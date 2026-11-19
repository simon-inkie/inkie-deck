// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-router", async (importOriginal) => ({
  ...await importOriginal<typeof import("react-router")>(),
  useFetcher: vi.fn(),
}));
import { MemoryRouter, useFetcher } from "react-router";
import { PaneHintBanner } from "~/components/PaneHintBanner";
import { TmuxPane } from "~/components/TmuxPane";
import type { PaneHintId } from "~/lib/pane-hints";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement;
let root: Root;
const submit = vi.fn();
let fetcher: { state: string; data: { ok: boolean; error?: string } | undefined; submit: typeof submit };

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  submit.mockReset();
  fetcher = { state: "idle", data: undefined, submit };
  vi.mocked(useFetcher).mockImplementation(() => fetcher as unknown as ReturnType<typeof useFetcher>);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});
function render(sendTarget: string | undefined = "agent", pane: string | undefined = "Trust directory?") {
  act(() => root.render(<TmuxPane pane={pane} windowName="agent" sendTarget={sendTarget} />));
}
function button(label: string) {
  return Array.from(container.querySelectorAll("button")).find((b) => b.textContent === label)!;
}
function draft(text: string) {
  const input = container.querySelector("textarea")!;
  act(() => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function settle(ok: boolean) {
  fetcher.state = "submitting";
  render();
  fetcher.state = "idle";
  fetcher.data = ok ? { ok: true } : { ok: false, error: "Unavailable" };
  render();
}

describe("shared pane navigation", () => {
  it.each(["Up", "Down", "Enter", "Escape", "Tab", "Shift+Tab"])("posts %s as one key and retains the draft", (label) => {
    render();
    draft("draft message");
    act(() => button(label).click());
    expect(submit).toHaveBeenCalledExactlyOnceWith(
      { window: "agent", key: label === "Shift+Tab" ? "BTab" : label },
      { method: "post", action: "/api/tmux-send" }
    );
    settle(true);
    expect(container.querySelector("textarea")!.value).toBe("draft message");
  });

  it("clears a successful text send and retains a failed one", () => {
    render();
    draft("draft message");
    act(() => button("Send").click());
    settle(false);
    expect(container.querySelector("textarea")!.value).toBe("draft message");
    act(() => button("Send").click());
    settle(true);
    expect(container.querySelector("textarea")!.value).toBe("");
  });

  it("disables all send controls while a submission is pending", () => {
    fetcher.state = "submitting";
    render();
    expect(Array.from(container.querySelectorAll("button")).every((b) => b.disabled)).toBe(true);
  });

  it("keeps navigation available for a transiently unavailable pane", () => {
    render("agent", undefined);
    expect(button("Up")).toBeDefined();
  });

  it("renders no send controls for a read-only pane", () => {
    act(() => root.render(<TmuxPane pane="Trust directory?" windowName="agent" />));
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector("textarea")).toBeNull();
  });
});

describe("first-run hint rendering", () => {
  function renderBanner(hint: PaneHintId | "H6" | null, tmuxOn = true) {
    act(() => root.render(
      <MemoryRouter initialEntries={["/threads/demo"]}>
        <ChatHints hint={hint} tmuxOn={tmuxOn} />
      </MemoryRouter>,
    ));
  }

  function ChatHints({ hint, tmuxOn }: { hint: PaneHintId | "H6" | null; tmuxOn: boolean }) {
    const history = React.useRef<HTMLDivElement>(null);
    return (
      <div ref={history} tabIndex={-1} aria-label="Message history">
        <PaneHintBanner hint={hint} agent="demo" tmuxOn={tmuxOn} focusFallback={history} />
      </div>
    );
  }

  it.each([
    ["H1", "asking whether to trust", "Folder trust question"],
    ["H2", "need a one-time sign-in", "Sign-in step"],
    ["H3", "found an API key", "API key question"],
    ["H4", "waiting on a setup screen", "Setup screen"],
    ["H5", "appears to have exited to a shell", "appears to be at a shell prompt"],
  ] as const)("renders %s without submitting keys", (hint, chatCopy, terminalCopy) => {
    renderBanner(hint);
    expect(container.querySelector('[role="status"]')?.textContent).toContain(chatCopy);
    expect(container.querySelector("a")?.getAttribute("href")).toBe("/threads/demo?view=tmux");

    act(() => root.render(<TmuxPane pane="captured" windowName="demo" sendTarget="demo" hint={null} />));
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("");
    act(() => root.render(<TmuxPane pane="captured" windowName="demo" sendTarget="demo" hint={hint} />));
    const keys = container.querySelector('[aria-label="Pane navigation"]');
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toContain(terminalCopy);
    if (hint !== "H5") expect(status?.textContent).toContain("Check the terminal before choosing");
    expect(keys?.getAttribute("aria-describedby")).toBe(status?.id);
    expect(keys?.previousElementSibling).toBe(status);
    expect(submit).not.toHaveBeenCalled();

    act(() => root.render(<TmuxPane pane="idle" windowName="demo" sendTarget="demo" hint={null} />));
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("");
    expect(keys?.hasAttribute("aria-describedby")).toBe(false);
  });

  it.each([true, false])("renders H6 with the appropriate terminal guidance (enabled: %s)", (tmuxOn) => {
    renderBanner("H6", tmuxOn);
    expect(container.querySelector("h2")?.textContent).toBe("No messages yet");
    expect(container.textContent).toContain("A new agent writes first after its first start.");
    expect(container.textContent?.includes("one-time question")).toBe(tmuxOn);
    expect(container.querySelector("a") !== null).toBe(tmuxOn);
    expect(submit).not.toHaveBeenCalled();
  });

  it("updates the same chat live region and preserves or restores link focus", () => {
    renderBanner(null);
    const status = container.querySelector('[role="status"]');
    expect(status?.textContent).toBe("");

    renderBanner("H1");
    const link = container.querySelector("a")!;
    link.focus();
    for (const hint of ["H2", "H6"] as const) {
      renderBanner(hint);
      expect(container.querySelector('[role="status"]')).toBe(status);
      expect(container.querySelector("a")).toBe(link);
      expect(document.activeElement).toBe(link);
    }

    renderBanner(null);
    expect(container.querySelector('[role="status"]')).toBe(status);
    expect(status?.textContent).toBe("");
    expect(container.querySelector("a")).toBeNull();
    expect(document.activeElement).toBe(container.querySelector('[aria-label="Message history"]'));
  });
});
