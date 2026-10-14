/**
 * file-manifest-cache.server.ts - route-layer cache for the Files panel manifest.
 *
 * Bounds the expensive whole-thread read + parse + file-reference extraction to
 * "once per new message" instead of "once per panel open". Keyed by
 * (agent, participant, inbox-file mtime + size): a metadata-only stat decides
 * whether the cached extraction is still valid, so a busy thread that has not
 * changed since the last open skips readBlocks + extractFileReferences entirely.
 *
 * This is the SAME module-level-Map pattern getCachedDescription uses in
 * file-description.server.ts. It lives at the file-manifest route layer only
 * (imported by api.file-manifest.tsx, nothing on the live chat-thread read
 * path). The inbox read functions (readBlocks / readBlocksWindow) are NOT
 * touched or cached - that path backs the live thread view and stays as-is,
 * per the SPEC's cardinal constraint (the P1 disappearing-messages class of
 * bug lived exactly on that read path).
 *
 * ASCII only - no em-dashes.
 */

import type { InboxRepository } from "./inbox.server.js";
import { extractFileReferences } from "./file-manifest.js";
import type { FileReference } from "./file-manifest.js";

interface ManifestCacheEntry {
  mtimeMs: number;
  size: number;
  refs: FileReference[];
}

/** (agent::participant) -> last extraction, tagged with the file mtime + size. */
const manifestCache = new Map<string, ManifestCacheEntry>();

/** Test instrumentation: number of full read+parse+extract runs performed. */
let parseCount = 0;

function keyFor(agent: string, participant: string): string {
  return `${agent}::${participant}`;
}

/**
 * Get the thread's file references, served from cache when the inbox file is
 * unchanged since the last extraction (mtime + size both match).
 *
 * On a miss (first open, a new message, or any size/mtime change) the whole
 * thread is read + parsed + extracted once, and the result replaces the cache
 * entry. A read error degrades to an empty manifest (matching the previous
 * inline route behaviour) and caches nothing, so a transient failure self-heals
 * on the next open.
 */
export async function getManifestRefs(
  inbox: InboxRepository,
  agent: string,
  participant: string,
): Promise<FileReference[]> {
  const key = keyFor(agent, participant);

  // statInbox returns null for a missing file (ENOENT) and only throws for a
  // genuine IO/permission error, so anything reaching this catch is worth a
  // trace - matching the readBlocks warn below - before we degrade to empty.
  let stat: { mtimeMs: number; size: number } | null;
  try {
    stat = await inbox.statInbox(agent, participant);
  } catch (err) {
    console.warn(
      `[file-manifest] statInbox failed for ${agent}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    stat = null;
  }

  // No file on disk: nothing stable to key a cache entry against, and readBlocks
  // would return [] anyway. Drop any stale entry and serve empty.
  if (!stat) {
    manifestCache.delete(key);
    return [];
  }

  const cached = manifestCache.get(key);
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    return cached.refs;
  }

  // Miss: pay the parse once, then cache it against this mtime + size.
  let refs: FileReference[];
  try {
    const blocks = await inbox.readBlocks(agent, participant);
    refs = extractFileReferences(blocks);
    parseCount += 1;
  } catch (err) {
    console.warn(
      `[file-manifest] readBlocks failed for ${agent}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    manifestCache.delete(key);
    return [];
  }

  manifestCache.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, refs });
  return refs;
}

/** Test hook: clear the cache + parse counter between tests. */
export function __resetManifestCache(): void {
  manifestCache.clear();
  parseCount = 0;
}

/** Test hook: total full read+parse+extract runs since the last reset. */
export function __manifestParseCount(): number {
  return parseCount;
}
