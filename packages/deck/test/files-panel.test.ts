/**
 * files-panel.test.ts - Static source-inspection contract for FilesPanel.tsx.
 *
 * No jsdom available - vitest env is "node". Asserts that the FileRow
 * component uses role="button" + onKeyDown + stopPropagation on the pin
 * button, matching the full-row-click spec from the file-pinner post-ship
 * bug-fix (commit 5).
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const FILES_PANEL_SRC = fs.readFileSync(
  path.join(REPO_ROOT, "app", "components", "FilesPanel.tsx"),
  "utf8"
);

describe("FilesPanel FileRow - full-row click contract (static source check)", () => {
  it('row container uses role="button" making the whole row a clickable target', () => {
    expect(FILES_PANEL_SRC).toContain('role="button"');
  });

  it("row container has tabIndex={0} for keyboard accessibility", () => {
    expect(FILES_PANEL_SRC).toContain("tabIndex={0}");
  });

  it("row container has an onKeyDown handler for Enter/Space activation", () => {
    expect(FILES_PANEL_SRC).toContain("onKeyDown=");
    expect(FILES_PANEL_SRC).toContain('"Enter"');
    expect(FILES_PANEL_SRC).toContain('" "');
  });

  it("pin button calls e.stopPropagation() to prevent row-open on pin", () => {
    expect(FILES_PANEL_SRC).toContain("e.stopPropagation()");
  });

  it("row has hover:bg-muted/60 hover state", () => {
    expect(FILES_PANEL_SRC).toContain("hover:bg-muted/60");
  });

  it("row has cursor-pointer class", () => {
    expect(FILES_PANEL_SRC).toContain("cursor-pointer");
  });

  it("data-testid=files-panel-row is retained", () => {
    expect(FILES_PANEL_SRC).toContain('data-testid="files-panel-row"');
  });

  it("pin button retains its aria-label and aria-pressed attributes", () => {
    expect(FILES_PANEL_SRC).toContain("aria-label={pinned");
    expect(FILES_PANEL_SRC).toContain("aria-pressed={pinned}");
  });
});

describe("FilesPanel FileRow - image tile contract (static source check)", () => {
  it("routes the image-tile decision through the shared isImageRowExt helper", () => {
    // The image-extension set moved to app/lib/file-window.ts so the tile
    // decision and the virtualization row-height math cannot diverge. The
    // extension coverage (png/jpg/jpeg/gif/webp) is asserted in
    // file-window.test.ts; here we assert FilesPanel consumes that shared helper.
    expect(FILES_PANEL_SRC).toContain("isImageRowExt(row.ext)");
    expect(FILES_PANEL_SRC).toContain('from "~/lib/file-window"');
  });

  it("image rows render an <img tag", () => {
    expect(FILES_PANEL_SRC).toMatch(/<img/);
  });

  it("image src uses /attachments/ path directly or /api/review-asset fallback", () => {
    expect(FILES_PANEL_SRC).toContain('"/attachments/"');
    expect(FILES_PANEL_SRC).toContain("/api/review-asset");
  });

  it("image has object-cover for full-bleed cropping", () => {
    expect(FILES_PANEL_SRC).toContain("object-cover");
  });

  it("image has loading=lazy", () => {
    expect(FILES_PANEL_SRC).toContain('loading="lazy"');
  });

  it("image has onError handler to hide broken images gracefully", () => {
    expect(FILES_PANEL_SRC).toContain("onError=");
    expect(FILES_PANEL_SRC).toContain('style.display = "none"');
  });

  it("image tile uses h-44 fixed height for full-bleed tile", () => {
    expect(FILES_PANEL_SRC).toContain("h-44");
  });

  it("image tile has absolute inset-0 cover layout for full-bleed fill", () => {
    expect(FILES_PANEL_SRC).toContain("absolute inset-0 h-full w-full object-cover");
  });

  it("hover overlay has bg-black/60 translucent background", () => {
    expect(FILES_PANEL_SRC).toContain("bg-black/60");
  });

  it("hover overlay is revealed on group-hover:opacity-100", () => {
    expect(FILES_PANEL_SRC).toContain("group-hover:opacity-100");
  });

  it("outer row has group class for hover overlay trigger", () => {
    expect(FILES_PANEL_SRC).toContain('"group relative block w-full cursor-pointer overflow-hidden border-b border-border"');
  });

  it("persistent gradient caption is always visible (not hover-gated)", () => {
    expect(FILES_PANEL_SRC).toContain("from-black/70 to-transparent");
  });

  it("pin button has z-10 to sit above the overlays", () => {
    expect(FILES_PANEL_SRC).toContain("z-10");
  });

  it("pin button has absolute right-2 top-2 positioning over the image", () => {
    expect(FILES_PANEL_SRC).toContain("absolute right-2 top-2 z-10");
  });

  it("pin button has bg-black/45 legible over image", () => {
    expect(FILES_PANEL_SRC).toContain("bg-black/45");
  });

  it("pinned image row gets a ring indicator", () => {
    expect(FILES_PANEL_SRC).toContain("ring-2 ring-primary ring-inset");
  });

  it("row container still has role=button after restructure", () => {
    expect(FILES_PANEL_SRC).toContain('role="button"');
  });

  it("row container still has onKeyDown after restructure", () => {
    expect(FILES_PANEL_SRC).toContain("onKeyDown=");
  });

  it("pin button still has e.stopPropagation() after restructure", () => {
    expect(FILES_PANEL_SRC).toContain("e.stopPropagation()");
  });

  it("data-testid=files-panel-row is still present after restructure", () => {
    expect(FILES_PANEL_SRC).toContain('data-testid="files-panel-row"');
  });

  it("non-image rows retain the hover:bg-muted/60 hover state (media-object branch)", () => {
    expect(FILES_PANEL_SRC).toContain("hover:bg-muted/60");
  });
});
