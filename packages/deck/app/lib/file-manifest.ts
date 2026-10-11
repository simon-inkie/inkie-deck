/**
 * file-manifest.ts - PURE file-reference extraction for the thread Files panel.
 *
 * No IO, no fs, no env, no .server import. Safe in both the client and server
 * bundle (the panel UI imports the types + the cache-key hash; the loader
 * imports the extractor).
 *
 * Reuses the SAME link-detection rules the review side-panel uses (Markdown.tsx
 * isPathShapedDocLink / isAttachmentTextChip), generalised to ANY file
 * extension (the panel is a file MANIFEST, not an .md filter - SPEC C).
 *
 * The extractor walks a thread's MessageBlocks, pulls every distinct file
 * reference out of the markdown bodies, dedupes by path (first-seen timestamp +
 * most-recent mention), and attaches a small window of surrounding messages
 * (N before/after) for the gemini description generator.
 *
 * ASCII only - no em-dashes.
 */

import type { MessageBlock } from "./blocks/model.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single message in the surrounding-window passed to the description gen. */
export interface SurroundingMessage {
  from: string;
  timestamp: string;
  /** Body trimmed to a sane length so the gemini prompt stays cheap. */
  body: string;
}

/**
 * One distinct file reference collected from a thread.
 *
 * Dedupe identity is `path`. firstSeenTimestamp + firstSeenMessageIndex are the
 * earliest mention; lastSeenTimestamp the most recent. The panel sorts by
 * lastSeenTimestamp (newest-first, SPEC 1).
 */
export interface FileReference {
  /** The path/url exactly as written in the markdown (the dedupe key, and the
   * ?doc= value the side-panel opens). Tilde paths stay tilde here; the server
   * expands them. */
  path: string;
  /** The link text the agent wrote (fallback description, SPEC B graceful degrade). */
  linkText: string;
  /** Basename for display. */
  name: string;
  /** Lowercase extension incl. dot (e.g. ".md", ".png", ""). */
  ext: string;
  /** Earliest mention timestamp (ISO). */
  firstSeenTimestamp: string;
  /** Most recent mention timestamp (ISO) - the panel's newest-first sort key. */
  lastSeenTimestamp: string;
  /** Absolute thread index of the message the file FIRST appeared in. */
  firstSeenMessageIndex: number;
  /** Window of messages around the first mention, for the description generator. */
  surrounding: SurroundingMessage[];
}

// ---------------------------------------------------------------------------
// Link detection (mirrors Markdown.tsx, generalised to any extension)
// ---------------------------------------------------------------------------

/** Max body length carried into a surrounding-window message (keeps prompts cheap). */
const SURROUNDING_BODY_MAX = 600;

/** Default surrounding-window radius (N messages before AND after). SPEC: N ~= 2-3. */
export const DEFAULT_WINDOW_RADIUS = 3;

/**
 * Markdown inline-link matcher: [text](href).
 * Captures group 1 = text, group 2 = href. Global so we can walk every link.
 * Deliberately simple - matches the review-panel surface (agents write standard
 * markdown links to files). We do not parse reference-style or autolinks.
 */
const MD_LINK_RE = /\[([^\]]*)\]\(([^)\s]+)\)/g;

/**
 * Returns true when an href is a file reference the manifest should collect.
 *
 * Two shapes, mirroring Markdown.tsx:
 *   1. Absolute / tilde filesystem path: starts with "/" or "~/" AND has a file
 *      extension on its last segment (so a bare "/threads/quill" route link is not
 *      mistaken for a file). ANY extension qualifies (file manifest, not md-only).
 *   2. /attachments/ URL (uploaded files) with an extension.
 *
 * Explicitly NOT collected: http(s):// external links, mailto:, in-app route
 * links without an extension, data: URIs.
 */
export function isFileReferenceHref(href: string): boolean {
  if (!href) return false;
  if (href.startsWith("/attachments/")) {
    return hasFileExtension(href);
  }
  if (href.startsWith("~/")) return hasFileExtension(href);
  if (href.startsWith("/")) {
    // Reject protocol-relative "//host" and ensure a real path with extension.
    if (href.startsWith("//")) return false;
    return hasFileExtension(href);
  }
  return false;
}

/** True when the last path segment has a "." with at least one extension char. */
function hasFileExtension(href: string): boolean {
  const lastSeg = href.split(/[/\\]/).pop() ?? "";
  const dot = lastSeg.lastIndexOf(".");
  // dot must be present, not leading (".env" IS a file, so dot===0 is allowed
  // only when followed by chars), and have at least one char after it.
  return dot >= 0 && dot < lastSeg.length - 1;
}

/** Lowercase extension (incl. dot) of a path/href, or "" when none. */
export function fileExt(href: string): string {
  const lastSeg = href.split(/[/\\]/).pop() ?? "";
  const dot = lastSeg.lastIndexOf(".");
  if (dot < 0 || dot === lastSeg.length - 1) return "";
  return lastSeg.slice(dot).toLowerCase();
}

/** Basename of a path/href. */
export function fileBasename(href: string): string {
  const parts = href.split(/[/\\]/);
  return parts[parts.length - 1] || href;
}

// ---------------------------------------------------------------------------
// Extraction
// ---------------------------------------------------------------------------

/** One raw link occurrence found in a single message body. */
interface LinkHit {
  path: string;
  linkText: string;
}

/** Pull every collectible file-reference link out of a single markdown body. */
function extractLinksFromBody(body: string): LinkHit[] {
  const hits: LinkHit[] = [];
  // Reset lastIndex defensively (global regex is module-scoped).
  MD_LINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_LINK_RE.exec(body)) !== null) {
    const linkText = m[1] ?? "";
    const href = m[2] ?? "";
    if (isFileReferenceHref(href)) {
      hits.push({ path: href, linkText });
    }
  }
  return hits;
}

/** Trim a body to SURROUNDING_BODY_MAX chars on a word-ish boundary. */
function clampBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length <= SURROUNDING_BODY_MAX) return trimmed;
  return trimmed.slice(0, SURROUNDING_BODY_MAX) + "...";
}

/**
 * Build the surrounding-message window for a reference first seen at
 * `centerIndex` (absolute thread index). Includes the center message and up to
 * `radius` messages on each side, clamped to the array bounds.
 *
 * `blocks` is the full thread slice; `baseIndex` is the absolute index of
 * blocks[0] so the returned indices line up with FileReference.firstSeenMessageIndex.
 */
function buildSurrounding(
  blocks: readonly MessageBlock[],
  centerLocalIndex: number,
  radius: number
): SurroundingMessage[] {
  const start = Math.max(0, centerLocalIndex - radius);
  const end = Math.min(blocks.length - 1, centerLocalIndex + radius);
  const out: SurroundingMessage[] = [];
  for (let i = start; i <= end; i++) {
    const b = blocks[i]!;
    out.push({
      from: b.header.from,
      timestamp: b.header.timestamp,
      body: clampBody(b.body),
    });
  }
  return out;
}

/**
 * Extract the file manifest from a thread's message blocks.
 *
 * @param blocks - The thread's parsed MessageBlocks (chronological).
 * @param baseIndex - The absolute thread index of blocks[0] (0 for a full read).
 *   Used so firstSeenMessageIndex is a stable absolute index.
 * @param radius - Surrounding-window radius (default DEFAULT_WINDOW_RADIUS).
 * @returns Distinct file references, newest-first (by lastSeenTimestamp).
 */
export function extractFileReferences(
  // readonly: inbox.readBlocks serves a FROZEN, cached array. Widening the
  // parameter accepts both that and any mutable list; the body only reads.
  blocks: readonly MessageBlock[],
  baseIndex = 0,
  radius = DEFAULT_WINDOW_RADIUS
): FileReference[] {
  const byPath = new Map<string, FileReference>();

  blocks.forEach((block, localIndex) => {
    const absIndex = baseIndex + localIndex;
    const ts = block.header.timestamp;
    const hits = extractLinksFromBody(block.body);
    for (const hit of hits) {
      const existing = byPath.get(hit.path);
      if (existing === undefined) {
        byPath.set(hit.path, {
          path: hit.path,
          linkText: hit.linkText || fileBasename(hit.path),
          name: fileBasename(hit.path),
          ext: fileExt(hit.path),
          firstSeenTimestamp: ts,
          lastSeenTimestamp: ts,
          firstSeenMessageIndex: absIndex,
          surrounding: buildSurrounding(blocks, localIndex, radius),
        });
      } else {
        // Most-recent mention wins for lastSeenTimestamp (string ISO compare is
        // chronological for same-zone Z timestamps).
        if (ts > existing.lastSeenTimestamp) existing.lastSeenTimestamp = ts;
        if (ts < existing.firstSeenTimestamp) {
          existing.firstSeenTimestamp = ts;
          existing.firstSeenMessageIndex = absIndex;
          existing.surrounding = buildSurrounding(blocks, localIndex, radius);
        }
        // Prefer a non-empty link text if the first occurrence had none.
        if (
          (existing.linkText === existing.name || existing.linkText === "") &&
          hit.linkText &&
          hit.linkText !== existing.name
        ) {
          existing.linkText = hit.linkText;
        }
      }
    }
  });

  return [...byPath.values()].sort((a, b) =>
    a.lastSeenTimestamp < b.lastSeenTimestamp
      ? 1
      : a.lastSeenTimestamp > b.lastSeenTimestamp
        ? -1
        : 0
  );
}

// ---------------------------------------------------------------------------
// Description cache key
// ---------------------------------------------------------------------------

/**
 * Stable cache key for a generated description: (path + surrounding-window hash).
 * SPEC B: "generated once per file-reference, cached by (path + surrounding-window
 * hash), never regenerated on render."
 *
 * The window hash is a djb2 fingerprint of the path plus every surrounding
 * message's from+timestamp+body. Same surrounding context => same key => cache
 * hit; if the context around the file changes, a fresh description is generated.
 *
 * Pure + deterministic so the client and server compute the identical key.
 */
export function descriptionCacheKey(ref: FileReference): string {
  let h = 5381;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    }
    // separator to avoid boundary collisions
    h = ((h << 5) + h + 0x1f) | 0;
  };
  feed(ref.path);
  for (const m of ref.surrounding) {
    feed(m.from);
    feed(m.timestamp);
    feed(m.body);
  }
  const hex = (h >>> 0).toString(16);
  return `${ref.path}@${hex}`;
}
