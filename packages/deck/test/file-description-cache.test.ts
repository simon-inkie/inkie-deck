/**
 * file-description-cache.test.ts - the description-cache memoisation perf fix.
 *
 * The description cache (file-descriptions.json) is a single global store read
 * once PER file reference on every panel open. Before this fix each read did a
 * synchronous readFileSync + JSON.parse of the whole growing file, so opening a
 * panel with N refs blocked the event loop N times. loadCache() is now memoised
 * with the same mtime/size guard as file-manifest-cache.server.ts. These tests
 * pin the guarantees:
 *
 *   1. A loader open with N refs reads the cache file from disk at most ONCE.
 *   2. A write (via generateDescription's no-key fallback -> saveCacheEntry) is
 *      immediately visible to a following getCachedDescription with ZERO extra
 *      disk reads (in-memory copy updated on write, not merely invalidated).
 *   3. An external change to the file (size / mtime) is picked up, not cached
 *      forever.
 *
 * The read counter (__descriptionCacheReadCount) is the instrumentation, in the
 * same spirit as __manifestParseCount in file-manifest-route.test.ts.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";
import {
  getCachedDescription,
  generateDescription,
  __resetDescriptionCache,
  __descriptionCacheReadCount,
} from "~/lib/file-description.server.js";
import { descriptionCacheKey } from "~/lib/file-manifest.js";
import type { FileReference } from "~/lib/file-manifest.js";

let sandbox: string;
let cachePath: string;
let savedDataRoot: string | undefined;
let savedCachePath: string | undefined;
let savedSpendPath: string | undefined;
let savedApiKey: string | undefined;

function ref(p: string): FileReference {
  return {
    path: p,
    name: path.basename(p),
    ext: path.extname(p).toLowerCase(),
    linkText: path.basename(p),
    firstSeenTimestamp: "2026-06-18T10:00:00Z",
    lastSeenTimestamp: "2026-06-18T10:00:00Z",
    firstSeenMessageIndex: 0,
    surrounding: [],
  };
}

/** Write the cache file directly (simulates a prior process / external writer). */
function seedCache(entries: Record<string, string>): void {
  const descriptions: Record<string, unknown> = {};
  for (const [key, description] of Object.entries(entries)) {
    descriptions[key] = { description, generated: true, at: "2026-06-18T10:00:00Z" };
  }
  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(
    cachePath,
    JSON.stringify({ version: 1, descriptions }, null, 2) + "\n",
    "utf8",
  );
}

beforeEach(() => {
  sandbox = mkdtempSync();
  cachePath = path.join(sandbox, "file-descriptions.json");
  savedDataRoot = process.env["DATA_ROOT"];
  savedCachePath = process.env["FILE_DESCRIPTION_CACHE_PATH"];
  savedSpendPath = process.env["GEMINI_SPEND_LOG_PATH"];
  savedApiKey = process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  // Writes are confined to DATA_ROOT, and the cache path must sit inside it.
  process.env["DATA_ROOT"] = sandbox;
  process.env["FILE_DESCRIPTION_CACHE_PATH"] = cachePath;
  // Keep the no-key generateDescription spend-log write inside the sandbox too
  // (fully hermetic, per the repo's assertGitClean isolation guard).
  process.env["GEMINI_SPEND_LOG_PATH"] = path.join(sandbox, "gemini-spend.jsonl");
  __resetDescriptionCache();
});

afterEach(() => {
  if (savedDataRoot === undefined) delete process.env["DATA_ROOT"];
  else process.env["DATA_ROOT"] = savedDataRoot;
  if (savedCachePath === undefined) delete process.env["FILE_DESCRIPTION_CACHE_PATH"];
  else process.env["FILE_DESCRIPTION_CACHE_PATH"] = savedCachePath;
  if (savedSpendPath === undefined) delete process.env["GEMINI_SPEND_LOG_PATH"];
  else process.env["GEMINI_SPEND_LOG_PATH"] = savedSpendPath;
  if (savedApiKey === undefined) delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
  else process.env["GOOGLE_GENERATIVE_AI_API_KEY"] = savedApiKey;
  rmSync(sandbox);
});

describe("file-description cache memoisation", () => {
  it("looking up N refs reads the cache file from disk at most once", () => {
    const refs = [
      ref("/home/you/a.md"),
      ref("/home/you/b.md"),
      ref("/home/you/c.md"),
      ref("/home/you/d.md"),
      ref("/home/you/e.md"),
    ];
    seedCache(
      Object.fromEntries(
        refs.map((r) => [descriptionCacheKey(r), `desc for ${r.name}`]),
      ),
    );
    __resetDescriptionCache();

    // This is exactly what the loader does: one getCachedDescription per ref.
    const got = refs.map((r) => getCachedDescription(r));

    expect(got).toEqual([
      "desc for a.md",
      "desc for b.md",
      "desc for c.md",
      "desc for d.md",
      "desc for e.md",
    ]);
    // N=5 lookups, one shared disk read.
    expect(__descriptionCacheReadCount()).toBe(1);
  });

  it("a write is visible to a following read with no extra disk read", async () => {
    // No API key -> generateDescription caches the link-text fallback via the
    // private saveCacheEntry, exercising the write path end to end.
    delete process.env["GOOGLE_GENERATIVE_AI_API_KEY"];
    const r = ref("/home/you/new.md");

    // No cache file yet: loadCache sees a missing file, reads nothing.
    expect(__descriptionCacheReadCount()).toBe(0);

    const result = await generateDescription(r, {
      threadAgent: "quill",
      participant: "alex",
    });
    expect(result.description).toBe("new.md"); // link-text fallback
    const readsAfterWrite = __descriptionCacheReadCount();

    // The freshly written entry is served straight from the in-memory copy.
    const cached = getCachedDescription(r);
    expect(cached).toBe("new.md");
    // Crucially: no disk re-read happened to serve it - the memo was updated on
    // write, not merely invalidated.
    expect(__descriptionCacheReadCount()).toBe(readsAfterWrite);
  });

  it("picks up an external change to the cache file (size + mtime)", () => {
    const r = ref("/home/you/x.md");
    const key = descriptionCacheKey(r);

    seedCache({ [key]: "first" });
    __resetDescriptionCache();

    expect(getCachedDescription(r)).toBe("first");
    expect(__descriptionCacheReadCount()).toBe(1);

    // Second lookup on the unchanged file is a memo hit (no new read).
    expect(getCachedDescription(r)).toBe("first");
    expect(__descriptionCacheReadCount()).toBe(1);

    // An external process rewrites the file with a longer value (size differs,
    // so the guard fires regardless of clock granularity).
    seedCache({ [key]: "second, materially longer description text" });

    expect(getCachedDescription(r)).toBe("second, materially longer description text");
    expect(__descriptionCacheReadCount()).toBe(2);
  });

  it("picks up a same-size external change via mtime bump", () => {
    const r = ref("/home/you/y.md");
    const key = descriptionCacheKey(r);

    seedCache({ [key]: "aaaa" });
    __resetDescriptionCache();

    expect(getCachedDescription(r)).toBe("aaaa");
    expect(__descriptionCacheReadCount()).toBe(1);

    // Same byte length, different content, mtime bumped into the future.
    seedCache({ [key]: "bbbb" });
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(cachePath, future, future);

    expect(getCachedDescription(r)).toBe("bbbb");
    expect(__descriptionCacheReadCount()).toBe(2);
  });

  it("degrades to a miss (no throw) when the file is absent", () => {
    expect(getCachedDescription(ref("/home/you/ghost.md"))).toBeUndefined();
    expect(__descriptionCacheReadCount()).toBe(0);
  });
});
