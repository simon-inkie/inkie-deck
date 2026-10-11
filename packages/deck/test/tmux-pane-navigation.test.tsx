// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";

vi.mock("react-router", () => ({ useFetcher: vi.fn() }));
import { useFetcher } from "react-router";
import { TmuxPane } from "~/components/TmuxPane";

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
