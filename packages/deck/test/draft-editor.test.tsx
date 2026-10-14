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

function textarea() {
  return container.querySelector<HTMLTextAreaElement>('[data-testid="draft-text"]')!;
}
function click(testid: string) {
  return act(async () => {
    container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`)!.click();
    await vi.advanceTimersByTimeAsync(0);
  });
}
async function type(value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea(), value);
    textarea().dispatchEvent(new Event("input", { bubbles: true }));
  });
}
function postBodies(): FormData[] {
  const f = fetch as unknown as ReturnType<typeof vi.fn>;
  return f.mock.calls
    .filter((c) => (c[1] as RequestInit | undefined)?.method === "POST")
    .map((c) => (c[1] as RequestInit).body as FormData);
}
function stubSave(respond: (form: FormData) => Response) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === "POST") return respond(init.body as FormData);
      if (url === "/api/drafts") return json({ ok: true, drafts: [current] });
      return json({ ok: true, draft: current });
    })
  );
}

describe("DraftEditor", () => {
  it("saves edits with the loaded version and goes clean afterwards", async () => {
    stubSave((form) => {
      current = dto({ version: "v2", content: String(form.get("content")) });
      return json({ ok: true, draft: current });
    });
    await openDraft();
    const save = () => container.querySelector<HTMLButtonElement>('[data-testid="draft-save"]')!;
    expect(save().disabled).toBe(true);
    await type("hello world");
    expect(save().disabled).toBe(false);
    expect(container.querySelector('[data-testid="draft-status"]')!.textContent).toContain("unsaved");
    await click("draft-save");
    const [form] = postBodies();
    expect(form!.get("baseVersion")).toBe("v1");
    expect(form!.get("content")).toBe("hello world");
    expect(save().disabled).toBe(true);
    expect(container.querySelector('[data-testid="draft-status"]')!.textContent).not.toContain("unsaved");
  });

  it("a 409 on save shows the conflict alert and keeps the person's text", async () => {
    stubSave(() => {
      current = dto({ version: "v2", content: "agent edit", writer: "agent" });
      return json({ ok: false, conflict: true, current }, 409);
    });
    await openDraft();
    await type("my edit");
    await click("draft-save");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(container.querySelector('[role="alert"]')!.textContent).toContain("unsaved edits");
    expect(textarea().value).toBe("my edit");
  });

  it("Load the newer copy replaces the text and clears the alert", async () => {
    await openDraft();
    await type("my edit");
    current = dto({ version: "v2", content: "agent edit", writer: "agent" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10);
    });
    await click("draft-load-theirs");
    expect(textarea().value).toBe("agent edit");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(container.querySelector('[data-testid="draft-status"]')!.textContent).toContain("the agent");
  });

  it("the poll surfaces a draft removed outside, and recreate force-saves the person's text", async () => {
    let removed = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const form = init.body as FormData;
          removed = false;
          current = dto({ version: "v2", content: String(form.get("content")) });
          return json({ ok: true, draft: current });
        }
        if (url === "/api/drafts") return json({ ok: true, drafts: [current] });
        return removed ? json({ ok: false }, 404) : json({ ok: true, draft: current });
      })
    );
    await openDraft();
    await type("my edit");
    removed = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10);
    });
    expect(container.querySelector('[data-testid="draft-gone"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="draft-conflict"]')).toBeNull();
    expect(textarea().value).toBe("my edit");
    await click("draft-recreate");
    const [form] = postBodies();
    expect(form!.get("force")).toBe("1");
    expect(form!.get("content")).toBe("my edit");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("a save answered 409 without a current copy shows the removed alert", async () => {
    stubSave(() => json({ ok: false, conflict: true }, 409));
    await openDraft();
    await type("my edit");
    await click("draft-save");
    expect(container.querySelector('[data-testid="draft-gone"]')).not.toBeNull();
    expect(textarea().value).toBe("my edit");
  });

  it("a poll GET that finishes after the person's own save raises no false alert", async () => {
    let releaseGet: (() => void) | null = null;
    let heldGets = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const form = init.body as FormData;
          current = dto({ version: "v2", content: String(form.get("content")) });
          return json({ ok: true, draft: current });
        }
        if (url === "/api/drafts") return json({ ok: true, drafts: [current] });
        if (heldGets === 0 && releaseGet === null && url.startsWith("/api/drafts?name=") && saveStarted) {
          heldGets++;
          // Reads the post-save state, but resolves only when released.
          await new Promise<void>((r) => (releaseGet = r));
          return json({ ok: true, draft: dto({ version: "v2", content: "my edit" }) });
        }
        return json({ ok: true, draft: current });
      })
    );
    let saveStarted = false;
    await openDraft();
    await type("my edit");
    saveStarted = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10); // poll GET now in flight
    });
    expect(releaseGet).not.toBeNull();
    await click("draft-save"); // save completes while the GET is pending
    await act(async () => {
      releaseGet!();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("Keep mine and overwrite posts force=1 against the newer version's content", async () => {
    stubSave((form) => {
      current = dto({ version: "v3", content: String(form.get("content")) });
      return json({ ok: true, draft: current });
    });
    await openDraft();
    await type("my edit");
    current = dto({ version: "v2", content: "agent edit", writer: "agent" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10);
    });
    await click("draft-keep-mine");
    const [form] = postBodies();
    expect(form!.get("force")).toBe("1");
    expect(form!.get("content")).toBe("my edit");
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(textarea().value).toBe("my edit");
    expect(container.querySelector('[data-testid="draft-status"]')!.textContent).toContain("you");
  });

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
