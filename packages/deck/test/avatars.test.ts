/**
 * test/avatars.test.ts - Unit tests for app/lib/avatars.server.ts.
 *
 * Covers:
 *   - avatarVersion/avatarUrl present vs absent file.
 *   - Traversal-shaped and convention-violating agent names rejected.
 *   - Symlinked INBOX_ROOT resolves (the same briefs fix is pinned here too).
 *   - avatar.png symlinked OUTSIDE the root -> undefined + console.warn
 *     (present-but-rejected must leave an operator trail).
 *   - readAvatar returns the bytes only for the convention path.
 *
 * All tests use isolated tmpdir fixtures; INBOX_ROOT is set and restored
 * around each test. Writes only to os.tmpdir().
 * ASCII only - no em-dashes.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { avatarVersion, avatarUrl, readAvatar } from "~/lib/avatars.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// Minimal valid PNG header bytes - content is irrelevant to the reader.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

let inboxRoot: string;
let outside: string;
let savedInboxRoot: string | undefined;

beforeEach(() => {
  inboxRoot = mkdtempSync();
  outside = mkdtempSync();
  savedInboxRoot = process.env["INBOX_ROOT"];
  process.env["INBOX_ROOT"] = inboxRoot;
});

afterEach(() => {
  if (savedInboxRoot === undefined) delete process.env["INBOX_ROOT"];
  else process.env["INBOX_ROOT"] = savedInboxRoot;
  rmSync(inboxRoot);
  rmSync(outside);
});

function seedAvatar(agent: string, bytes: Buffer = PNG_BYTES): string {
  const dir = path.join(inboxRoot, agent);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "avatar.png");
  fs.writeFileSync(file, bytes);
  return file;
}

describe("avatarVersion / avatarUrl", () => {
  it("returns the mtimeMs version and a ?v= URL when the file exists", () => {
    const file = seedAvatar("quill");
    const expected = Math.floor(fs.statSync(file).mtimeMs);

    expect(avatarVersion("quill")).toBe(expected);
    expect(avatarUrl("quill")).toBe(`/avatars/quill?v=${expected}`);
  });

  it("returns undefined when the agent has no avatar (normal fallback case)", () => {
    fs.mkdirSync(path.join(inboxRoot, "quill"), { recursive: true });
    expect(avatarVersion("quill")).toBeUndefined();
    expect(avatarUrl("quill")).toBeUndefined();
  });

  it("returns undefined when the agent directory does not exist", () => {
    expect(avatarVersion("ghost")).toBeUndefined();
  });

  it("rejects traversal-shaped and convention-violating names before any fs call", () => {
    seedAvatar("quill");
    for (const bad of ["../quill", "quill/..", ".", "..", "IO", "quill agent", "", "-quill"]) {
      expect(avatarVersion(bad)).toBeUndefined();
      expect(readAvatar(bad)).toBeUndefined();
    }
  });
});

describe("containment", () => {
  it("resolves a symlinked INBOX_ROOT (briefs catch #16 shape)", () => {
    seedAvatar("quill");
    const link = path.join(outside, "root-link");
    fs.symlinkSync(inboxRoot, link);
    process.env["INBOX_ROOT"] = link;

    expect(avatarVersion("quill")).toBeDefined();
    expect(readAvatar("quill")).toBeDefined();
  });

  it("rejects an avatar.png symlinked outside the root AND warns", () => {
    const secret = path.join(outside, "secret.png");
    fs.writeFileSync(secret, PNG_BYTES);
    const dir = path.join(inboxRoot, "quill");
    fs.mkdirSync(dir, { recursive: true });
    fs.symlinkSync(secret, path.join(dir, "avatar.png"));

    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(avatarVersion("quill")).toBeUndefined();
      expect(readAvatar("quill")).toBeUndefined();
      expect(warn).toHaveBeenCalled();
      const message = String(warn.mock.calls[0]?.[0] ?? "");
      expect(message).toContain("rejected");
      expect(message).toContain("quill");
    } finally {
      warn.mockRestore();
    }
  });

  it("does NOT warn for a plain missing file (silence is the normal case)", () => {
    fs.mkdirSync(path.join(inboxRoot, "quill"), { recursive: true });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      expect(avatarVersion("quill")).toBeUndefined();
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

describe("readAvatar", () => {
  it("returns the file bytes for the convention path", () => {
    seedAvatar("summit");
    const bytes = readAvatar("summit");
    expect(bytes).toBeDefined();
    expect(Buffer.compare(bytes!, PNG_BYTES)).toBe(0);
  });

  it("returns undefined when INBOX_ROOT is unset", () => {
    delete process.env["INBOX_ROOT"];
    expect(readAvatar("quill")).toBeUndefined();
    expect(avatarVersion("quill")).toBeUndefined();
  });
});
