/**
 * files-panel-virtualization.test.ts - static source-inspection contract for the
 * FilesPanel virtualization + client-side search (Files panel perf fix).
 *
 * The vitest env is "node" (no jsdom), so - matching the existing
 * files-panel.test.ts idiom - the render WIRING is asserted by source
 * inspection while the windowing MATH is unit-tested in file-window.test.ts.
 * These two together cover the bounded-mount acceptance criterion: the math
 * bounds the slice, and this file proves the render actually maps over that
 * bounded slice (not the full ordered list) and fetches descriptions for
 * mounted rows only.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  "..",
);
const SRC = fs.readFileSync(
  path.join(REPO_ROOT, "app", "components", "FilesPanel.tsx"),
  "utf8",
);

describe("FilesPanel virtualization wiring (static source check)", () => {
  it("imports the pure windowing helpers from file-window", () => {
    expect(SRC).toContain("computeWindow");
    expect(SRC).toContain('from "~/lib/file-window"');
  });

  it("renders the WINDOWED slice, not the full ordered list", () => {
    // The bounded slice is what mounts.
    expect(SRC).toContain("visible.map((row)");
    // The old unbounded render path (mapping every ordered row) is gone.
    expect(SRC).not.toContain("ordered.map((row)");
  });

  it("mounts only rows in the computed window via ordered.slice", () => {
    expect(SRC).toContain("ordered.slice(win.start, win.end)");
  });

  it("brackets the mounted rows with topPad / bottomPad spacer divs", () => {
    expect(SRC).toContain("win.topPad");
    expect(SRC).toContain("win.bottomPad");
  });

  it("tracks scrollTop from the scroll container to drive the window", () => {
    expect(SRC).toContain("ref={scrollRef}");
    expect(SRC).toContain("onScroll=");
    expect(SRC).toContain("setScrollTop(e.currentTarget.scrollTop)");
  });

  it("measures the viewport height (drives the mounted-row bound)", () => {
    expect(SRC).toContain("setViewportHeight");
  });

  it("fires the describe POST for MOUNTED (visible) rows only, not all rows", () => {
    // The describe effect derives its missing set from the bounded `visible`
    // slice (the pre-fix version filtered the full `rows` array up front).
    expect(SRC).toContain("const missing = visible.filter(");
  });

  it("releases a cancelled in-flight describe so a scroll-back can retry", () => {
    // CR: describeStartedRef.current.add(path) ran before fetch with no cleanup,
    // so a row that scrolled out of the window before its describe landed stayed
    // marked started forever and never retried on re-entry. The effect's cleanup
    // must delete still-in-flight (unsettled) paths from the ref.
    expect(SRC).toContain("describeStartedRef.current.delete(path)");
    // ...only for paths that did not reach a terminal outcome this run, so a
    // completed/failed row is not released into a retry-loop.
    expect(SRC).toContain("if (!settled.has(path))");
    // The cleanup that performs the release is the describe effect's teardown.
    const cleanupIdx = SRC.indexOf("describeStartedRef.current.delete(path)");
    const cancelledIdx = SRC.lastIndexOf("cancelled = true;", cleanupIdx);
    expect(cancelledIdx).toBeGreaterThan(-1);
    expect(cleanupIdx).toBeGreaterThan(cancelledIdx);
  });

  it("reuses the shared isImageRowExt so tile decision matches row-height math", () => {
    expect(SRC).toContain("isImageRowExt(row.ext)");
    expect(SRC).not.toContain("function isImageExt(");
  });

  it("clamps the text-row description to two lines so row height stays uniform", () => {
    expect(SRC).toContain("line-clamp-2");
  });
});

describe("FilesPanel client-side search (static source check)", () => {
  it("has a search input wired to a query state setter", () => {
    expect(SRC).toContain('type="search"');
    expect(SRC).toContain('data-testid="files-panel-search"');
    expect(SRC).toContain("setQuery(e.target.value)");
  });

  it("filters client-side over name / path / description, case-insensitive", () => {
    expect(SRC).toContain("r.name.toLowerCase().includes(q)");
    expect(SRC).toContain("r.path.toLowerCase().includes(q)");
    expect(SRC).toContain('(r.description ?? "").toLowerCase().includes(q)');
  });

  it("also matches the visible fallback link text (null-description rows show linkText)", () => {
    // A null-description row displays `linkText ?? name`, so a query matching
    // that on-screen fallback text must match the predicate (search used to
    // miss the fallback text actually shown to users).
    expect(SRC).toContain("r.linkText.toLowerCase().includes(q)");
  });

  it("resets scroll to the top when the query changes (no stale-scroll empty slice)", () => {
    expect(SRC).toContain("el.scrollTop = 0");
    expect(SRC).toContain("}, [query]);");
  });

  it("search feeds the filtered rows into ordering (no server round-trip)", () => {
    expect(SRC).toContain("orderRows(filtered, pins)");
    // Search must not add a fetch - the only fetches are the manifest GET, the
    // describe POST, and the pin toggle POST (three total), none query-driven.
    const fetchCount = (SRC.match(/fetch\(/g) ?? []).length;
    expect(fetchCount).toBe(3);
  });
});
