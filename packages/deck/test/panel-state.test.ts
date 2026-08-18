/**
 * panel-state.test.ts - the pure layer behind per-thread side-panel
 * persistence: the restore decision and the sessionStorage read/write helpers.
 *
 * The behavioural half (open a panel, navigate away, come back) lives in
 * panel-state-persist.test.tsx under jsdom. This file stays in the default node
 * env and stubs a minimal window.sessionStorage, so the decision logic is
 * pinned without a DOM.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  PANEL_PARAMS,
  panelStorageKey,
  panelStateFromParams,
  urlCarriesPanelState,
  restoredSearchParams,
  readPanelState,
  writePanelState,
} from "~/lib/panel-state";

// ---------------------------------------------------------------------------
// Fake sessionStorage (node env has no window)
// ---------------------------------------------------------------------------

function makeFakeStorage() {
  const map = new Map<string, string>();
  return {
    map,
    storage: {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
      removeItem: (k: string) => void map.delete(k),
      clear: () => map.clear(),
      key: (i: number) => Array.from(map.keys())[i] ?? null,
      get length() {
        return map.size;
      },
    } as Storage,
  };
}

let fake: ReturnType<typeof makeFakeStorage>;

beforeEach(() => {
  fake = makeFakeStorage();
  vi.stubGlobal("window", { sessionStorage: fake.storage });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ---------------------------------------------------------------------------
// Param spec
// ---------------------------------------------------------------------------

describe("panel params", () => {
  it("covers exactly the two params the panels gate on", () => {
    // panel-state.ts declares these locally so it stays component-free and
    // node-testable. The drift guard against ReviewPanel's DOC_PARAM and
    // FilesPanel's FILES_PARAM is in panel-state-persist.test.tsx, which
    // already imports both components.
    expect([...PANEL_PARAMS]).toEqual(["doc", "files"]);
  });

  it("keys storage per thread, not globally", () => {
    expect(panelStorageKey("doc", "scribe")).toBe("mc:review-panel:scribe");
    expect(panelStorageKey("doc", "quill")).toBe("mc:review-panel:quill");
    expect(panelStorageKey("files", "scribe")).toBe("mc:files-panel:scribe");
    expect(panelStorageKey("doc", "scribe")).not.toBe(panelStorageKey("doc", "quill"));
  });
});

// ---------------------------------------------------------------------------
// Registration: the hook is actually wired into the thread route.
//
// Separate claim from behaviour. panel-state-persist.test.tsx proves the hook
// WORKS by calling it in its own harness; nothing there would notice the call
// disappearing from ThreadView, which is the only place that makes it reach a
// user. Static source assertion, same style as seam.test.ts.
// ---------------------------------------------------------------------------

describe("the hook is wired into the thread route", () => {
  const routeFile = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "..",
    "app",
    "routes",
    "threads.$agent.tsx"
  );

  it("threads.$agent.tsx imports and calls usePersistedPanelState(agent)", () => {
    const src = fs.readFileSync(routeFile, "utf8");
    expect(src).toContain('from "~/lib/panel-state"');
    expect(src).toContain("usePersistedPanelState(agent,");
  });

  // The hold argument is a THIRD claim, separate again. The behavioural suite
  // passes hold from its own ThreadStub, so the route dropping it would leave
  // that suite fully green while the live ?reply= race came straight back.
  it("holds the restore while the spent ?reply= seed is still in the URL", () => {
    const src = fs.readFileSync(routeFile, "utf8");
    expect(src).toContain("usePersistedPanelState(agent, { hold: searchParams.has(REPLY_PARAM) })");
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("panelStateFromParams", () => {
  it("picks up an open doc and an open files panel", () => {
    const params = new URLSearchParams("doc=/tmp/a.md&files=1&anchor=xyz");
    expect(panelStateFromParams(params)).toEqual({ doc: "/tmp/a.md", files: "1" });
  });

  it("returns nothing for a URL with no panel params", () => {
    expect(panelStateFromParams(new URLSearchParams("anchor=xyz"))).toEqual({});
  });

  it("drops a files value that is not the literal 1 (the panel gates on === 1)", () => {
    expect(panelStateFromParams(new URLSearchParams("files=0"))).toEqual({});
    expect(panelStateFromParams(new URLSearchParams("files=yes"))).toEqual({});
  });

  it("drops an empty doc", () => {
    expect(panelStateFromParams(new URLSearchParams("doc="))).toEqual({});
  });
});

describe("urlCarriesPanelState", () => {
  it("is true when the URL mentions either panel param, even to close it", () => {
    expect(urlCarriesPanelState(new URLSearchParams("doc=/tmp/a.md"))).toBe(true);
    expect(urlCarriesPanelState(new URLSearchParams("files=1"))).toBe(true);
    // ?files=0 is still the URL having an opinion; it must outrank storage.
    expect(urlCarriesPanelState(new URLSearchParams("files=0"))).toBe(true);
  });

  it("is false for a URL with no panel params", () => {
    expect(urlCarriesPanelState(new URLSearchParams(""))).toBe(false);
    expect(urlCarriesPanelState(new URLSearchParams("anchor=xyz&debug=1"))).toBe(false);
  });
});

describe("restoredSearchParams", () => {
  it("restores a remembered doc into a clean URL", () => {
    const next = restoredSearchParams(new URLSearchParams(""), { doc: "/tmp/a.md" });
    expect(next?.get("doc")).toBe("/tmp/a.md");
    expect(next?.has("files")).toBe(false);
  });

  it("restores both panels when both were open", () => {
    const next = restoredSearchParams(new URLSearchParams(""), {
      doc: "/tmp/a.md",
      files: "1",
    });
    expect(next?.get("doc")).toBe("/tmp/a.md");
    expect(next?.get("files")).toBe("1");
  });

  it("preserves unrelated params it did not put there", () => {
    const next = restoredSearchParams(new URLSearchParams("anchor=xyz"), { files: "1" });
    expect(next?.get("anchor")).toBe("xyz");
    expect(next?.get("files")).toBe("1");
  });

  it("leaves a deep link alone - the URL wins over stored state", () => {
    // Shared link opens exactly the doc it names, even with another one stored.
    expect(
      restoredSearchParams(new URLSearchParams("doc=/tmp/shared.md"), { doc: "/tmp/a.md" })
    ).toBeNull();
    // A URL that explicitly opens the files panel is not topped up with a doc.
    expect(
      restoredSearchParams(new URLSearchParams("files=1"), { doc: "/tmp/a.md" })
    ).toBeNull();
  });

  it("does nothing when this thread has nothing remembered", () => {
    expect(restoredSearchParams(new URLSearchParams("anchor=xyz"), {})).toBeNull();
  });

  it("does nothing when the remembered value is junk", () => {
    expect(restoredSearchParams(new URLSearchParams(""), { files: "0" })).toBeNull();
    expect(restoredSearchParams(new URLSearchParams(""), { doc: "" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Storage helpers
// ---------------------------------------------------------------------------

describe("readPanelState / writePanelState", () => {
  it("round-trips one thread's open panels", () => {
    writePanelState("scribe", { doc: "/tmp/a.md", files: "1" });
    expect(readPanelState("scribe")).toEqual({ doc: "/tmp/a.md", files: "1" });
  });

  it("keeps threads independent - quill never sees scribe's doc", () => {
    writePanelState("scribe", { doc: "/tmp/a.md" });
    expect(readPanelState("quill")).toEqual({});
  });

  it("deletes the key for a panel that is no longer open (the explicit-close path)", () => {
    writePanelState("scribe", { doc: "/tmp/a.md", files: "1" });
    writePanelState("scribe", { files: "1" });
    expect(readPanelState("scribe")).toEqual({ files: "1" });
    expect(fake.map.has("mc:review-panel:scribe")).toBe(false);
  });

  it("ignores a junk files value someone put in storage by hand", () => {
    fake.map.set("mc:files-panel:scribe", "yes");
    expect(readPanelState("scribe")).toEqual({});
  });

  it("ignores an over-long doc rather than restoring an absurd URL", () => {
    fake.map.set("mc:review-panel:scribe", "/tmp/" + "x".repeat(4000) + ".md");
    expect(readPanelState("scribe")).toEqual({});
  });

  it("is a no-op with no window (SSR) instead of throwing", () => {
    vi.unstubAllGlobals();
    expect(() => writePanelState("scribe", { doc: "/tmp/a.md" })).not.toThrow();
    expect(readPanelState("scribe")).toEqual({});
  });

  it("survives storage that throws (private browsing, blocked storage)", () => {
    vi.stubGlobal("window", {
      get sessionStorage(): Storage {
        throw new Error("blocked");
      },
    });
    expect(() => writePanelState("scribe", { doc: "/tmp/a.md" })).not.toThrow();
    expect(readPanelState("scribe")).toEqual({});
  });
});
