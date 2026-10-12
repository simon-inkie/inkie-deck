/**
 * file-window.test.ts - PURE windowing math for the Files panel virtualization.
 *
 * Covers the bounded-mount acceptance criterion directly (no jsdom needed): a
 * 300-row manifest must yield a small, bounded rendered slice regardless of
 * total size, with exact spacer heights derived from the bimodal row height.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect } from "vitest";
import {
  computeWindow,
  rowHeight,
  isImageRowExt,
  IMAGE_ROW_HEIGHT,
  TEXT_ROW_HEIGHT,
  DEFAULT_OVERSCAN,
} from "~/lib/file-window";

describe("rowHeight / isImageRowExt", () => {
  it("image extensions get the tile height", () => {
    for (const ext of [".png", ".jpg", ".jpeg", ".gif", ".webp", ".PNG"]) {
      expect(isImageRowExt(ext)).toBe(true);
      expect(rowHeight(ext)).toBe(IMAGE_ROW_HEIGHT);
    }
  });
  it("non-image extensions get the text-row height", () => {
    for (const ext of [".md", ".ts", ".txt", ".pdf", ".json", ""]) {
      expect(isImageRowExt(ext)).toBe(false);
      expect(rowHeight(ext)).toBe(TEXT_ROW_HEIGHT);
    }
  });
});

describe("computeWindow - bounded mount regardless of manifest size", () => {
  it("mounts far fewer than 300 rows for a 300-ref manifest", () => {
    const exts = Array.from({ length: 300 }, () => ".md");
    const viewportHeight = 600;
    const win = computeWindow(exts, 0, viewportHeight);

    const mounted = win.end - win.start;
    // Bound: viewportHeight / TEXT_ROW_HEIGHT + 2 * overscan, generous slack.
    const bound = Math.ceil(viewportHeight / TEXT_ROW_HEIGHT) + 2 * DEFAULT_OVERSCAN;
    expect(mounted).toBeLessThanOrEqual(bound);
    expect(mounted).toBeLessThan(50);
    expect(mounted).toBeGreaterThan(0);
  });

  it("the mounted count stays bounded no matter how large the manifest grows", () => {
    const viewportHeight = 600;
    const small = computeWindow(Array.from({ length: 40 }, () => ".md"), 0, viewportHeight);
    const huge = computeWindow(Array.from({ length: 5000 }, () => ".md"), 0, viewportHeight);
    expect(huge.end - huge.start).toBe(small.end - small.start);
  });

  it("totalHeight is the exact sum of per-row heights (mixed image + text)", () => {
    const exts = [".md", ".png", ".txt", ".jpg"];
    const win = computeWindow(exts, 0, 600);
    expect(win.totalHeight).toBe(
      TEXT_ROW_HEIGHT + IMAGE_ROW_HEIGHT + TEXT_ROW_HEIGHT + IMAGE_ROW_HEIGHT
    );
  });

  it("topPad + mounted rows' height + bottomPad == totalHeight (no drift)", () => {
    const exts = Array.from({ length: 200 }, (_, i) => (i % 5 === 0 ? ".png" : ".md"));
    const win = computeWindow(exts, 4000, 600);
    let mountedHeight = 0;
    for (let i = win.start; i < win.end; i++) mountedHeight += rowHeight(exts[i]!);
    expect(win.topPad + mountedHeight + win.bottomPad).toBe(win.totalHeight);
  });

  it("window advances as scrollTop grows (later rows come into view)", () => {
    const exts = Array.from({ length: 300 }, () => ".md");
    const top = computeWindow(exts, 0, 600);
    const mid = computeWindow(exts, 300 * TEXT_ROW_HEIGHT * 0.5, 600);
    expect(mid.start).toBeGreaterThan(top.start);
    // topPad matches the offset of the first mounted row exactly.
    expect(mid.topPad).toBe(mid.start * TEXT_ROW_HEIGHT);
  });

  it("includes overscan rows before the strictly-visible first row", () => {
    const exts = Array.from({ length: 300 }, () => ".md");
    // Scroll so the strictly-visible first row is index 50.
    const win = computeWindow(exts, 50 * TEXT_ROW_HEIGHT, 600);
    expect(win.start).toBe(50 - DEFAULT_OVERSCAN);
  });

  it("clamps at the ends (no negative start, no over-run end)", () => {
    const exts = Array.from({ length: 10 }, () => ".md");
    const win = computeWindow(exts, 0, 600);
    expect(win.start).toBe(0);
    expect(win.end).toBe(10);
    expect(win.topPad).toBe(0);
    expect(win.bottomPad).toBe(0);
  });

  it("empty manifest yields a zero window", () => {
    const win = computeWindow([], 0, 600);
    expect(win).toEqual({ start: 0, end: 0, topPad: 0, bottomPad: 0, totalHeight: 0 });
  });
});
