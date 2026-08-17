// @vitest-environment jsdom
/**
 * panel-state-persist.test.tsx - behaviour: an agent thread's side panels
 * survive navigating away and back.
 *
 * The bug: the review panel (?doc=) and the Files panel (?files=1) keep their
 * open state ONLY in the thread route's URL search params, so leaving the
 * thread and returning always rendered them closed.
 *
 * The fix: usePersistedPanelState(agent) mirrors those two params into
 * sessionStorage per thread and restores them on re-entry when the incoming URL
 * has no panel opinion of its own.
 *
 * This suite drives the REAL ReviewPanel and the REAL FilesPanel inside a
 * createRoutesStub router, with real navigations between two threads and an
 * off-thread route, so what is proven is the user-visible behaviour and not a
 * restatement of the hook. Like review-panel-rerender.test.tsx, it opts this one
 * file into jsdom via the docblock above; the node suites are untouched.
 *
 * No CSS under jsdom, so BOTH responsive branches of each panel mount (mobile
 * sheet + desktop column). Assertions are therefore existence-based, never
 * element-count-based.
 *
 * ASCII only - no em-dashes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act, useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createRoutesStub,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";

// Markdown is expensive and irrelevant here; render its children as text so we
// can assert WHICH doc is showing.
vi.mock("~/components/Markdown", () => ({
  Markdown: ({ children }: { children?: React.ReactNode }) =>
    React.createElement("div", { "data-testid": "md-body" }, children),
}));

// Import AFTER the mock is registered.
import { ReviewPanel, DOC_PARAM } from "~/components/ReviewPanel";
import { FilesPanel, FILES_PARAM } from "~/components/FilesPanel";
import { PANEL_PARAMS, usePersistedPanelState, panelStorageKey } from "~/lib/panel-state";
import { ANCHOR_PARAM, REPLY_PARAM, buildCardReplyHref } from "~/lib/card-reply-link";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT =
  true;

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DOC_A = "/attachments/alpha.md";
const DOC_B = "/attachments/bravo.md";
const CARD_ID = "dec-2026-08-17-001";
const CONTENT_A = "ALPHA DOC BODY";
const CONTENT_B = "BRAVO DOC BODY";
const NOW = "2026-08-17T12:00:00Z";

let container: HTMLDivElement;
// Undefined for the one test that asserts a constant without rendering.
let root: Root | undefined;

beforeEach(() => {
  window.sessionStorage.clear();
  container = document.createElement("div");
  document.body.appendChild(container);
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      // FilesPanel's manifest load. An empty manifest is enough: the panel
      // still mounts and renders, and no per-row describe POST fires.
      if (href.startsWith("/api/file-manifest")) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ ok: true, agent: "x", rows: [], pins: [] }),
        } as Response);
      }
      // ReviewPanel's attachment-doc text fetch.
      void init;
      return Promise.resolve({
        ok: true,
        text: () => Promise.resolve(href === DOC_B ? CONTENT_B : CONTENT_A),
      } as Response);
    })
  );
});

afterEach(() => {
  const mounted = root;
  if (mounted !== undefined) act(() => mounted.unmount());
  root = undefined;
  container.remove();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(testid: string) {
  const el = container.querySelector<HTMLElement>(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`no element with data-testid=${testid}`);
  el.click();
}

/** Click the first element matching an aria-label (both responsive branches mount). */
function clickLabelled(label: string) {
  const el = container.querySelector<HTMLElement>(`[aria-label="${label}"]`);
  if (!el) throw new Error(`no element with aria-label=${label}`);
  el.click();
}

function has(testid: string): boolean {
  return container.querySelector(`[data-testid="${testid}"]`) !== null;
}

function search(): URLSearchParams {
  const raw = container.querySelector('[data-testid="search"]')?.textContent ?? "";
  return new URLSearchParams(raw);
}

function currentAgent(): string {
  return container.querySelector('[data-testid="agent"]')?.textContent ?? "";
}

/** The settled URL fragment, as the route's own useLocation sees it. */
function hash(): string {
  return container.querySelector('[data-testid="hash"]')?.textContent ?? "";
}

function bodyText(): string {
  return Array.from(container.querySelectorAll('[data-testid="md-body"]'))
    .map((n) => n.textContent ?? "")
    .join("|");
}

// ---------------------------------------------------------------------------
// Harness: a thread route that mounts both real panels, plus an off-thread route
// ---------------------------------------------------------------------------

function NavButtons() {
  const navigate = useNavigate();
  return (
    <>
      <button data-testid="go-away" onClick={() => navigate("/")}>
        away
      </button>
      <button data-testid="go-scribe" onClick={() => navigate("/threads/scribe")}>
        scribe
      </button>
      <button data-testid="go-quill" onClick={() => navigate("/threads/quill")}>
        quill
      </button>
      <button
        data-testid="go-scribe-deeplink"
        onClick={() => navigate(`/threads/scribe?${DOC_PARAM}=${DOC_B}`)}
      >
        scribe deep link
      </button>
      <button
        data-testid="go-scribe-cardreply"
        onClick={() => navigate(buildCardReplyHref("scribe", CARD_ID))}
      >
        scribe card reply
      </button>
      <button
        data-testid="go-scribe-hash"
        onClick={() => navigate(`/threads/scribe#${encodeURIComponent(CARD_ID)}`)}
      >
        scribe hash deep link
      </button>
    </>
  );
}

/**
 * Stand-in for ThreadView: same hook call in the same position (after the
 * route's other search-param effects), the same two panels, and the same
 * URL-only open state. Everything the hook touches is real.
 *
 * The ?reply= strip effect below is a faithful copy of the one in
 * threads.$agent.tsx: same consume-once ref, same
 * `new URLSearchParams(searchParams)` render-time base, same
 * navigate(replace, preventScrollReset), and DECLARED ABOVE the
 * usePersistedPanelState call exactly as it is in the route. The only thing
 * dropped is canSeedCardReply (it gates the composer state, never the URL
 * mutation), and setRespondingToDecisionId is a plain useState stand-in so the
 * seed is observable. Without this the harness cannot see the two effects
 * colliding, which is the whole point of the reply-collision suite below.
 */
function ThreadStub() {
  const { agent = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  const [seededReply, setSeededReply] = useState("");

  const replySeedRef = useRef("");
  useEffect(() => {
    const replyId = searchParams.get(REPLY_PARAM);
    if (replyId === null || replyId === "") return;
    const seedKey = `${agent}:${replyId}`;
    if (replySeedRef.current === seedKey) return;
    replySeedRef.current = seedKey;

    setSeededReply(replyId);

    const next = new URLSearchParams(searchParams);
    next.delete(REPLY_PARAM);
    const nextSearch = next.toString();
    navigate(
      { search: nextSearch === "" ? "" : `?${nextSearch}`, hash: location.hash },
      { replace: true, preventScrollReset: true }
    );
  }, [agent, searchParams, navigate, location.hash]);

  usePersistedPanelState(agent, { hold: searchParams.has(REPLY_PARAM) });

  return (
    <div>
      <span data-testid="agent">{agent}</span>
      <span data-testid="search">{searchParams.toString()}</span>
      <span data-testid="hash">{location.hash}</span>
      <span data-testid="seeded-reply">{seededReply}</span>
      <NavButtons />
      <button
        data-testid="open-doc"
        onClick={() =>
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set(DOC_PARAM, DOC_A);
            return next;
          })
        }
      >
        open doc
      </button>
      <button
        data-testid="open-files"
        onClick={() =>
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set(FILES_PARAM, "1");
            return next;
          })
        }
      >
        open files
      </button>
      <ReviewPanel />
      <FilesPanel agent={agent} now={NOW} />
    </div>
  );
}

function AwayStub() {
  return (
    <div>
      <span data-testid="agent">away</span>
      <span data-testid="search"></span>
      <NavButtons />
    </div>
  );
}

async function renderAt(entry: string) {
  const Stub = createRoutesStub([
    { path: "/threads/:agent", Component: ThreadStub },
    { path: "/", Component: AwayStub },
  ]);
  await act(async () => {
    root = createRoot(container);
    root.render(<Stub initialEntries={[entry]} />);
  });
  await flush();
}

/** Leave the thread for an unrelated route and come back to `testid`. */
async function leaveAndReturn(returnTestid: string) {
  await act(async () => click("go-away"));
  await flush();
  expect(currentAgent()).toBe("away");
  await act(async () => click(returnTestid));
  await flush();
}

// ---------------------------------------------------------------------------
// Drift guard
// ---------------------------------------------------------------------------

describe("persisted params match the panels", () => {
  it("persists exactly the params ReviewPanel and FilesPanel gate on", () => {
    expect([...PANEL_PARAMS]).toEqual([DOC_PARAM, FILES_PARAM]);
  });
});

// ---------------------------------------------------------------------------
// The reported bug
// ---------------------------------------------------------------------------

describe("side-panel state survives navigating away and back", () => {
  it("restores the open doc when you return to the same thread", async () => {
    await renderAt("/threads/scribe");
    expect(has("review-panel")).toBe(false);

    await act(async () => click("open-doc"));
    await flush();
    expect(search().get(DOC_PARAM)).toBe(DOC_A);
    expect(has("review-panel")).toBe(true);
    expect(bodyText()).toContain(CONTENT_A);

    await leaveAndReturn("go-scribe");

    // Pre-fix this returned to a bare /threads/scribe with no doc param.
    expect(search().get(DOC_PARAM)).toBe(DOC_A);
    expect(has("review-panel")).toBe(true);
    expect(bodyText()).toContain(CONTENT_A);
  });

  it("restores the open Files panel when you return to the same thread", async () => {
    await renderAt("/threads/scribe");
    expect(has("files-panel")).toBe(false);

    await act(async () => click("open-files"));
    await flush();
    expect(has("files-panel")).toBe(true);

    await leaveAndReturn("go-scribe");

    expect(search().get(FILES_PARAM)).toBe("1");
    expect(has("files-panel")).toBe(true);
  });

  it("restores both panels together when both were open", async () => {
    await renderAt("/threads/scribe");
    await act(async () => click("open-doc"));
    await flush();
    await act(async () => click("open-files"));
    await flush();

    await leaveAndReturn("go-scribe");

    expect(search().get(DOC_PARAM)).toBe(DOC_A);
    expect(search().get(FILES_PARAM)).toBe("1");
    expect(has("review-panel")).toBe(true);
    expect(has("files-panel")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Scope decision: per thread, never across threads
// ---------------------------------------------------------------------------

describe("per-thread scope", () => {
  it("does not carry a thread's open doc across to a different agent's thread", async () => {
    await renderAt("/threads/scribe");
    await act(async () => click("open-doc"));
    await flush();
    expect(has("review-panel")).toBe(true);

    await act(async () => click("go-quill"));
    await flush();

    // Quill's thread is unaffected: no inherited doc, no panel.
    expect(currentAgent()).toBe("quill");
    expect(search().has(DOC_PARAM)).toBe(false);
    expect(has("review-panel")).toBe(false);

    // And scribe still remembers its own.
    await act(async () => click("go-scribe"));
    await flush();
    expect(currentAgent()).toBe("scribe");
    expect(search().get(DOC_PARAM)).toBe(DOC_A);
    expect(has("review-panel")).toBe(true);
  });

  it("keeps two threads' panel state independent", async () => {
    await renderAt("/threads/scribe");
    await act(async () => click("open-doc"));
    await flush();

    // Open only the Files panel on quill.
    await act(async () => click("go-quill"));
    await flush();
    await act(async () => click("open-files"));
    await flush();

    await act(async () => click("go-scribe"));
    await flush();
    expect(search().get(DOC_PARAM)).toBe(DOC_A);
    expect(search().has(FILES_PARAM)).toBe(false);

    await act(async () => click("go-quill"));
    await flush();
    expect(search().get(FILES_PARAM)).toBe("1");
    expect(search().has(DOC_PARAM)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// A deliberately closed panel stays closed
// ---------------------------------------------------------------------------

describe("explicit close is respected", () => {
  it("does not resurrect a doc panel the user closed", async () => {
    await renderAt("/threads/scribe");
    await act(async () => click("open-doc"));
    await flush();
    expect(has("review-panel")).toBe(true);

    await act(async () => clickLabelled("Close review panel"));
    await flush();
    expect(has("review-panel")).toBe(false);
    expect(window.sessionStorage.getItem(panelStorageKey("doc", "scribe"))).toBeNull();

    await leaveAndReturn("go-scribe");

    expect(search().has(DOC_PARAM)).toBe(false);
    expect(has("review-panel")).toBe(false);
  });

  it("does not resurrect a Files panel the user closed", async () => {
    await renderAt("/threads/scribe");
    await act(async () => click("open-files"));
    await flush();
    expect(has("files-panel")).toBe(true);

    await act(async () => clickLabelled("Close files panel"));
    await flush();
    expect(has("files-panel")).toBe(false);

    await leaveAndReturn("go-scribe");

    expect(search().has(FILES_PARAM)).toBe(false);
    expect(has("files-panel")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Deep-linking is unchanged
// ---------------------------------------------------------------------------

describe("the URL still wins", () => {
  it("opens exactly the doc a shared link names, not the remembered one", async () => {
    await renderAt("/threads/scribe");
    await act(async () => click("open-doc"));
    await flush();
    expect(search().get(DOC_PARAM)).toBe(DOC_A);

    // Land on the same thread through a link that names a different doc.
    await act(async () => click("go-away"));
    await flush();
    await act(async () => click("go-scribe-deeplink"));
    await flush();

    expect(search().get(DOC_PARAM)).toBe(DOC_B);
    expect(bodyText()).toContain(CONTENT_B);
    expect(bodyText()).not.toContain(CONTENT_A);

    // The link's doc becomes what this thread remembers from now on.
    await leaveAndReturn("go-scribe");
    expect(search().get(DOC_PARAM)).toBe(DOC_B);
  });

  it("opens a deep link on a first visit with nothing stored", async () => {
    await renderAt(`/threads/scribe?${DOC_PARAM}=${DOC_B}`);
    expect(search().get(DOC_PARAM)).toBe(DOC_B);
    expect(has("review-panel")).toBe(true);
    expect(bodyText()).toContain(CONTENT_B);
  });
});

// ---------------------------------------------------------------------------
// The restore must not eat the #<decisionId> scroll target
// ---------------------------------------------------------------------------
//
// /threads/<agent>#<decisionId> is the needs-you deep link, and the route's
// anchor effect is the only thing that scrolls that card into view. It returns
// early on an empty location.hash and cannot recover one that has been dropped,
// so any navigation on this route that resolves to a search-only target
// silently destroys the deep link. Pinned here because a lost hash is invisible
// to every other assertion in this file: the panel comes back, the params look
// right, and only the scroll target is gone.

describe("restore preserves the URL hash", () => {
  const HASH = `#${encodeURIComponent(CARD_ID)}`;

  it("keeps the hash when the remembered panel is restored on entry", async () => {
    window.sessionStorage.setItem(panelStorageKey("doc", "scribe"), DOC_A);

    await renderAt(`/threads/scribe${HASH}`);
    await flush();

    // The restore happened...
    expect(search().get(DOC_PARAM)).toBe(DOC_A);
    expect(has("review-panel")).toBe(true);
    // ...and it did not take the anchor effect's scroll target with it.
    expect(hash()).toBe(HASH);
  });

  it("keeps the hash on a thread with nothing remembered", async () => {
    // Control: no stored state means no restore navigation at all. If this ever
    // goes red the harness or the router is losing the hash, not the hook.
    await renderAt(`/threads/scribe${HASH}`);
    await flush();

    expect(search().has(DOC_PARAM)).toBe(false);
    expect(hash()).toBe(HASH);
  });

  it("keeps the hash when the deep link arrives from another route", async () => {
    window.sessionStorage.setItem(panelStorageKey("files", "scribe"), "1");

    // A client-side navigation in, not an initial mount: the restore runs on
    // the same commit the hash arrives.
    await renderAt("/threads/quill");
    await act(async () => click("go-scribe-hash"));
    await flush();

    expect(currentAgent()).toBe("scribe");
    expect(search().get(FILES_PARAM)).toBe("1");
    expect(has("files-panel")).toBe(true);
    expect(hash()).toBe(HASH);
  });
});

// ---------------------------------------------------------------------------
// Collision with the ?reply= strip effect
// ---------------------------------------------------------------------------
//
// Two effects in ThreadView independently replace-navigate off a RENDER-TIME
// searchParams snapshot: the reply-seed strip (drops ?reply=) and this hook's
// restore (adds ?doc= / ?files=). When a card-reply link lands on a thread that
// also has remembered panel state, both fire in the SAME effect flush, and
// neither snapshot contains the other's pending change. The later navigation
// wins outright, so one of the two param edits is lost - and if the restore is
// the winner it carries the stale ?reply= back into the URL, which the strip
// effect will never remove again (its consume-once ref is already spent for
// that id).
//
// These tests pin the SETTLED URL, not the mechanism: reply gone, panel back,
// anchor and hash untouched.

describe("restore does not collide with the ?reply= strip", () => {
  it("strips reply AND restores the remembered doc when both land together", async () => {
    // Thread scribe remembers an open doc, as if the user had been reading it.
    window.sessionStorage.setItem(panelStorageKey("doc", "scribe"), DOC_A);

    await renderAt(`/threads/scribe?${REPLY_PARAM}=${CARD_ID}`);
    await flush();

    // The seed was consumed (the composer opened in card-reply mode)...
    expect(container.querySelector('[data-testid="seeded-reply"]')?.textContent).toBe(
      CARD_ID
    );
    // ...and the spent seed is gone from the URL.
    expect(search().has(REPLY_PARAM)).toBe(false);
    // ...while the remembered panel still came back.
    expect(search().get(DOC_PARAM)).toBe(DOC_A);
    expect(has("review-panel")).toBe(true);
    expect(bodyText()).toContain(CONTENT_A);
  });

  it("strips reply AND restores the Files panel, preserving anchor and hash", async () => {
    window.sessionStorage.setItem(panelStorageKey("files", "scribe"), "1");

    // The real link shape from buildCardReplyHref: anchor + reply + #hash.
    await renderAt(buildCardReplyHref("scribe", CARD_ID));
    await flush();

    expect(search().has(REPLY_PARAM)).toBe(false);
    expect(search().get(FILES_PARAM)).toBe("1");
    expect(has("files-panel")).toBe(true);
    // The loader's window cursor is not collateral damage.
    expect(search().get(ANCHOR_PARAM)).toBe(CARD_ID);
    // Neither is the scroll target: the strip effect hands the hash on, and the
    // restore that runs after it must not drop it.
    expect(hash()).toBe(`#${encodeURIComponent(CARD_ID)}`);
  });

  it("does not resurrect reply when arriving from another thread", async () => {
    window.sessionStorage.setItem(panelStorageKey("doc", "scribe"), DOC_A);

    // Start elsewhere so the restore runs on a client-side navigation into the
    // thread, not on the initial mount.
    await renderAt("/threads/quill");
    await act(async () => click("go-scribe-cardreply"));
    await flush();
    await flush();

    expect(currentAgent()).toBe("scribe");
    expect(search().has(REPLY_PARAM)).toBe(false);
    expect(search().get(DOC_PARAM)).toBe(DOC_A);
  });

  it("still strips reply on a thread with nothing remembered", async () => {
    // The plain path, unchanged by panel persistence: no stored state, no
    // restore.
    await renderAt(`/threads/scribe?${REPLY_PARAM}=${CARD_ID}`);
    await flush();

    expect(search().has(REPLY_PARAM)).toBe(false);
    expect(search().has(DOC_PARAM)).toBe(false);
    expect(has("review-panel")).toBe(false);
  });
});
