/**
 * Tests for app/lib/file-manifest.ts - PURE file-reference extraction.
 *
 * Covers:
 *   - isFileReferenceHref / fileExt / fileBasename detection.
 *   - extractFileReferences: md links, path shapes, /attachments/, any
 *     extension; http/route-link rejection; dedupe-by-path (first vs last seen);
 *     surrounding-window radius.
 *   - descriptionCacheKey determinism + sensitivity to window change.
 *
 * ASCII only - no em-dashes.
 */

import { describe, it, expect } from "vitest";
import {
  isFileReferenceHref,
  fileExt,
  fileBasename,
  extractFileReferences,
  descriptionCacheKey,
  type FileReference,
} from "~/lib/file-manifest";
import type { MessageBlock } from "~/lib/blocks/model";

function block(
  from: string,
  timestamp: string,
  body: string
): MessageBlock {
  return {
    header: { from, timestamp, status: "read", subject: "s" },
    body,
    rawMeta: "",
  };
}

describe("isFileReferenceHref", () => {
  it("accepts absolute path with extension", () => {
    expect(isFileReferenceHref("/home/you/x.md")).toBe(true);
    expect(isFileReferenceHref("/home/you/pic.png")).toBe(true);
    expect(isFileReferenceHref("/a/b/data.csv")).toBe(true);
  });
  it("accepts tilde path with extension", () => {
    expect(isFileReferenceHref("~/brain/notes.md")).toBe(true);
  });
  it("accepts /attachments/ with extension", () => {
    expect(isFileReferenceHref("/attachments/quill/mc/file.txt")).toBe(true);
  });
  it("accepts any extension (file manifest, not md-only)", () => {
    expect(isFileReferenceHref("/a/b/diff.patch")).toBe(true);
    expect(isFileReferenceHref("/a/b/build.log")).toBe(true);
    expect(isFileReferenceHref("/a/b/archive.tar.gz")).toBe(true);
  });
  it("rejects http(s) external links", () => {
    expect(isFileReferenceHref("https://example.com/x.md")).toBe(false);
    expect(isFileReferenceHref("http://example.com/y.png")).toBe(false);
  });
  it("rejects in-app route links without extension", () => {
    expect(isFileReferenceHref("/threads/quill")).toBe(false);
    expect(isFileReferenceHref("/projects")).toBe(false);
  });
  it("rejects protocol-relative + mailto + empty", () => {
    expect(isFileReferenceHref("//host/x.md")).toBe(false);
    expect(isFileReferenceHref("mailto:a@b.com")).toBe(false);
    expect(isFileReferenceHref("")).toBe(false);
  });
  it("rejects a trailing-dot path (no extension chars)", () => {
    expect(isFileReferenceHref("/a/b/weird.")).toBe(false);
  });
});

describe("fileExt + fileBasename", () => {
  it("lowercases the extension incl dot", () => {
    expect(fileExt("/a/B.MD")).toBe(".md");
    expect(fileExt("/a/pic.PNG")).toBe(".png");
    expect(fileExt("/a/noext")).toBe("");
  });
  it("returns basename", () => {
    expect(fileBasename("/a/b/c.md")).toBe("c.md");
    expect(fileBasename("/attachments/quill/x.png")).toBe("x.png");
  });
});

describe("extractFileReferences", () => {
  it("extracts a single md-link file reference", () => {
    const refs = extractFileReferences([
      block("quill", "2026-06-18T10:00:00Z", "here is [the spec](/home/you/spec.md)"),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.path).toBe("/home/you/spec.md");
    expect(refs[0]!.name).toBe("spec.md");
    expect(refs[0]!.ext).toBe(".md");
    expect(refs[0]!.linkText).toBe("the spec");
  });

  it("ignores http links and route links, keeps file paths", () => {
    const refs = extractFileReferences([
      block(
        "quill",
        "2026-06-18T10:00:00Z",
        "see [site](https://x.com/y) and [thread](/threads/quill) and [doc](/a/b.md)"
      ),
    ]);
    expect(refs.map((r) => r.path)).toEqual(["/a/b.md"]);
  });

  it("collects multiple distinct files newest-first", () => {
    const refs = extractFileReferences([
      block("quill", "2026-06-18T10:00:00Z", "[a](/x/a.md)"),
      block("alex", "2026-06-18T11:00:00Z", "[b](/x/b.png)"),
      block("quill", "2026-06-18T12:00:00Z", "[c](/x/c.txt)"),
    ]);
    expect(refs.map((r) => r.path)).toEqual(["/x/c.txt", "/x/b.png", "/x/a.md"]);
  });

  it("dedupes by path: first-seen ts + index preserved, last-seen advances", () => {
    const refs = extractFileReferences([
      block("quill", "2026-06-18T10:00:00Z", "[a](/x/a.md)"),
      block("alex", "2026-06-18T11:00:00Z", "no file here"),
      block("quill", "2026-06-18T12:00:00Z", "again [a](/x/a.md)"),
    ]);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.firstSeenTimestamp).toBe("2026-06-18T10:00:00Z");
    expect(refs[0]!.firstSeenMessageIndex).toBe(0);
    expect(refs[0]!.lastSeenTimestamp).toBe("2026-06-18T12:00:00Z");
  });

  it("honours baseIndex for absolute firstSeenMessageIndex", () => {
    const refs = extractFileReferences(
      [block("quill", "2026-06-18T10:00:00Z", "[a](/x/a.md)")],
      40
    );
    expect(refs[0]!.firstSeenMessageIndex).toBe(40);
  });

  it("builds a surrounding window of radius N around first mention", () => {
    const blocks = [
      block("quill", "2026-06-18T09:00:00Z", "msg0"),
      block("alex", "2026-06-18T09:01:00Z", "msg1"),
      block("quill", "2026-06-18T09:02:00Z", "the file [a](/x/a.md) msg2"),
      block("alex", "2026-06-18T09:03:00Z", "msg3"),
      block("quill", "2026-06-18T09:04:00Z", "msg4"),
      block("quill", "2026-06-18T09:05:00Z", "msg5"),
    ];
    const refs = extractFileReferences(blocks, 0, 2);
    // center index 2, radius 2 => indices 0..4 (5 messages).
    expect(refs[0]!.surrounding.map((m) => m.body)).toEqual([
      "msg0",
      "msg1",
      "the file [a](/x/a.md) msg2",
      "msg3",
      "msg4",
    ]);
  });

  it("collects /attachments/ references", () => {
    const refs = extractFileReferences([
      block("quill", "2026-06-18T10:00:00Z", "[upload](/attachments/quill/mc/deck.pdf)"),
    ]);
    expect(refs[0]!.path).toBe("/attachments/quill/mc/deck.pdf");
    expect(refs[0]!.ext).toBe(".pdf");
  });

  it("returns empty for a thread with no file links", () => {
    const refs = extractFileReferences([
      block("quill", "2026-06-18T10:00:00Z", "just chatting, see [site](https://x.com)"),
    ]);
    expect(refs).toEqual([]);
  });
});

describe("descriptionCacheKey", () => {
  const ref: FileReference = {
    path: "/x/a.md",
    linkText: "a",
    name: "a.md",
    ext: ".md",
    firstSeenTimestamp: "2026-06-18T10:00:00Z",
    lastSeenTimestamp: "2026-06-18T10:00:00Z",
    firstSeenMessageIndex: 0,
    surrounding: [
      { from: "quill", timestamp: "2026-06-18T10:00:00Z", body: "hello" },
    ],
  };

  it("is deterministic for identical input", () => {
    expect(descriptionCacheKey(ref)).toBe(descriptionCacheKey({ ...ref }));
  });

  it("starts with the path", () => {
    expect(descriptionCacheKey(ref).startsWith("/x/a.md@")).toBe(true);
  });

  it("changes when the surrounding window changes", () => {
    const a = descriptionCacheKey(ref);
    const b = descriptionCacheKey({
      ...ref,
      surrounding: [
        { from: "quill", timestamp: "2026-06-18T10:00:00Z", body: "different" },
      ],
    });
    expect(a).not.toBe(b);
  });

  it("changes when the path changes", () => {
    const a = descriptionCacheKey(ref);
    const b = descriptionCacheKey({ ...ref, path: "/x/b.md" });
    expect(a).not.toBe(b);
  });
});
