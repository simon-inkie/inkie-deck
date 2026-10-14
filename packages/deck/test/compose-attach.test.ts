/**
 * test/compose-attach.test.ts - Unit tests for app/lib/compose-attach.ts.
 *
 * Tests:
 *   buildOutgoingBody:
 *     - text + attachments: separator correctness
 *     - attachments-only (empty text)
 *     - text-only (no attachments)
 *     - multiple attachments order preserved
 *     - empty text + empty markdowns -> empty string
 *     - leading/trailing whitespace in inputs is trimmed
 *
 *   extractPasteFiles:
 *     - files-present path wins
 *     - files-empty + file-kind items extracted (bitmap paste path)
 *     - string-kind items are ignored
 *     - getAsFile() returning null is filtered
 *     - both files and items empty -> []
 *     - mixed kinds (only "file" kind extracted)
 *
 * Pure module: no DOM globals needed. ClipboardLike accepts plain objects.
 * ASCII only - no em-dashes.
 */

import { describe, it, expect } from "vitest";
import { buildOutgoingBody, extractPasteFiles } from "~/lib/compose-attach";
import type { ClipboardLike, ClipboardItemLike } from "~/lib/compose-attach";

// ---------------------------------------------------------------------------
// Helpers for building plain-object ClipboardLike test doubles
// ---------------------------------------------------------------------------

function makeClipboard(
  files: File[],
  items: ClipboardItemLike[]
): ClipboardLike {
  // Build a length-indexed collection for files.
  const filesProxy: ClipboardLike["files"] = {
    length: files.length,
    ...Object.fromEntries(files.map((f, i) => [i, f])),
  };
  const itemsProxy: ClipboardLike["items"] = {
    length: items.length,
    ...Object.fromEntries(items.map((item, i) => [i, item])),
  };
  return { files: filesProxy, items: itemsProxy };
}

function fileItem(file: File): ClipboardItemLike {
  return { kind: "file", getAsFile: () => file };
}

function nullFileItem(): ClipboardItemLike {
  return { kind: "file", getAsFile: () => null };
}

function stringItem(): ClipboardItemLike {
  return { kind: "string", getAsFile: () => null };
}

function makeFile(name: string): File {
  return new File(["data"], name, { type: "image/png" });
}

// ---------------------------------------------------------------------------
// buildOutgoingBody
// ---------------------------------------------------------------------------

describe("buildOutgoingBody", () => {
  it("joins text and a single attachment with a blank line", () => {
    const result = buildOutgoingBody("Hello there", ["![img.png](/attachments/a/mc/img.png)"]);
    expect(result).toBe("Hello there\n\n![img.png](/attachments/a/mc/img.png)");
  });

  it("joins text and multiple attachments in order, blank-line separated", () => {
    const result = buildOutgoingBody("My text", [
      "![a.png](/attachments/a/mc/a.png)",
      "[b.md](/attachments/a/mc/b.md)",
    ]);
    expect(result).toBe(
      "My text\n\n![a.png](/attachments/a/mc/a.png)\n\n[b.md](/attachments/a/mc/b.md)"
    );
  });

  it("returns only the attachment markdown when text is empty (attachments-only)", () => {
    const result = buildOutgoingBody("", ["![img.png](/attachments/a/mc/img.png)"]);
    expect(result).toBe("![img.png](/attachments/a/mc/img.png)");
  });

  it("returns only the text when markdowns array is empty (text-only)", () => {
    const result = buildOutgoingBody("Just text", []);
    expect(result).toBe("Just text");
  });

  it("returns empty string when both text and markdowns are empty", () => {
    const result = buildOutgoingBody("", []);
    expect(result).toBe("");
  });

  it("trims leading/trailing whitespace from text and markdown inputs", () => {
    const result = buildOutgoingBody("  hello  ", ["  ![img.png](/attachments/a/mc/img.png)  "]);
    expect(result).toBe("hello\n\n![img.png](/attachments/a/mc/img.png)");
  });

  it("skips empty markdown strings in the array", () => {
    const result = buildOutgoingBody("text", ["", "![img.png](/attachments/a/mc/img.png)", "  "]);
    expect(result).toBe("text\n\n![img.png](/attachments/a/mc/img.png)");
  });

  it("preserves order of multiple attachments", () => {
    const markdowns = ["![first.png](/a/first.png)", "![second.png](/a/second.png)", "![third.png](/a/third.png)"];
    const result = buildOutgoingBody("", markdowns);
    const parts = result.split("\n\n");
    expect(parts).toEqual(markdowns);
  });
});

// ---------------------------------------------------------------------------
// extractPasteFiles
// ---------------------------------------------------------------------------

describe("extractPasteFiles", () => {
  it("returns files from clipboardData.files when non-empty (path 1 wins)", () => {
    const f1 = makeFile("photo.png");
    const f2 = makeFile("second.png");
    const clip = makeClipboard([f1, f2], []);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([f1, f2]);
  });

  it("prefers files over items when both are present", () => {
    const fileFromFiles = makeFile("from-files.png");
    const fileFromItems = makeFile("from-items.png");
    const clip = makeClipboard([fileFromFiles], [fileItem(fileFromItems)]);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([fileFromFiles]);
    expect(result).not.toContain(fileFromItems);
  });

  it("returns files from items when files is empty (bitmap paste path)", () => {
    const f = makeFile("image.png");
    const clip = makeClipboard([], [fileItem(f)]);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([f]);
  });

  it("filters out items where getAsFile() returns null", () => {
    const f = makeFile("real.png");
    const clip = makeClipboard([], [nullFileItem(), fileItem(f), nullFileItem()]);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([f]);
  });

  it("ignores string-kind items entirely", () => {
    const clip = makeClipboard([], [stringItem(), stringItem()]);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([]);
  });

  it("returns [] when both files and items are empty", () => {
    const clip = makeClipboard([], []);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([]);
  });

  it("extracts only file-kind items from a mixed items list", () => {
    const f = makeFile("bitmap.png");
    const clip = makeClipboard([], [stringItem(), fileItem(f), stringItem()]);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([f]);
  });

  it("handles multiple file-kind items in items", () => {
    const f1 = makeFile("a.png");
    const f2 = makeFile("b.png");
    const clip = makeClipboard([], [fileItem(f1), stringItem(), fileItem(f2)]);
    const result = extractPasteFiles(clip);
    expect(result).toEqual([f1, f2]);
  });
});
