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

// ---------------------------------------------------------------------------
// Switching, create, and stale responses (multi-draft store)
// ---------------------------------------------------------------------------

describe("DraftEditor with several drafts", () => {
  let files: Record<string, DraftDto>;
  /** Release function for a POST held open by holdNextPost. */
  let releasePost: (() => void) | null;
  let holdNextPost: boolean;
  const posts: FormData[] = [];

  beforeEach(() => {
    posts.length = 0;
    releasePost = null;
    holdNextPost = false;
    files = {
      "a.md": dto({ name: "a.md", content: "alpha", version: "a1" }),
      "b.md": dto({ name: "b.md", content: "bravo", version: "b1" }),
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (init?.method === "POST") {
          const form = init.body as FormData;
          posts.push(form);
          const name = String(form.get("name"));
          if (form.get("intent") === "create") {
            files[name + ".md"] = dto({ name: name + ".md", content: "", version: "n1" });
            return json({ ok: true, draft: files[name + ".md"] });
          }
          if (holdNextPost) {
            holdNextPost = false;
            await new Promise<void>((r) => (releasePost = r));
          }
          files[name] = dto({ name, content: String(form.get("content")), version: name + "-saved" });
          return json({ ok: true, draft: files[name] });
        }
        if (url === "/api/drafts") return json({ ok: true, drafts: Object.values(files) });
        const name = decodeURIComponent(url.split("name=")[1] ?? "");
        return files[name] ? json({ ok: true, draft: files[name] }) : json({ ok: false }, 404);
      })
    );
  });

  async function select(name: string) {
    const el = container.querySelector<HTMLSelectElement>('[data-testid="draft-select"]')!;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setter.call(el, name);
      el.dispatchEvent(new Event("change", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(0);
    });
  }
  async function start() {
    act(() => root.render(<DraftEditor />));
    await flush();
    await select("a.md");
  }

  it("asks before switching away from unsaved edits, and keeps them when declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await start();
    await type("my unsaved edit");
    await select("b.md");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(textarea().value).toBe("my unsaved edit");
    expect(
      (fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.some((c) => String(c[0]).includes("b.md"))
    ).toBe(false);
    confirm.mockReturnValue(true);
    await select("b.md");
    expect(textarea().value).toBe("bravo");
    confirm.mockRestore();
  });

  it("does not ask when there is nothing unsaved", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await start();
    await select("b.md");
    expect(confirm).not.toHaveBeenCalled();
    expect(textarea().value).toBe("bravo");
    confirm.mockRestore();
  });

  it("asks before creating a draft over unsaved edits, and creates nothing when declined", async () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    await start();
    await type("my unsaved edit");
    await act(async () => {
      const input = container.querySelector<HTMLInputElement>('[data-testid="draft-new-name"]')!;
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
      setter.call(input, "fresh");
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click("draft-create");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(posts).toHaveLength(0);
    expect(textarea().value).toBe("my unsaved edit");
    confirm.mockReturnValue(true);
    await click("draft-create");
    expect(posts).toHaveLength(1);
    expect(textarea().value).toBe("");
    confirm.mockRestore();
  });

  it("a save answered after the person switched drafts is not applied to the new draft", async () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    await start();
    await type("alpha edited");
    holdNextPost = true;
    await click("draft-save"); // POST for a.md is now held open
    await select("b.md"); // person moves on; confirm accepted
    expect(textarea().value).toBe("bravo");
    await act(async () => {
      releasePost!();
      await vi.advanceTimersByTimeAsync(0);
    });
    // b.md is still what is on screen, with b's version as its base.
    expect(textarea().value).toBe("bravo");
    expect(container.querySelector('[data-testid="draft-status"]')!.textContent).not.toContain("unsaved");
    await type("bravo edited");
    await click("draft-save");
    const last = posts[posts.length - 1]!;
    expect(last.get("name")).toBe("b.md");
    expect(last.get("baseVersion")).toBe("b1");
    expect(files["a.md"]!.content).toBe("alpha edited");
    vi.restoreAllMocks();
  });

  it("a poll GET that read the old file but arrives after the person's save raises no alert", async () => {
    await start();
    await type("alpha edited");
    // Hold the next poll GET: it will answer with the OLD version a1.
    const gate = { release: () => {} };
    const realFetch = fetch as unknown as ReturnType<typeof vi.fn>;
    const inner = realFetch.getMockImplementation()!;
    let held = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        if (!held && !init?.method && String(url).includes("name=a.md")) {
          held = true;
          const snapshot = files["a.md"]!; // old state, captured before the save
          await new Promise<void>((r) => (gate.release = r));
          return json({ ok: true, draft: snapshot });
        }
        return inner(url, init);
      })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10);
    });
    await click("draft-save"); // completes while the GET is still pending
    await act(async () => {
      gate.release();
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears the removed alert when the file reappears with the same content", async () => {
    await start();
    delete files["a.md"];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10);
    });
    expect(container.querySelector('[data-testid="draft-gone"]')).not.toBeNull();
    files["a.md"] = dto({ name: "a.md", content: "alpha", version: "a1" });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DRAFT_POLL_MS + 10);
    });
    expect(container.querySelector('[data-testid="draft-gone"]')).toBeNull();
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
