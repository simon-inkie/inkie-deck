/**
 * review.server.ts
 *
 * Read-only safe-fs module for the review side-panel (TASK-431, TASK-562).
 * Mirrors the discipline from attachments.server.ts:
 *   - realpath BOTH sides for containment
 *   - .the-vault ban (raw + resolved)
 *   - sep-suffixed startsWith prefix assert
 *   - console.warn on denial (observable in dev logs, no client leak)
 *   - route maps ALL throws to 404 (no reason leak)
 *
 * Exports:
 *   resolveReviewRoots() - parses REVIEW_ROOTS env (colon-separated absolute
 *     paths); implicit INBOX_ROOT always appended; unset = INBOX_ROOT only.
 *   readReviewFile(absPath) - returns {path, content, kind, lang} or throws.
 *   readReviewAsset(absPath) - returns {bytes, contentType} for images or throws.
 *
 * The .server suffix keeps this module out of the client bundle (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveInboxRoot } from "./safe-fs.server.js";
import { REVIEW_MD_EXTS, REVIEW_CODE_EXTS, extKind, extToLang, isSecretBasename } from "./review-exts.js";
import type { MessageBlock } from "./blocks/model.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Combined extension allowlist for readReviewFile.
 * Derived from the shared markdown + code sets in review-exts.ts so server
 * and client always agree on which extensions are servable.
 */
const REVIEW_DOC_EXTS = new Set([...REVIEW_MD_EXTS, ...REVIEW_CODE_EXTS]);

/** Allowed extensions for readReviewAsset. No SVG. */
const REVIEW_ASSET_EXTS: Record<string, string> = {
  ".png":  "image/png",
  ".jpg":  "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif":  "image/gif",
  ".webp": "image/webp",
};

const MAX_DOC_BYTES   = 2 * 1024 * 1024;  // 2MB
const MAX_ASSET_BYTES = 10 * 1024 * 1024; // 10MB

// ---------------------------------------------------------------------------
// expandTilde
// ---------------------------------------------------------------------------

/**
 * Expand a leading "~/" to the OS home directory.
 * Server-side only; the client never calls this.
 * A bare "~" (without trailing slash) is also expanded.
 */
export function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

// ---------------------------------------------------------------------------
// resolveReviewRoots
// ---------------------------------------------------------------------------

/**
 * Parse REVIEW_ROOTS (colon-separated absolute paths) and return the resolved
 * list with INBOX_ROOT always appended.
 *
 * Throws if:
 *   - An individual entry is not absolute after tilde-expansion.
 * Unset/empty REVIEW_ROOTS returns [INBOX_ROOT] only.
 */
export function resolveReviewRoots(): string[] {
  const raw = process.env["REVIEW_ROOTS"];
  const inboxRoot = resolveInboxRoot();

  const roots: string[] = [];

  if (raw && raw.trim() !== "") {
    for (const entry of raw.split(":")) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const expanded = expandTilde(trimmed);
      if (!path.isAbsolute(expanded)) {
        throw new Error(
          `REVIEW_ROOTS entry must be an absolute path, got: "${entry}". ` +
            "Relative paths are rejected."
        );
      }
      roots.push(expanded);
    }
  }

  // INBOX_ROOT is always appended (implicit root).
  // Dedup: only append if not already in the list.
  if (!roots.includes(inboxRoot)) {
    roots.push(inboxRoot);
  }

  return roots;
}

// ---------------------------------------------------------------------------
// Shared guard helpers
// ---------------------------------------------------------------------------

/**
 * Apply the shared guard chain to an absolute path against a list of roots.
 *
 * Steps:
 *   1. Shape: absolute, no NUL, no ".." segments (early, before fs).
 *   2. .the-vault ban (raw + resolved).
 *   3. Containment: realpathSync BOTH sides; must be inside at least one root.
 *
 * Returns the fully resolved path on success. Throws with a descriptive
 * message on failure (caller console.warn + map to 404).
 */
function assertContained(targetPath: string, roots: string[]): string {
  // Step 1: shape checks (early, before fs calls).
  if (!path.isAbsolute(targetPath)) {
    throw new Error(`Path must be absolute, got: "${targetPath}".`);
  }
  if (targetPath.includes("\0")) {
    throw new Error(`Path contains NUL byte: "${targetPath}".`);
  }
  // Reject ".." segments (defense-in-depth; realpath handles traversal too but
  // early rejection is cheaper and clearer).
  const normalized = path.normalize(targetPath);
  const parts = normalized.split(path.sep);
  if (parts.some((p) => p === "..")) {
    throw new Error(`Path contains ".." segment: "${targetPath}".`);
  }

  // Step 2: .the-vault ban on raw path.
  if (targetPath.includes(".the-vault")) {
    throw new Error(
      `Refusing to read: path contains banned substring ".the-vault": "${targetPath}".`
    );
  }

  // Resolve all roots (realpathSync, throws ENOENT if root does not exist).
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    try {
      resolvedRoots.push(fs.realpathSync(root));
    } catch {
      // Root does not exist yet (e.g. a configured path that has not been
      // created). Skip; if ALL roots are unavailable the containment check
      // will fail below.
    }
  }

  // Resolve the parent dir + join basename (file may not exist yet for some
  // callers, but readReviewFile and readReviewAsset always require the file to
  // exist - they call fs.statSync below, so ENOENT surfaces there).
  const parentDir = path.dirname(targetPath);
  let parentReal: string;
  try {
    parentReal = fs.realpathSync(parentDir);
  } catch {
    throw new Error(`Parent directory does not exist: "${parentDir}".`);
  }
  const joined = path.join(parentReal, path.basename(targetPath));

  // Step 2b: .the-vault ban on parent-resolved path.
  if (joined.includes(".the-vault")) {
    throw new Error(
      `Refusing to read: resolved path contains banned substring ".the-vault": "${joined}".`
    );
  }

  // Fully resolve the target itself if it exists (catches final-component symlinks).
  let finalResolved = joined;
  try {
    finalResolved = fs.realpathSync(joined);
    if (finalResolved.includes(".the-vault")) {
      throw new Error(
        `Refusing to read: fully-resolved path contains banned substring ".the-vault": "${finalResolved}".`
      );
    }
  } catch (err) {
    if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT") {
      finalResolved = joined;
    } else {
      throw err;
    }
  }

  // Step 3: containment - must be inside at least one resolved root.
  const contained = resolvedRoots.some(
    (rootReal) =>
      finalResolved === rootReal ||
      finalResolved.startsWith(rootReal + path.sep)
  );

  if (!contained) {
    throw new Error(
      `Refusing to read: resolved path "${finalResolved}" is outside all review roots ` +
        `[${resolvedRoots.join(", ")}].`
    );
  }

  return finalResolved;
}

// ---------------------------------------------------------------------------
// readReviewFile
// ---------------------------------------------------------------------------

export interface ReviewFileResult {
  path: string;
  content: string;
  /** "markdown" = render via Markdown component; "code" = render via CodeView. */
  kind: "markdown" | "code";
  /** highlight.js language id (relevant for kind === "code"; "plaintext" fallback). */
  lang: string;
}

/**
 * Read a document at absPath for the review panel (TASK-431, TASK-562).
 *
 * Gate chain (every failure throws; route maps all to 404, console.warn'd):
 *   1. Shape rejection (absolute, no NUL, no ".." segments).
 *   2. .the-vault ban (raw + resolved).
 *   3. Multi-root realpath containment.
 *   4. Extension allowlist (markdown + code set) - evaluated on BOTH the
 *      requested path AND the realpath'd path.
 *      (Peer-review hole Atlas 2026-06-06: a "notes.md -> .env" symlink inside
 *       an allowed root passes containment and requested-name check, but its
 *       RESOLVED extension is ".env" - denied here.)
 *   4a. Secret denylist (deny-before-allow, TASK-562 peer review 2026-06-28).
 *       Runs on BOTH basenames after extension passes. Catches signing_key.json,
 *       .env.production, *.age, *.pem, credential JSON patterns, etc. that have
 *       extensions which would otherwise be allowed (.json, .yaml, ...).
 *   5. Binary guard: NUL bytes in a code file => throw "binary file".
 *   6. Size cap (2MB).
 */
export function readReviewFile(absPath: string): ReviewFileResult {
  const roots = resolveReviewRoots();

  let finalResolved: string;
  try {
    finalResolved = assertContained(absPath, roots);
  } catch (err) {
    console.warn(`[review] denied readReviewFile for "${absPath}": ${String(err)}`);
    throw err;
  }

  // Gate 4: extension allowlist on BOTH requested and resolved paths.
  const requestedExt = path.extname(absPath).toLowerCase();
  const ext = path.extname(finalResolved).toLowerCase();
  if (!REVIEW_DOC_EXTS.has(requestedExt) || !REVIEW_DOC_EXTS.has(ext)) {
    const msg = `Extension not in review allowlist: requested "${requestedExt}", resolved "${ext}" for "${finalResolved}".`;
    console.warn(`[review] denied readReviewFile: ${msg}`);
    throw new Error(msg);
  }

  // Gate 4a: secret denylist - deny-before-allow on BOTH basenames.
  // Catches signing_key.json, .env.production, *.age, *.pem, credential JSON
  // patterns etc. that would otherwise pass the extension gate. Applied to
  // the REQUESTED basename (catches "innocently named" paths) AND the RESOLVED
  // basename (catches symlinks pointing at secrets inside a root).
  const requestedBasename = path.basename(absPath).toLowerCase();
  const resolvedBasename  = path.basename(finalResolved).toLowerCase();
  if (isSecretBasename(requestedBasename) || isSecretBasename(resolvedBasename)) {
    const msg = `Secret denylist: basename "${requestedBasename}" (resolved "${resolvedBasename}") matches a known-secret pattern.`;
    console.warn(`[review] denied readReviewFile: ${msg}`);
    throw new Error(msg);
  }

  // Gate 5: size cap.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(finalResolved);
  } catch {
    throw new Error(`File not found: "${finalResolved}".`);
  }
  if (stat.size > MAX_DOC_BYTES) {
    const msg = `File too large: "${finalResolved}" is ${(stat.size / (1024 * 1024)).toFixed(1)}MB, cap is 2MB.`;
    console.warn(`[review] denied readReviewFile: ${msg}`);
    throw new Error(msg);
  }

  // Derive kind and lang from the RESOLVED extension (not the requested ext,
  // to resist "notes.ts -> doc.md" attempts from flipping the renderer kind).
  const kind = extKind(ext);
  const lang = kind === "code" ? extToLang(ext) : "plaintext";

  const content = fs.readFileSync(finalResolved, "utf8");

  // Gate 5b (code only): binary guard. NUL bytes mean the file is binary
  // despite having a code extension. Return a sentinel rather than garbage.
  if (kind === "code" && content.includes("\0")) {
    const msg = `Binary file (NUL bytes detected), not shown: "${finalResolved}".`;
    console.warn(`[review] denied readReviewFile: ${msg}`);
    throw new Error(msg);
  }

  return { path: finalResolved, content, kind, lang };
}

// ---------------------------------------------------------------------------
// readReviewAsset
// ---------------------------------------------------------------------------

export interface ReviewAssetResult {
  bytes: Buffer;
  contentType: string;
}

/**
 * Read an image asset embedded in a reviewed document.
 *
 * Same guard chain as readReviewFile but with the image allowlist
 * (png/jpg/jpeg/gif/webp, 10MB). SVG explicitly excluded.
 * .md/.txt files denied through this route (gates do not cross).
 */
export function readReviewAsset(absPath: string): ReviewAssetResult {
  const roots = resolveReviewRoots();

  let finalResolved: string;
  try {
    finalResolved = assertContained(absPath, roots);
  } catch (err) {
    console.warn(`[review] denied readReviewAsset for "${absPath}": ${String(err)}`);
    throw err;
  }

  // Extension allowlist for assets (images only, NO svg).
  // Same both-sides rule as readReviewFile (Atlas hole): a "pic.png" symlink
  // at an .env target must not serve secret bytes as image/png.
  const requestedExt = path.extname(absPath).toLowerCase();
  const ext = path.extname(finalResolved).toLowerCase();
  const contentType =
    requestedExt in REVIEW_ASSET_EXTS ? REVIEW_ASSET_EXTS[ext] : undefined;
  if (!contentType) {
    const msg = `Extension not in review asset allowlist (png/jpg/jpeg/gif/webp): requested "${requestedExt}", resolved "${ext}" for "${finalResolved}".`;
    console.warn(`[review] denied readReviewAsset: ${msg}`);
    throw new Error(msg);
  }

  // File existence + size cap.
  let stat: fs.Stats;
  try {
    stat = fs.statSync(finalResolved);
  } catch {
    throw new Error(`Asset not found: "${finalResolved}".`);
  }
  if (stat.size > MAX_ASSET_BYTES) {
    const msg = `Asset too large: "${finalResolved}" is ${(stat.size / (1024 * 1024)).toFixed(1)}MB, cap is 10MB.`;
    console.warn(`[review] denied readReviewAsset: ${msg}`);
    throw new Error(msg);
  }

  const bytes = fs.readFileSync(finalResolved) as Buffer;
  return { bytes, contentType };
}

// ---------------------------------------------------------------------------
// Auto-linkify review paths (TASK-645)
// ---------------------------------------------------------------------------
//
// The review panel only opens a document when the message body contains REAL
// markdown link syntax "[label](/abs/path.md)". A bare absolute path or a
// backticked path renders as dead plain text and silently fails to open. This
// section rewrites such candidate paths into real clickable markdown links at
// RENDER time (in the thread loader / thread-window route), so it retroactively
// fixes already-sent messages, not only future ones.
//
// Extension scope: REVIEW_DOC_EXTS (REVIEW_MD_EXTS + REVIEW_CODE_EXTS - the
// same combined allowlist readReviewFile already serves). Widened to include
// code paths (.ts/.py/.sql/... etc) 2026-07-20 per Alex: the panel already
// fully supports opening code files via real links, the original doc-only
// scoping was a judgement call (a bare ".ts" mention felt more likely
// incidental than a share), not a technical limitation.
//   - ".pdf" (mentioned in the ticket prose) is in no existing review allowlist
//     and the panel cannot serve it, so a ".pdf" link would 404 - left plain on
//     purpose. We reuse the existing allowlist rather than inventing one.
//   - Images are deliberately NOT included: the panel can only inline an image
//     that is referenced INSIDE an already-open markdown document (rewritten to
//     /api/review-asset), there is no standalone "open a bare image path" mode,
//     and Alex confirmed inline images are fine as-is, no click-to-open needed.
//
// Containment reuses resolveReviewRoots() + assertContained() + isSecretBasename()
// - the exact same validation the review panel enforces. A path that does NOT
// resolve under a review root (e.g. under ~/agents/*) is left completely
// untouched: we never widen REVIEW_ROOTS and never guess.

/**
 * Build the "not a word/path char" boundary and the reusable path-core pattern.
 * A candidate is an absolute ("/...") or tilde ("~/...") path ending in a doc
 * or code extension from REVIEW_DOC_EXTS. The character class stops the path
 * at whitespace and the common delimiters that cannot appear mid-path in prose
 * (quotes, brackets, parens, angle brackets, backtick).
 */
const AUTOLINK_EXT_ALT = [...REVIEW_DOC_EXTS]
  .map((e) => e.slice(1)) // drop the leading dot
  .sort((a, b) => b.length - a.length) // longest first (markdown before md)
  .map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

const AUTOLINK_PATH_CORE = `(?:~\\/|\\/)[^\\s\`"'()\\[\\]<>]*\\.(?:${AUTOLINK_EXT_ALT})`;

/** The whole string must be exactly one path token (used for backtick spans). */
const AUTOLINK_ONLY_PATH_RE = new RegExp(`^${AUTOLINK_PATH_CORE}$`);

/**
 * Single-pass tokenizer. Alternatives are ordered so earlier (protected) spans
 * are consumed before the bare-path alternative can match inside them:
 *   1. fence   - a ``` fenced code block (leave verbatim, never linkify inside).
 *   2. mdlink  - an existing [text](url) link (leave verbatim, no double-linkify).
 *   3. code    - an inline `...` code span (candidate ONLY if the whole span is
 *                a single path; otherwise verbatim).
 *   4. bare    - a whitespace/boundary-delimited absolute or tilde path.
 * The bare alternative uses a negative lookbehind so it never starts mid-path
 * (e.g. the "/home/you" inside "foo/home/you" is not matched - that is a
 * relative path we deliberately ignore).
 *
 * The trailing boundary treats "." specially: a sentence-final period (nothing
 * word-like after it, e.g. "...report.md.") is a valid boundary, but a period
 * immediately followed by a word character is NOT (e.g. "report.md.bak") - it
 * signals the greedy match backtracked past the real end of the filename and
 * landed on a shorter, different candidate ("report.md" instead of the actual
 * "report.md.bak" token). Without this, the star's backtracking would silently
 * truncate the match to whichever earlier ".ext" it can complete, contradicting
 * the "never guess" contract: resolveReviewablePath would then validate a real
 * but WRONG file. Peer-review catch (Atlas), not a containment bypass on its
 * own (resolveReviewablePath still re-validates whatever is matched) but a
 * content-accuracy gap worth closing at the regex boundary.
 */
const AUTOLINK_TOKEN_RE = new RegExp(
  "(?<fence>```[\\s\\S]*?```)" +
    "|(?<mdlink>\\[[^\\]\\n]*\\]\\([^)\\n]*\\))" +
    "|(?<code>`[^`\\n]+`)" +
    `|(?<bare>(?<![\\w./~-])${AUTOLINK_PATH_CORE}(?=[\\s,;:!?)\\]'"]|\\.(?!\\w)|$))`,
  "g"
);

/**
 * Validate a candidate path against the review roots and return the resolved
 * absolute path to link to, or null if it must be left as plain text.
 *
 * Reuses the exact review-panel validation (no second implementation):
 *   - expandTilde + resolveReviewRoots (unless roots pre-passed by the caller).
 *   - assertContained (shape + .the-vault ban + multi-root realpath containment).
 *   - REVIEW_DOC_EXTS allowlist (doc + code) on BOTH requested and resolved
 *     extension - the same combined set readReviewFile serves.
 *   - isSecretBasename on BOTH basenames (deny-before-allow).
 *   - the resolved target must be an existing regular file (never linkify a
 *     dead path that would 404 in the panel).
 *
 * Never throws: any failure (not contained, not absolute, misconfigured roots,
 * missing file, secret, wrong extension) returns null.
 */
export function resolveReviewablePath(rawPath: string, roots?: string[]): string | null {
  try {
    const abs = expandTilde(rawPath);
    if (!path.isAbsolute(abs)) return null;

    const useRoots = roots ?? resolveReviewRoots();
    const resolved = assertContained(abs, useRoots);

    // Doc + code extension allowlist (REVIEW_DOC_EXTS) on both sides.
    const requestedExt = path.extname(abs).toLowerCase();
    const resolvedExt = path.extname(resolved).toLowerCase();
    if (!REVIEW_DOC_EXTS.has(requestedExt) || !REVIEW_DOC_EXTS.has(resolvedExt)) {
      return null;
    }

    // Secret denylist on both basenames.
    if (
      isSecretBasename(path.basename(abs).toLowerCase()) ||
      isSecretBasename(path.basename(resolved).toLowerCase())
    ) {
      return null;
    }

    // Must resolve to a real regular file.
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) return null;

    return resolved;
  } catch {
    return null;
  }
}

/**
 * Escape a filename for safe use as markdown link TEXT.
 * (Filenames rarely contain these, but a stray "]" or "\" would corrupt the
 * link; escaping keeps the span well-formed.)
 */
function escapeLinkLabel(label: string): string {
  return label.replace(/([\\[\]])/g, "\\$1");
}

/**
 * Wrap a resolved path as a markdown link destination. Angle-bracket the
 * destination when it contains a space or paren (valid CommonMark) so an odd
 * resolved path cannot break the "](...)" syntax.
 */
function markdownDest(absPath: string): string {
  return /[()\s]/.test(absPath) ? `<${absPath}>` : absPath;
}

/**
 * Rewrite bare / backticked review-root doc paths in a markdown body into real
 * clickable "[basename](/abs/path)" links. Server-side only (needs fs to check
 * containment). Never throws: on any error the original body is returned
 * unchanged, and a misconfigured/failing review-root resolution degrades to
 * leaving every candidate as plain text.
 *
 * Backtick handling: when an inline code span is exactly one reviewable path,
 * the backticks are REPLACED by the link (the whole `...` span becomes the
 * link). A code span containing surrounding text is left verbatim.
 *
 * precomputedRoots / sharedCache: optional, let a caller processing several
 * bodies in one request (linkifyBlockBodies) resolve roots once and share the
 * per-candidate resolution cache across all of them, instead of paying the
 * fs.realpathSync/fs.statSync cost per block. Omit both for a standalone call
 * (e.g. tests) - falls back to the original per-call behaviour.
 */
export function autoLinkifyReviewPaths(
  body: string,
  precomputedRoots?: string[],
  sharedCache?: Map<string, string | null>
): string {
  if (!body || (!body.includes("/") && !body.includes("~"))) return body;

  let roots: string[];
  if (precomputedRoots) {
    roots = precomputedRoots;
  } else {
    try {
      roots = resolveReviewRoots();
    } catch {
      // Misconfigured REVIEW_ROOTS - leave the whole body unchanged.
      return body;
    }
  }

  // assertContained() re-resolves every configured root via fs.realpathSync()
  // on each call; memoize per unique candidate string so a body mentioning
  // the same doc path N times pays one resolution instead of N. Shared across
  // blocks when the caller passes sharedCache (see linkifyBlockBodies).
  const resolveCache = sharedCache ?? new Map<string, string | null>();
  const resolveCached = (raw: string): string | null => {
    let cached = resolveCache.get(raw);
    if (cached === undefined) {
      cached = resolveReviewablePath(raw, roots);
      resolveCache.set(raw, cached);
    }
    return cached;
  };

  try {
    return body.replace(AUTOLINK_TOKEN_RE, (match: string, ...args: unknown[]) => {
      const groups = args[args.length - 1] as Record<string, string | undefined>;

      // Protected spans: never touch.
      if (groups.fence !== undefined || groups.mdlink !== undefined) return match;

      // Inline code span: candidate only if the whole inner is one path.
      if (groups.code !== undefined) {
        const inner = groups.code.slice(1, -1).trim();
        if (!AUTOLINK_ONLY_PATH_RE.test(inner)) return match;
        const resolved = resolveCached(inner);
        if (!resolved) return match;
        return `[${escapeLinkLabel(path.basename(resolved))}](${markdownDest(resolved)})`;
      }

      // Bare path.
      if (groups.bare !== undefined) {
        const resolved = resolveCached(groups.bare);
        if (!resolved) return match;
        return `[${escapeLinkLabel(path.basename(resolved))}](${markdownDest(resolved)})`;
      }

      return match;
    });
  } catch {
    return body;
  }
}

/**
 * Apply autoLinkifyReviewPaths to every block body, returning new block objects
 * (only `body` changes; `rawMeta` / `rawBlock` are preserved verbatim so card
 * parsing and round-trip fidelity are untouched). This is the shared choke
 * point wired into BOTH the thread loader and the thread-window route so the
 * fix applies to the initial window AND to lazily loaded older chunks.
 *
 * Resolves review roots and builds the resolution cache ONCE for the whole
 * call (CodeRabbit catch: without this, root resolution + the containment
 * fs.realpathSync/fs.statSync cost was paid once per block instead of once
 * per request, on a loader that re-runs on every poll cycle).
 *
 * Never throws: on any failure (including misconfigured/unset REVIEW_ROOTS)
 * the original blocks array is returned unchanged.
 */
export function linkifyBlockBodies(blocks: MessageBlock[]): MessageBlock[] {
  try {
    const roots = resolveReviewRoots();
    const cache = new Map<string, string | null>();
    return blocks.map((b) => {
      const linked = autoLinkifyReviewPaths(b.body, roots, cache);
      return linked === b.body ? b : { ...b, body: linked };
    });
  } catch {
    return blocks;
  }
}
