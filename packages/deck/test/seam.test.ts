/**
 * seam.test.ts - seam integrity tests
 *
 * Proves:
 *   1. makeStores returns an object exposing InboxRepository and QueueStore
 *      behind their interfaces (real FileQueueStore in Phase 3).
 *   2. No file under app/routes/** imports "node:fs", "fs", or a literal
 *      inbox path (".the-vault" or "INBOX_ROOT") directly.
 *      This is the static "no-fs-in-routes" assertion.
 *
 * Security: T-01-12 (routes importing fs would leak it to the client bundle
 * and bypass the data-access seam).
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { makeStores } from "~/lib/stores.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const REPO_ROOT = path.resolve(
  path.dirname(new URL(import.meta.url).pathname),
  ".."
);
const ROUTES_DIR = path.join(REPO_ROOT, "app", "routes");
const APP_DIR = path.join(REPO_ROOT, "app");

/** Recursively collect all .ts / .tsx files under a directory. */
function collectSourceFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      results.push(...collectSourceFiles(full));
    } else if (entry.isFile() && /\.(ts|tsx)$/.test(entry.name)) {
      results.push(full);
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Suite 1: makeStores factory + interface conformance
// ---------------------------------------------------------------------------

describe("makeStores factory (FND-02)", () => {
  let sandbox: string;
  let savedInboxRoot: string | undefined;

  beforeAll(() => {
    sandbox = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
  });

  afterAll(() => {
    rmSync(sandbox);
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  it("returns an object with both inbox and queue properties", () => {
    const stores = makeStores(process.env);
    expect(stores).toBeDefined();
    expect(stores).toHaveProperty("inbox");
    expect(stores).toHaveProperty("queue");
  });

  it("inbox is an InboxRepository (has readBlocks, writeReply, answerCard, listAgents)", () => {
    const { inbox } = makeStores(process.env);
    expect(typeof inbox.readBlocks).toBe("function");
    expect(typeof inbox.writeReply).toBe("function");
    expect(typeof inbox.answerCard).toBe("function");
    expect(typeof inbox.listAgents).toBe("function");
  });

  it("queue is a QueueStore (has getHandled, getDeadlines, setDeadline, markHandled)", () => {
    const { queue } = makeStores(process.env);
    expect(typeof queue.getHandled).toBe("function");
    expect(typeof queue.getDeadlines).toBe("function");
    expect(typeof queue.setDeadline).toBe("function");
    expect(typeof queue.markHandled).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Suite 2: Static grep-style assertion - no fs or literal inbox path in routes
// (the seam strip guarantee).
// ---------------------------------------------------------------------------

describe("No fs or literal inbox path in app/routes/** (T-01-12)", () => {
  it("no route file contains 'from \"node:fs\"'", () => {
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    expect(routeFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes('from "node:fs"') || src.includes("from 'node:fs'")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file contains 'from \"fs\"' or 'require(\"fs\")'", () => {
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (
        src.includes('from "fs"') ||
        src.includes("from 'fs'") ||
        src.includes('require("fs")') ||
        src.includes("require('fs')")
      ) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file references '.the-vault' directly", () => {
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes(".the-vault")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file hardcodes a literal 'INBOX_ROOT' path string", () => {
    // Routes must not reference INBOX_ROOT directly - that is stores.server.ts' job.
    // (They may use process.env in a generic sense, but not INBOX_ROOT by name
    //  outside server-only modules.)
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      // Only flag hardcoded paths like process.env["INBOX_ROOT"] or process.env.INBOX_ROOT
      // when the file is in app/routes (not app/lib/*.server.ts which is allowed)
      if (src.includes("INBOX_ROOT")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file hardcodes a literal 'ATTACHMENTS_ROOT' path string", () => {
    // Routes must not reference ATTACHMENTS_ROOT directly - that belongs in the
    // attachments.server.ts seam module only (same rule as INBOX_ROOT).
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("ATTACHMENTS_ROOT")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file hardcodes a literal 'REVIEW_ROOTS' path string", () => {
    // Routes must not reference REVIEW_ROOTS directly - that belongs in the
    // review.server.ts seam module only (same rule as INBOX_ROOT / ATTACHMENTS_ROOT).
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("REVIEW_ROOTS")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file hardcodes a literal 'ACTIVITY_ROOT' path string", () => {
    // Routes must not reference ACTIVITY_ROOT directly - that belongs
    // in the activity.server.ts seam only. The Team tab reads the activity
    // state file through activityEnabled + readActivity and never learns the
    // path shape, same rule as every other root.
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("ACTIVITY_ROOT")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file hardcodes a literal 'PROJECTS_ROOT' path string", () => {
    // Routes must not reference PROJECTS_ROOT directly - that belongs in the
    // projects.server.ts seam module only (same rule as INBOX_ROOT / ATTACHMENTS_ROOT).
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("PROJECTS_ROOT")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 3: DEEPGRAM_API_KEY must never appear in app/ files
// (routes AND components). The key name is banned from the client-bundled tree.
// The key is held only in server/voice-proxy.mjs (outside app/, not bundled).
// ---------------------------------------------------------------------------

describe("DEEPGRAM_API_KEY banned from app/ (TASK-433 FND-02)", () => {
  it("no file under app/ references DEEPGRAM_API_KEY", () => {
    const appFiles = collectSourceFiles(APP_DIR);
    expect(appFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of appFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("DEEPGRAM_API_KEY")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 4: raw write primitives are banned from routes; every route
// write goes through a confined seam (the plan's "every Deck write is confined
// to a declared root" claim, asserted at the import layer).
// ---------------------------------------------------------------------------

describe("raw atomicWrite banned from app/routes/**", () => {
  it("no route file imports atomicWrite or atomicWriteBuffer", () => {
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    expect(routeFiles.length).toBeGreaterThan(0);

    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("atomicWrite")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });

  it("no route file references DATA_ROOT directly (seam rule, same as the other roots)", () => {
    const routeFiles = collectSourceFiles(ROUTES_DIR);
    const violations: string[] = [];
    for (const file of routeFiles) {
      const src = fs.readFileSync(file, "utf8");
      if (src.includes("DATA_ROOT")) {
        violations.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(violations).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Suite 5: production-shape cutover, end-to-end through the seam.
// A look-alike production root (tmpdir/.the-vault/agents) must accept a
// writeReply through the REAL FileInboxRepository and read it back. This is
// the integration proof that the substring-ban removal actually unlocks the
// cutover, not just the guard-function unit tests.
// ---------------------------------------------------------------------------

describe("production-shape cutover write (TASK-434, end-to-end seam)", () => {
  let tmpTree: string;
  let savedInboxRoot: string | undefined;

  beforeAll(() => {
    tmpTree = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
  });

  afterAll(() => {
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
    rmSync(tmpTree);
  });

  it("writeReply lands in a look-alike ~/.the-vault/agents root and reads back", async () => {
    const fakeRoot = path.join(tmpTree, ".the-vault", "agents");
    const inboxDir = path.join(fakeRoot, "quill", "inbox");
    fs.mkdirSync(inboxDir, { recursive: true });
    process.env["INBOX_ROOT"] = fakeRoot;

    const { inbox } = makeStores(process.env);
    await inbox.writeReply("quill", "alex", {
      header: {
        timestamp: "2026-06-07T13:30:00Z",
        from: "alex",
        status: "sent",
        subject: "cutover smoke",
      },
      body: "Production-shaped write through the seam.",
      rawMeta: "",
    });

    const blocks = await inbox.readBlocks("quill", "alex");
    expect(blocks.length).toBeGreaterThan(0);
    expect(
      blocks.some((b) => b.header.subject.includes("cutover smoke"))
    ).toBe(true);

    // And the file physically sits under the look-alike production root.
    const threadFile = path.join(inboxDir, "alex.md");
    expect(fs.existsSync(threadFile)).toBe(true);
  });

  it("the same seam still refuses a memory-file write under that root", async () => {
    const fakeRoot = path.join(tmpTree, ".the-vault", "agents");
    process.env["INBOX_ROOT"] = fakeRoot;
    fs.mkdirSync(path.join(fakeRoot, "quill"), { recursive: true });

    const { inbox } = makeStores(process.env);
    // participantName traversal aimed at MEMORY.md: joined path collapses to
    // <root>/quill/MEMORY.md - outside any inbox/ dir - and the shape refuses it.
    await expect(
      inbox.writeReply("quill", "../MEMORY", {
        header: {
          timestamp: "2026-06-07T13:31:00Z",
          from: "alex",
          status: "sent",
          subject: "must not land",
        },
        body: "x",
        rawMeta: "",
      })
    ).rejects.toThrow(/inbox write shape|FND-04|outside the inbox root/);
  });
});
