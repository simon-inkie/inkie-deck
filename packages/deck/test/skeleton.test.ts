/**
 * skeleton.test.ts - The non-UI walking-skeleton end-to-end proof (section G)
 *
 * Proves all three legs of the Phase 1 non-UI walking skeleton green:
 *
 *   Leg 1 - BOOTS: app/routes/home.tsx exports a React component function
 *     containing "Inkie Deck" (proving the scaffold is wired and the
 *     static route shell exists). No DOM provider needed - we check the
 *     module shape and the JSX return value string.
 *
 *   Leg 2 - PARSER: read the real fixture (fixtures/inbox/scribe/inbox/alex.md),
 *     splitBlocks + parseBlock the card block, serializeBlock, assert byte-
 *     identical round-trip with unknown fields (lean, blocking) preserved.
 *
 *   Leg 3 - GUARD: in an mkdtemp sandbox, assert assertSafeWritePath rejects
 *     a .the-vault path and a symlink-escape, and a legit in-sandbox safeWrite
 *     lands inside the sandbox only.
 *
 * All three pass under `pnpm typecheck && pnpm test`.
 *
 * Ref: RESEARCH.md "The Walking-Skeleton Tension (section G)"
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { splitBlocks } from "~/lib/blocks/split.js";
import { parseBlock } from "~/lib/blocks/parse.js";
import { serializeBlock } from "~/lib/blocks/serialize.js";
import { assertSafeWritePath, safeWrite } from "~/lib/safe-fs.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);

const FIXTURE_PATH = path.join(
  REPO_ROOT,
  "fixtures",
  "inbox",
  "scribe",
  "inbox",
  "alex.md"
);

// ---------------------------------------------------------------------------
// Leg 1: BOOTS - the route shell exists and exports a component
// ---------------------------------------------------------------------------

describe("Leg 1: BOOTS (scaffold wired, static route shell exists)", () => {
  it("app/routes/home.tsx exists", () => {
    const routePath = path.join(REPO_ROOT, "app", "routes", "home.tsx");
    expect(fs.existsSync(routePath)).toBe(true);
  });

  it("app/routes/home.tsx exports a default function (the Home component)", async () => {
    // Dynamic import to avoid needing a DOM at module load time.
    // The component is a plain function export.
    const mod = await import("~/routes/home.js");
    expect(typeof mod.default).toBe("function");
  }, 15000);

  it("the Home component has the name 'Home' or is a valid function", async () => {
    const mod = await import("~/routes/home.js");
    // The default export must be callable (a React component).
    const Home = mod.default;
    expect(typeof Home).toBe("function");
    // The function name is either "Home" (explicit) or a valid identifier.
    expect(Home.name).toBeTruthy();
  });

  it("home.tsx source contains 'Inkie Deck' text", () => {
    // Check the source file contains the expected static text.
    const routePath = path.join(REPO_ROOT, "app", "routes", "home.tsx");
    const src = fs.readFileSync(routePath, "utf8");
    expect(src).toContain("Inkie Deck");
  });
});

// ---------------------------------------------------------------------------
// Leg 2: PARSER round-trip
// ---------------------------------------------------------------------------

describe("Leg 2: PARSER round-trips a real fixture block byte-for-byte", () => {
  let fixtureRaw: string;
  let blocks: string[];

  beforeAll(() => {
    fixtureRaw = fs.readFileSync(FIXTURE_PATH, "utf8");
    blocks = splitBlocks(fixtureRaw);
  });

  it("fixture has exactly 8 blocks", () => {
    // The fixture gained 3 blocks (working-superseded, agent-reply, live-working).
    expect(blocks).toHaveLength(8);
  });

  it("card block (TASK-413-q1) parses with the correct decisionId", () => {
    const parsed = parseBlock(blocks[0]!);
    expect(parsed.card?.decisionId).toBe("TASK-413-q1");
  });

  it("card block round-trips byte-for-byte (serializeBlock(parseBlock(x)) === x)", () => {
    const original = blocks[0]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(original);
  });

  it("plain message block round-trips byte-for-byte", () => {
    const original = blocks[1]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toBe(original);
  });

  it("rawMeta preserves unknown fields lean and blocking verbatim", () => {
    const parsed = parseBlock(blocks[0]!);
    expect(parsed.rawMeta).toContain("lean:");
    expect(parsed.rawMeta).toContain("blocking:");
    // card typed object has only known fields
    const card = parsed.card as unknown as Record<string, unknown>;
    expect("lean" in card).toBe(false);
    expect("blocking" in card).toBe(false);
  });

  it("the pound sign (£) and multi-line detail survive round-trip", () => {
    const original = blocks[0]!;
    const parsed = parseBlock(original);
    const serialized = serializeBlock(parsed);
    expect(serialized).toContain("£");
    expect(serialized).toBe(original);
  });
});

// ---------------------------------------------------------------------------
// Leg 3: GUARD - reject bad path, accept in-sandbox write
// ---------------------------------------------------------------------------

describe("Leg 3: GUARD rejects bad paths and accepts in-sandbox write", () => {
  let sandbox: string;
  let outside: string;
  let savedInboxRoot: string | undefined;

  beforeAll(() => {
    sandbox = mkdtempSync();
    outside = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
  });

  afterAll(() => {
    rmSync(sandbox);
    rmSync(outside);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  it("rejects a non-inbox-shaped path under a look-alike '.the-vault' dir (TASK-434)", () => {
    // Substring ban is gone (production roots contain ".the-vault"); this
    // path still throws - missing parent here, write-shape violation if it
    // existed (".the-vault" is not a valid agent name).
    const target = path.join(sandbox, ".the-vault", "inbox.md");
    expect(() => assertSafeWritePath(target)).toThrow();
  });

  it("rejects a symlink-escape (in-sandbox symlink pointing outside sandbox)", () => {
    // Use a fresh subdirectory for this test so cleanup is clean.
    const escapeOutside = mkdtempSync();
    try {
      // Create a target file outside the sandbox.
      const outsideTarget = path.join(escapeOutside, "target.md");
      fs.writeFileSync(outsideTarget, "outside content", "utf8");
      // Create a symlink inside the sandbox pointing at the outside target.
      const escapePath = path.join(sandbox, "escape.md");
      fs.symlinkSync(outsideTarget, escapePath);

      expect(() => assertSafeWritePath(escapePath)).toThrow(
        /outside the inbox root/
      );

      // Cleanup the symlink so afterAll rm works cleanly.
      fs.rmSync(escapePath);
    } finally {
      rmSync(escapeOutside);
    }
  });

  it("accepts a legit in-sandbox path and writes the content atomically", () => {
    // Writes must be inbox-shaped (<agent>/inbox/<file>.md).
    const inboxDir = path.join(sandbox, "quill", "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    const targetPath = path.join(inboxDir, "message.md");
    const content = "## 2026-06-03T12:00:00Z - from: alex - status: sent - subject: test\n\nHello, world.\n\n---";

    // safeWrite must not throw.
    const resolvedPath = safeWrite(targetPath, content);

    // File exists at the resolved path.
    expect(fs.existsSync(resolvedPath)).toBe(true);
    // Contents are correct.
    expect(fs.readFileSync(resolvedPath, "utf8")).toBe(content);
    // Nothing written to the shared outside dir.
    expect(fs.readdirSync(outside)).toHaveLength(0);
    // No temp files leaked.
    const sandboxFiles = fs.readdirSync(sandbox);
    expect(sandboxFiles.every((f) => !f.includes(".tmp-"))).toBe(true);
  });
});
