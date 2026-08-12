/**
 * review-panel.test.ts - Unit tests for ReviewPanel helpers (#70 fold).
 *
 * The vitest environment is "node" (no jsdom), so React components cannot be
 * rendered directly. This suite covers:
 *
 *   1. isHtmlDoc: pure unit truth table (exported from ReviewPanel.tsx).
 *      Verifies the extension check works for .html, .htm, query-strings,
 *      fragments, mixed-case, and false positives (.md, .htmlx, .txt).
 *
 *   2. ReviewPanel render contract (static source inspection): asserts that the
 *      component source contains the sandboxed-iframe branch and the prose-mc
 *      markdown branch so that a later refactor cannot silently remove one
 *      without breaking this test. Mirrors the static-analysis approach used in
 *      seam.test.ts and dashes.test.ts for logic that cannot be exercised in a
 *      headless Node environment.
 *
 *      Specifically checks:
 *        - sandbox="" (empty string - scripts AND same-origin both disabled, XSS-safe)
 *        - srcDoc attribute wired from textContent
 *        - prose-mc container retained on the markdown branch
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { isHtmlDoc, isImageDoc } from "~/components/ReviewPanel";

// ---------------------------------------------------------------------------
// isHtmlDoc unit tests
// ---------------------------------------------------------------------------

describe("isHtmlDoc", () => {
  it("returns true for a plain .html path", () => {
    expect(isHtmlDoc("/home/you/brain/doc.html")).toBe(true);
  });

  it("returns true for a plain .htm path", () => {
    expect(isHtmlDoc("/home/you/brain/index.htm")).toBe(true);
  });

  it("returns true when the extension is uppercase (.HTML)", () => {
    expect(isHtmlDoc("/some/path/README.HTML")).toBe(true);
  });

  it("returns true for .HTM (uppercase)", () => {
    expect(isHtmlDoc("/some/path/B.HTM")).toBe(true);
  });

  it("returns true for an .html path with a query string", () => {
    expect(isHtmlDoc("/some/x.html?v=1")).toBe(true);
  });

  it("returns true for an .html path with a fragment", () => {
    expect(isHtmlDoc("/some/x.html#section")).toBe(true);
  });

  it("returns true for an .html path with both query and fragment", () => {
    expect(isHtmlDoc("/some/x.html?v=2#top")).toBe(true);
  });

  it("returns true for an /attachments/ URL ending in .html", () => {
    expect(isHtmlDoc("/attachments/report.html")).toBe(true);
  });

  it("returns false for a .md path", () => {
    expect(isHtmlDoc("/home/you/brain/doc.md")).toBe(false);
  });

  it("returns false for a .txt path", () => {
    expect(isHtmlDoc("/home/you/brain/notes.txt")).toBe(false);
  });

  it("returns false for a .htmlx path (no partial match)", () => {
    expect(isHtmlDoc("/some/path/a.htmlx")).toBe(false);
  });

  it("returns false for a path where .html is only in a directory name", () => {
    expect(isHtmlDoc("/html-pages/doc.md")).toBe(false);
  });

  it("returns false for an empty string", () => {
    expect(isHtmlDoc("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isImageDoc unit tests
// ---------------------------------------------------------------------------

describe("isImageDoc", () => {
  it("returns true for a .png path", () => {
    expect(isImageDoc("/home/you/brain/a.png")).toBe(true);
  });

  it("returns true for an uppercase extension (.JPG)", () => {
    expect(isImageDoc("/home/you/B.JPG")).toBe(true);
  });

  it("returns true for .webp", () => {
    expect(isImageDoc("/some/path/x.webp")).toBe(true);
  });

  it("returns true for .gif", () => {
    expect(isImageDoc("/some/path/y.gif")).toBe(true);
  });

  it("returns true for .jpeg", () => {
    expect(isImageDoc("/some/path/z.jpeg")).toBe(true);
  });

  it("returns true for .png with a query string (?v=1)", () => {
    expect(isImageDoc("/attachments/p.png?v=1")).toBe(true);
  });

  it("returns false for a .md path", () => {
    expect(isImageDoc("/home/you/brain/a.md")).toBe(false);
  });

  it("returns false for a .html path", () => {
    expect(isImageDoc("/home/you/brain/a.html")).toBe(false);
  });

  it("returns false for .svg (explicitly excluded - asset route denies it)", () => {
    expect(isImageDoc("/some/path/a.svg")).toBe(false);
  });

  it("returns false for a .txt path", () => {
    expect(isImageDoc("/some/path/a.txt")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ReviewPanel render contract (static source inspection)
//
// Because jsdom is not available, we read the component source and assert that
// the load-bearing security and branching constraints are present in the file.
// This catches: accidental sandbox value changes, removal of the iframe branch,
// removal of the markdown branch.
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const PANEL_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "app", "components", "ReviewPanel.tsx"),
  "utf8"
);

describe("ReviewPanel - iframe render contract (static source check)", () => {
  it("renders an iframe for html docs (source contains iframe element)", () => {
    expect(PANEL_SRC).toContain("<iframe");
  });

  it('sandbox attribute is the EMPTY STRING (sandbox="") - no scripts, no same-origin', () => {
    // The empty string disables both allow-scripts and allow-same-origin.
    // This is the critical XSS-safety invariant for agent-generated HTML.
    // The attribute must appear verbatim as sandbox="" in JSX.
    expect(PANEL_SRC).toContain('sandbox=""');
  });

  it("srcDoc is used (not src) so iframe content is inlined, not fetched from a URL", () => {
    expect(PANEL_SRC).toContain("srcDoc=");
    // Ensure the iframe element itself uses srcDoc, not src.
    // We check the specific pattern "srcDoc={textContent}" rather than a
    // blanket ban on src= (which would now also catch the <img src={...}>).
    expect(PANEL_SRC).toContain("srcDoc={textContent}");
    // Confirm the iframe does NOT carry a src= attribute (the img has src, but
    // the iframe must not - it uses srcDoc for sandboxed inlining).
    expect(PANEL_SRC).not.toMatch(/<iframe[^>]* src=/);
  });

  it("markdown prose container is retained for non-html docs", () => {
    // The prose-mc container must still exist for the markdown branch.
    expect(PANEL_SRC).toContain("prose-mc");
  });

  it("isHtmlDoc gates the branch (source calls isHtmlDoc with docParam)", () => {
    expect(PANEL_SRC).toContain("isHtmlDoc(docParam)");
  });
});

describe("ReviewPanel - markdown render contract (static source check)", () => {
  it("Markdown component is still imported and used", () => {
    expect(PANEL_SRC).toContain('import { Markdown }');
    expect(PANEL_SRC).toContain("<Markdown");
  });

  it("loading and error states are unchanged (loading div present)", () => {
    expect(PANEL_SRC).toContain("Loading...");
    expect(PANEL_SRC).toContain("Document not available.");
  });
});

describe("ReviewPanel - image render contract (static source check)", () => {
  it("isImageDoc is exported and imported by the test", () => {
    // The import at the top of this file already exercises this; just confirm.
    expect(typeof isImageDoc).toBe("function");
  });

  it("renders an <img> element for image docs (source contains img element)", () => {
    expect(PANEL_SRC).toContain("<img");
  });

  it("image src uses /api/review-asset for non-attachment paths", () => {
    expect(PANEL_SRC).toContain("/api/review-asset?path=");
  });

  it("image src uses /attachments/ path directly when doc starts with /attachments/", () => {
    // The ternary chooses /attachments/ for attachment-rooted paths.
    expect(PANEL_SRC).toContain('docParam.startsWith("/attachments/") ? docParam');
  });

  it("isImage flag gates the text fetch (source skips fetch when isImageDoc)", () => {
    expect(PANEL_SRC).toContain("if (isImage) return;");
  });

  it("isLoading condition excludes image docs so they do not show perpetual Loading", () => {
    expect(PANEL_SRC).toContain("!isImage &&");
  });

  it("isImageDoc(docParam) is called to derive isImage", () => {
    expect(PANEL_SRC).toContain("isImageDoc(docParam)");
  });
});
