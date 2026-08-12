/**
 * file-manifest-route.test.ts - the file-manifest GET loader's route-layer
 * cache (the Files panel perf fix).
 *
 * Drives the EXPORTED loader (opening the panel IS the loader), asserting:
 *   1. Cache hit: opening twice with an unchanged inbox file parses ONCE - the
 *      whole-thread read+parse+extract does not re-run.
 *   2. Cache invalidate (size): a new file-ref message lands -> re-parse, and
 *      the new ref shows up in the returned rows (no staleness).
 *   3. Cache invalidate (mtime): a same-size content change (mtime bump) also
 *      re-parses - proving mtime is in the key, not just size.
 *   4. statInbox: metadata-only probe, null for a missing file.
 *
 * The parse counter (__manifestParseCount) is the instrumentation the SPEC
 * acceptance criterion allows in place of spying on readBlocks.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { loader } from "~/routes/api.file-manifest";
import {
  __resetManifestCache,
  __manifestParseCount,
} from "~/lib/file-manifest-cache.server";
import { FileInboxRepository } from "~/lib/inbox.server";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

interface ManifestRow {
  path: string;
  name: string;
  description: string | null;
}
interface ManifestBody {
  ok: boolean;
  agent: string;
  rows: ManifestRow[];
  pins: string[];
}

let sandbox: string;
let savedInboxRoot: string | undefined;

function threadFile(agent: string, participant: string): string {
  return path.join(sandbox, agent, "inbox", `${participant}.md`);
}

function seed(agent: string, participant: string, content: string): void {
  const file = threadFile(agent, participant);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, "utf8");
}

function messageBlock(ts: string, from: string, body: string): string {
  return `## ${ts} - from: ${from} - status: read - subject: msg\n\n${body}\n\n---\n`;
}

async function openPanel(agent: string): Promise<ManifestBody> {
  const request = new Request(
    `http://localhost/api/file-manifest?agent=${encodeURIComponent(agent)}`,
  );
  // The loader only reads `request`; the other LoaderArgs fields are unused.
  const res = await loader({ request } as Parameters<typeof loader>[0]);
  return (await res.json()) as ManifestBody;
}

beforeEach(() => {
  sandbox = mkdtempSync();
  savedInboxRoot = process.env["INBOX_ROOT"];
  process.env["INBOX_ROOT"] = sandbox;
  __resetManifestCache();
});

afterEach(() => {
  rmSync(sandbox);
  if (savedInboxRoot === undefined) delete process.env["INBOX_ROOT"];
  else process.env["INBOX_ROOT"] = savedInboxRoot;
});

describe("api.file-manifest loader - route-layer cache", () => {
  it("cache hit: opening twice on an unchanged thread parses only once", async () => {
    seed(
      "quill",
      "alex",
      messageBlock("2026-06-18T10:00:00Z", "quill", "here is [spec](/home/you/spec.md)"),
    );

    const first = await openPanel("quill");
    expect(first.ok).toBe(true);
    expect(first.rows.map((r) => r.path)).toEqual(["/home/you/spec.md"]);
    expect(__manifestParseCount()).toBe(1);

    const second = await openPanel("quill");
    expect(second.rows.map((r) => r.path)).toEqual(["/home/you/spec.md"]);
    // The whole-thread parse did NOT re-run on the second open.
    expect(__manifestParseCount()).toBe(1);
  });

  it("cache invalidate (new message, size change): re-parses and picks up the new ref", async () => {
    const base = messageBlock(
      "2026-06-18T10:00:00Z",
      "quill",
      "here is [spec](/home/you/spec.md)",
    );
    seed("quill", "alex", base);

    await openPanel("quill");
    expect(__manifestParseCount()).toBe(1);

    // A new message lands, referencing a new file (grows the file -> size change).
    fs.appendFileSync(
      threadFile("quill", "alex"),
      messageBlock("2026-06-18T11:00:00Z", "alex", "and [notes](/home/you/notes.md)"),
      "utf8",
    );

    const after = await openPanel("quill");
    // Re-parsed (miss), and the new ref is present - no staleness.
    expect(__manifestParseCount()).toBe(2);
    expect(after.rows.map((r) => r.path).sort()).toEqual([
      "/home/you/notes.md",
      "/home/you/spec.md",
    ]);
  });

  it("cache invalidate (mtime change, same size): re-parses - mtime is in the key", async () => {
    seed(
      "quill",
      "alex",
      messageBlock("2026-06-18T10:00:00Z", "quill", "[spec](/home/you/spec.md)"),
    );

    await openPanel("quill");
    expect(__manifestParseCount()).toBe(1);

    // Bump mtime without touching content (size identical).
    const file = threadFile("quill", "alex");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(file, future, future);

    await openPanel("quill");
    expect(__manifestParseCount()).toBe(2);
  });

  it("missing thread file: empty manifest, no parse, no throw", async () => {
    const body = await openPanel("ghost");
    expect(body.ok).toBe(true);
    expect(body.rows).toEqual([]);
    expect(__manifestParseCount()).toBe(0);
  });
});

describe("FileInboxRepository.statInbox (metadata-only, additive)", () => {
  it("returns mtimeMs + size for an existing file, null for a missing one", async () => {
    seed("quill", "alex", "hello world\n");
    const repo = new FileInboxRepository(sandbox);

    const st = await repo.statInbox("quill", "alex");
    expect(st).not.toBeNull();
    expect(st!.size).toBe(Buffer.byteLength("hello world\n"));
    expect(typeof st!.mtimeMs).toBe("number");

    const missing = await repo.statInbox("quill", "nobody");
    expect(missing).toBeNull();
  });
});
