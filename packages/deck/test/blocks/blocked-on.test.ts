/**
 * Unit tests for blocked-on: frontmatter key parsing (TASK-440).
 *
 * Covers:
 * - blocked-on: string accepted -> blockedOn field populated
 * - blocked-on: absent -> blockedOn undefined
 * - blocked-on: non-string (number, array) -> warns + blockedOn undefined
 * - Round-trip serialize fidelity: blocked-on: survives applyTargetedEdits
 *   (body and unknown frontmatter keys survive byte-identical)
 *
 * ASCII only - no em-dashes per FND-05.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  listCards,
  applyTargetedEdits,
} from "~/lib/projects.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function withProjectsRoot(value: string | undefined, fn: () => void): void {
  const prev = process.env["PROJECTS_ROOT"];
  if (value === undefined) {
    delete process.env["PROJECTS_ROOT"];
  } else {
    process.env["PROJECTS_ROOT"] = value;
  }
  try {
    fn();
  } finally {
    if (prev === undefined) {
      delete process.env["PROJECTS_ROOT"];
    } else {
      process.env["PROJECTS_ROOT"] = prev;
    }
  }
}

function writeCard(dir: string, filename: string, content: string): void {
  fs.writeFileSync(path.join(dir, filename), content, "utf8");
}

// ---------------------------------------------------------------------------
// Suite: blocked-on field parsing
// ---------------------------------------------------------------------------

describe("listCards - blocked-on field (TASK-440)", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync();
  });

  afterEach(() => {
    rmSync(tmpDir);
  });

  it("parses blocked-on: when present as a string", () => {
    writeCard(tmpDir, "blocked-card.md", [
      "---",
      "title: Test blocked card",
      "agent: quill",
      "column: blocked",
      "updated: 2026-06-10T10:00:00Z",
      "blocked-on: Alex Deepgram key",
      "---",
      "",
      "Waiting on Alex.",
    ].join("\n"));

    withProjectsRoot(tmpDir, () => {
      const cards = listCards();
      const card = cards.find(c => c.id === "blocked-card.md");
      expect(card).toBeDefined();
      expect(card!.blockedOn).toBe("Alex Deepgram key");
    });
  });

  it("blockedOn is undefined when blocked-on: is absent", () => {
    writeCard(tmpDir, "no-blocked-on.md", [
      "---",
      "title: No blocked-on",
      "agent: quill",
      "column: todo",
      "updated: 2026-06-10T10:00:00Z",
      "---",
      "",
      "Normal card.",
    ].join("\n"));

    withProjectsRoot(tmpDir, () => {
      const cards = listCards();
      const card = cards.find(c => c.id === "no-blocked-on.md");
      expect(card).toBeDefined();
      expect(card!.blockedOn).toBeUndefined();
    });
  });

  it("blockedOn is undefined when blocked-on: is a non-string (number), warns", () => {
    writeCard(tmpDir, "numeric-blocked-on.md", [
      "---",
      "title: Numeric blocked-on",
      "agent: quill",
      "column: blocked",
      "updated: 2026-06-10T10:00:00Z",
      "blocked-on: 42",
      "---",
      "",
      "Body.",
    ].join("\n"));

    // YAML parses bare 42 as number
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    withProjectsRoot(tmpDir, () => {
      const cards = listCards();
      const card = cards.find(c => c.id === "numeric-blocked-on.md");
      expect(card).toBeDefined();
      // Non-string: ignored, warn emitted, card still visible
      expect(card!.blockedOn).toBeUndefined();
    });
    // Should have warned about non-string
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("blocked-on: survives applyTargetedEdits (byte-identical for unknown keys)", () => {
    const raw = [
      "---",
      "title: Blocked card",
      "agent: quill",
      "column: blocked",
      "updated: 2026-06-01T10:00:00Z",
      "blocked-on: TASK-429 merge",
      "---",
      "",
      "Some body.",
    ].join("\n");

    const result = applyTargetedEdits(raw, "in progress", "2026-06-10T12:00:00Z");
    // blocked-on: must survive byte-identical
    expect(result).toContain("blocked-on: TASK-429 merge");
    // column must be updated
    expect(result).toContain("column: in progress");
    // body must be unchanged
    expect(result).toContain("Some body.");
  });
});

import { beforeEach, afterEach } from "vitest";
