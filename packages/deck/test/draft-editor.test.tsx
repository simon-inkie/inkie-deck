// @vitest-environment jsdom
/**
 * draft-editor.test.tsx - render test for the draft editor (#66): last-saved
 * line with who wrote it, and the visible warning when the file changes under
 * an open editor. fetch is stubbed; no server or filesystem involved.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { DraftEditor, DRAFT_POLL_MS, type DraftDto } from "~/components/DraftEditor";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let current: DraftDto;

const dto = (over: Partial<DraftDto>): DraftDto => ({
  name: "a.md",
  content: "hello",
  version: "v1",
  savedAt: "2026-10-14T10:00:00.000Z",
  writer: "person",
  ...over,
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

beforeEach(() => {
  vi.useFakeTimers();
  current = dto({});
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      if (url === "/api/drafts") return json({ ok: true, drafts: [current] });
      return json({ ok: true, draft: current });
    })
  );
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function flush() {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
}

async function openDraft() {
  act(() => root.render(<DraftEditor />));
  await flush();
  const select = container.querySelector<HTMLSelectElement>('[data-testid="draft-select"]')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
    setter.call(select, "a.md");
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await flush();
}

describe("DraftEditor", () => {
  it("shows last-saved time and who wrote the version", async () => {
    await openDraft();
    const status = container.querySelector('[data-testid="draft-status"]')!.textContent!;
    expect(status).toContain("Last saved");
    expect(status).toContain("you");
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="draft-text"]')!.value).toBe("hello");
    expect(container.querySelector('[data-testid="draft-conflict"]')).toBeNull();
  });

  it("names the agent when the loaded version was not written by the person", async () => {
    current = dto({ writer: "agent" });
    await openDraft();
    expect(container.querySelector('[data-testid="draft-status"]')!.textContent).toContain("the agent");
  });

  it("shows a visible alert when the file changes outside the editor", async () => {
    await openDraft();
    current = dto({ version: "v2", content: "agent edit", writer: "agent" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10);
    });
    const alert = container.querySelector('[role="alert"]');
    expect(alert).not.toBeNull();
    expect(alert!.textContent).toContain("changed outside the editor");
    expect(container.querySelector('[data-testid="draft-keep-mine"]')).not.toBeNull();
    // The person's text is not silently replaced.
    expect(container.querySelector<HTMLTextAreaElement>('[data-testid="draft-text"]')!.value).toBe("hello");
  });
});
