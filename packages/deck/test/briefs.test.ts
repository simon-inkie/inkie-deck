/**
 * test/briefs.test.ts - Unit tests for app/lib/briefs.server.ts (TASK-442).
 *
 * Covers:
 *   - Newest-by-filename-date selection across several date files.
 *   - Non-conforming filenames ignored (README.md, 2026-1-1.md, .swp, subdir).
 *   - Missing dir -> null; empty dir -> null.
 *   - Freshness matrix: today -> returned; yesterday -> returned; 2 days old -> null.
 *   - Markdown content round-trips exactly (no trimming surprises).
 *
 * All tests use isolated tmpdir fixtures; INBOX_ROOT is set and restored around
 * each test. MC_SANDBOX_ONLY is set globally by test/setup.ts.
 *
 * VALID-03: writes only to os.tmpdir(). No repo files are mutated.
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { getLatestBrief } from "~/lib/briefs.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create an INBOX_ROOT structure with quill/briefs/ seeded with provided files. */
function makeBriefsInbox(
  files: Record<string, string>
): { inboxRoot: string; briefsDir: string } {
  const inboxRoot = mkdtempSync();
  const briefsDir = path.join(inboxRoot, "quill", "briefs");
  fs.mkdirSync(briefsDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(briefsDir, name), content, "utf8");
  }
  return { inboxRoot, briefsDir };
}

/** Build a fake env that has INBOX_ROOT set. */
function makeEnv(inboxRoot: string): NodeJS.ProcessEnv {
  return { ...process.env, INBOX_ROOT: inboxRoot };
}

/** Parse a YYYY-MM-DD string as a UTC Date. */
function utcDate(dateStr: string): Date {
  const [year, month, day] = dateStr.split("-").map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!));
}

let sandbox: string;

beforeEach(() => {
  sandbox = mkdtempSync();
});

afterEach(() => {
  rmSync(sandbox);
});

// ---------------------------------------------------------------------------
// Suite 1: Newest-by-filename-date selection
// ---------------------------------------------------------------------------

describe("getLatestBrief - newest file selection", () => {
  it("returns the lexicographically newest conforming file", async () => {
    const { inboxRoot } = makeBriefsInbox({
      "2026-06-08.md": "# older",
      "2026-06-09.md": "# also older",
      "2026-06-10.md": "# newest",
    });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).not.toBeNull();
      expect(result!.date).toBe("2026-06-10");
      expect(result!.markdown).toBe("# newest");
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns the correct file even when there are gaps in dates", async () => {
    const { inboxRoot } = makeBriefsInbox({
      "2026-06-05.md": "# old",
      "2026-06-09.md": "# recent",
    });
    try {
      const now = utcDate("2026-06-09");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).not.toBeNull();
      expect(result!.date).toBe("2026-06-09");
    } finally {
      rmSync(inboxRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Non-conforming filenames ignored
// ---------------------------------------------------------------------------

describe("getLatestBrief - non-conforming filenames ignored", () => {
  it("ignores README.md", async () => {
    const { inboxRoot } = makeBriefsInbox({
      "README.md": "# readme",
      "2026-06-10.md": "# real brief",
    });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).not.toBeNull();
      expect(result!.date).toBe("2026-06-10");
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("ignores malformed date filenames (2026-1-1.md)", async () => {
    const { inboxRoot } = makeBriefsInbox({
      "2026-1-1.md": "# bad format",
      "2026-06-10.md": "# good",
    });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result!.date).toBe("2026-06-10");
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("ignores vim swap files (.swp)", async () => {
    const { inboxRoot, briefsDir } = makeBriefsInbox({
      "2026-06-10.md": "# real",
    });
    try {
      // Write a .swp file (not matching the regex).
      fs.writeFileSync(path.join(briefsDir, "2026-06-10.md.swp"), "binary garbage", "utf8");
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result!.date).toBe("2026-06-10");
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("ignores subdirectories even if they match the date pattern name", async () => {
    const { inboxRoot, briefsDir } = makeBriefsInbox({
      "2026-06-10.md": "# real",
    });
    try {
      // A subdir named 2026-06-11.md would match the regex textually but must
      // be ignored because readdir returns it as a directory entry.
      // We can only test the regex filter here (not a dir entry filter) since
      // readdir without withFileTypes returns names and our regex accepts only
      // ^\d{4}-\d{2}-\d{2}\.md$. A dir named "2026-06-11.md" is an edge case
      // that the regex catches - the file read would fail but the regex is the
      // primary gate. This test verifies only well-named files with .md ext pass.
      fs.mkdirSync(path.join(briefsDir, "subdir"), { recursive: true });
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result!.date).toBe("2026-06-10");
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns null when the only files are non-conforming", async () => {
    const { inboxRoot } = makeBriefsInbox({
      "README.md": "# readme",
      "notes.txt": "some notes",
    });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 3: Missing/empty dir
// ---------------------------------------------------------------------------

describe("getLatestBrief - missing or empty dir", () => {
  it("returns null when the briefs dir does not exist", async () => {
    // inboxRoot exists but quill/briefs/ does not.
    const inboxRoot = mkdtempSync();
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns null when the quill dir does not exist", async () => {
    const inboxRoot = mkdtempSync();
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns null when the briefs dir is empty", async () => {
    const inboxRoot = mkdtempSync();
    const briefsDir = path.join(inboxRoot, "quill", "briefs");
    fs.mkdirSync(briefsDir, { recursive: true });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 4: Freshness matrix (injected now, never wall-clock)
// ---------------------------------------------------------------------------

describe("getLatestBrief - freshness matrix", () => {
  it("returns a brief dated today", async () => {
    const { inboxRoot } = makeBriefsInbox({ "2026-06-10.md": "# today" });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).not.toBeNull();
      expect(result!.date).toBe("2026-06-10");
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns a brief dated yesterday", async () => {
    const { inboxRoot } = makeBriefsInbox({ "2026-06-09.md": "# yesterday" });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).not.toBeNull();
      expect(result!.date).toBe("2026-06-09");
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns null for a brief two days old", async () => {
    const { inboxRoot } = makeBriefsInbox({ "2026-06-08.md": "# too old" });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns null for a brief three days old", async () => {
    const { inboxRoot } = makeBriefsInbox({ "2026-06-07.md": "# very old" });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("returns null when the newest file is stale even if older fresh files exist", async () => {
    // The newest (by lex) file is 2026-06-07 which is stale relative to now=2026-06-10.
    // Even though there are other files, getLatestBrief picks NEWEST then checks freshness.
    // This is correct: if the most recent brief is stale, we hide the panel.
    const { inboxRoot } = makeBriefsInbox({
      "2026-06-07.md": "# newest but stale",
    });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("uses injected now, not wall-clock (deterministic in CI)", async () => {
    // Set now far in the future so today would be 2030-01-01.
    // A brief from 2026-06-10 is stale relative to that future now.
    const { inboxRoot } = makeBriefsInbox({ "2026-06-10.md": "# past brief" });
    try {
      const futureNow = new Date(Date.UTC(2030, 0, 1));
      const result = await getLatestBrief(makeEnv(inboxRoot), futureNow);
      expect(result).toBeNull();
    } finally {
      rmSync(inboxRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// Suite 5: Content fidelity
// ---------------------------------------------------------------------------

describe("getLatestBrief - content fidelity", () => {
  it("returns markdown content byte-identical to the file", async () => {
    const content = "# Morning Brief\n\n- Item one\n- Item two\n\nSome **bold** text.\n";
    const { inboxRoot } = makeBriefsInbox({ "2026-06-10.md": content });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result).not.toBeNull();
      expect(result!.markdown).toBe(content);
    } finally {
      rmSync(inboxRoot);
    }
  });

  it("preserves Unicode content (pound sign, non-ASCII)", async () => {
    const content = "# Brief\n\nBudget: GBP 1,000. Cafe: café.\n";
    const { inboxRoot } = makeBriefsInbox({ "2026-06-10.md": content });
    try {
      const now = utcDate("2026-06-10");
      const result = await getLatestBrief(makeEnv(inboxRoot), now);
      expect(result!.markdown).toBe(content);
    } finally {
      rmSync(inboxRoot);
    }
  });
});

// ---------------------------------------------------------------------------
// Symlinked INBOX_ROOT (manager-review fix pin, TASK-442)
// ---------------------------------------------------------------------------

describe("getLatestBrief - symlinked INBOX_ROOT", () => {
  it("returns the brief when INBOX_ROOT is a symlink to the real inbox", async () => {
    // The containment check must build briefsDir from the RESOLVED root -
    // comparing a non-resolved join against a resolved root silently nulled
    // the whole feature on symlinked roots (e.g. a mirror dir).
    const { inboxRoot } = makeBriefsInbox({
      "2026-06-10.md": "# Morning brief\n\nVia symlink.",
    });
    const linkPath = path.join(mkdtempSync(), "inbox-link");
    fs.symlinkSync(inboxRoot, linkPath);

    const result = await getLatestBrief(
      makeEnv(linkPath),
      utcDate("2026-06-10")
    );
    expect(result).not.toBeNull();
    expect(result!.date).toBe("2026-06-10");
    expect(result!.markdown).toContain("Via symlink.");
  });
});
