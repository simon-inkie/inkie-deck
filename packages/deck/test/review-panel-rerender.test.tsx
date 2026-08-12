// @vitest-environment jsdom
/**
 * review-panel-rerender.test.tsx - TASK-705 render-cascade regression test.
 *
 * The bug: severe composer typing lag when a large markdown doc is open in the
 * review panel. Root cause was a re-render cascade, NOT a missing memo. Chain:
 *
 *   ThreadView (re-renders on every keystroke via setLiveDraft)
 *     -> ReviewPanel      (was a plain function, no memo -> re-rendered too)
 *       -> PanelContent   (was a plain function, no memo -> re-rendered too)
 *         -> Markdown     (memoised, but its memo was DEFEATED because onOpenDoc
 *                          was a brand-new inline closure on every ReviewPanel
 *                          render, so the whole doc was re-parsed per keystroke)
 *
 * The fix (TASK-705): memo(ReviewPanel) [zero props, always compares equal],
 * useCallback on the two handlers, and memo(PanelContent).
 *
 * This suite proves the fix at runtime with a render-count seam: Markdown is
 * mocked with a counter, so we measure exactly how many times the (formerly
 * expensive) Markdown branch is reached.
 *
 * Why a jsdom env + createRoutesStub: ReviewPanel/PanelContent use
 * useSearchParams + useFetcher, so they need real React reconciliation and a
 * router context. The rest of this repo's tests are node-only (see the header of
 * review-panel.test.ts); this one file opts into jsdom via the docblock above so
 * the ~1300 node tests are untouched.
 *
 * No CSS is loaded under jsdom, so BOTH responsive branches of ReviewPanel (the
 * mobile sheet and the desktop panel) mount, which means PanelContent - and thus
 * the Markdown mock - renders twice for a single open doc. Every assertion is
 * therefore RELATIVE (before vs after), never an absolute count.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { useSearchParams, createRoutesStub } from "react-router";

// Render-count seam. vi.hoisted so the counter exists before the hoisted
// vi.mock factory runs.
const seam = vi.hoisted(() => ({ markdownRenders: 0 }));

// Replace the real (expensive) Markdown with a counter that renders its children
// as plain text so we can also assert WHICH doc content is showing. Counting
// invocations of this mock == counting how often the doc-parse branch is reached.
vi.mock("~/components/Markdown", () => ({
  Markdown: ({ children }: { children?: React.ReactNode }) => {
    seam.markdownRenders += 1;
    return React.createElement("div", { "data-testid": "md-body" }, children);
  },
}));

// Import AFTER the mock is registered.
import { ReviewPanel, PanelContent } from "~/components/ReviewPanel";

// React needs to know it is inside an act() environment to batch correctly and
// suppress act warnings.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------

const DOC_A = "/attachments/doc-a.md";
const DOC_B = "/attachments/doc-b.md";
const CONTENT_A = "ALPHA DOC BODY";
const CONTENT_B = "BRAVO DOC BODY";

function contentFor(url: string): string {
  if (url === DOC_B) return CONTENT_B;
  return CONTENT_A;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  seam.markdownRenders = 0;
  container = document.createElement("div");
  document.body.appendChild(container);
  // Attachment docs load via fetch() inside PanelContent; stub it to return the
  // matching fixture text so the markdown branch actually mounts.
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) =>
      Promise.resolve({
        ok: true,
        text: () => Promise.resolve(contentFor(url)),
      } as Response)
    )
  );
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

/** Flush pending effects, microtasks and the stubbed fetch promise. */
async function flush() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 0));
  });
}

function click(testid: string) {
  const el = container.querySelector<HTMLButtonElement>(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`no element with data-testid=${testid}`);
  el.click();
}

function bodyText(): string {
  return Array.from(container.querySelectorAll('[data-testid="md-body"]'))
    .map((n) => n.textContent ?? "")
    .join("|");
}

// ---------------------------------------------------------------------------
// TEST A - the reported bug: a composer keystroke must NOT re-parse the doc.
// ---------------------------------------------------------------------------

/**
 * ThreadView stand-in. Holds a liveDraft counter (the real ThreadView calls
 * setLiveDraft on every keystroke, no debounce) and renders ReviewPanel as a
 * sibling, exactly like the real route. A "type" click == one keystroke.
 */
function ThreadViewStub() {
  const [liveDraft, setLiveDraft] = React.useState("");
  const [, setSearchParams] = useSearchParams();
  return (
    <div>
      <button data-testid="type-key" onClick={() => setLiveDraft((d) => d + "x")}>
        type
      </button>
      <button
        data-testid="open-b"
        onClick={() =>
          setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("doc", DOC_B);
            return next;
          })
        }
      >
        openB
      </button>
      <span data-testid="draft-len">{liveDraft.length}</span>
      <ReviewPanel />
    </div>
  );
}

async function renderThreadView() {
  const Stub = createRoutesStub([{ path: "/threads/:agent", Component: ThreadViewStub }]);
  await act(async () => {
    root = createRoot(container);
    root.render(<Stub initialEntries={[`/threads/x?doc=${DOC_A}`]} />);
  });
  await flush();
}

describe("TASK-705: ReviewPanel render-cascade", () => {
  it("does NOT re-parse the open doc on an unrelated composer keystroke", async () => {
    await renderThreadView();

    // Doc is open and parsed. Record the baseline (2 under jsdom: sheet + panel).
    const baseline = seam.markdownRenders;
    expect(baseline).toBeGreaterThan(0);
    expect(bodyText()).toContain(CONTENT_A);

    // Fire several keystrokes. Each updates liveDraft => ThreadView re-renders,
    // mirroring the real per-keystroke setLiveDraft.
    for (let i = 0; i < 6; i++) {
      await act(async () => {
        click("type-key");
      });
    }
    await flush();

    // The draft state genuinely changed (proves the keystrokes really fired and
    // re-rendered ThreadView) ...
    expect(container.querySelector('[data-testid="draft-len"]')?.textContent).toBe("6");
    // ... but Markdown was NOT invoked again: memo(ReviewPanel) skipped the whole
    // subtree. Pre-fix this count grew by 12 (both responsive branches mount
    // under jsdom, so each keystroke re-parsed the doc twice, once per branch).
    expect(seam.markdownRenders).toBe(baseline);
  });

  it("still shows the new doc when docParam actually changes (no stale freeze)", async () => {
    await renderThreadView();
    const before = seam.markdownRenders;
    expect(bodyText()).toContain(CONTENT_A);

    // A genuine navigation to a different doc must flow through and re-render.
    await act(async () => {
      click("open-b");
    });
    await flush();

    expect(seam.markdownRenders).toBeGreaterThan(before);
    expect(bodyText()).toContain(CONTENT_B);
  });
});

// ---------------------------------------------------------------------------
// TEST C (defense in depth) - PanelContent's own memo boundary. Proves the
// MECHANISM directly: a stable onOpenDoc lets the memo hold across a parent
// re-render, an unstable one defeats it (which is exactly why ReviewPanel
// wraps its handlers in useCallback).
// ---------------------------------------------------------------------------

function PanelContentHarness() {
  const [, setBump] = React.useState(0);
  const [cbVersion, setCbVersion] = React.useState(0);
  const onClose = React.useCallback(() => {}, []);
  // onOpenDoc ref only changes when cbVersion changes (stand-in for a handler
  // that is / is not useCallback-stabilised).
  const onOpenDoc = React.useMemo(() => () => {}, [cbVersion]);
  return (
    <div>
      <button data-testid="bump" onClick={() => setBump((n) => n + 1)}>
        bump
      </button>
      <button data-testid="new-cb" onClick={() => setCbVersion((n) => n + 1)}>
        newcb
      </button>
      <PanelContent docParam={DOC_A} onClose={onClose} onOpenDoc={onOpenDoc} />
    </div>
  );
}

describe("TASK-705: PanelContent memo boundary", () => {
  it("holds across a parent re-render with stable callbacks, but re-renders when onOpenDoc changes ref", async () => {
    const Stub = createRoutesStub([{ path: "/", Component: PanelContentHarness }]);
    await act(async () => {
      root = createRoot(container);
      root.render(<Stub initialEntries={["/"]} />);
    });
    await flush();

    const baseline = seam.markdownRenders;
    expect(baseline).toBeGreaterThan(0);

    // Parent re-renders with identical prop refs -> memo(PanelContent) skips ->
    // Markdown not invoked again.
    for (let i = 0; i < 4; i++) {
      await act(async () => {
        click("bump");
      });
    }
    await flush();
    expect(seam.markdownRenders).toBe(baseline);

    // Now hand PanelContent a fresh onOpenDoc reference (the pre-fix inline
    // closure behaviour) -> memo is defeated -> Markdown re-renders.
    await act(async () => {
      click("new-cb");
    });
    await flush();
    expect(seam.markdownRenders).toBeGreaterThan(baseline);
  });
});
