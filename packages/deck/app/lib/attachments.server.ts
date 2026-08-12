/**
 * attachments.server.ts
 *
 * Storage layer for file attachments. Mirrors the safe-fs discipline:
 * all reads and writes are guarded by realpath-based containment checks
 * rooted at ATTACHMENTS_ROOT.
 *
 * Exports:
 *   resolveAttachmentsRoot() - reads ATTACHMENTS_ROOT env; throws if unset/relative.
 *   assertSafeAttachmentPath(target, { forWrite }) - multi-layer guard.
 *   saveAttachment(agent, file) - validates policy, writes, returns { relPath, markdown }.
 *   readAttachment(relPath) - guards read path, returns { bytes, contentType, disposition }.
 *
 * The .server suffix keeps this module out of the client bundle (FND-02).
 * ASCII only - no em-dashes (FND-05).
 */

import fs from "node:fs";
import path from "node:path";
import {
  atomicWriteBuffer,
  assertNoLiveSiloRoot,
  confineToRootReal,
} from "./safe-fs.server.js";

// ---------------------------------------------------------------------------
// Type policy
// ---------------------------------------------------------------------------

export type AttachmentClass = "image" | "text" | "svg" | "file";

interface PolicyEntry {
  cls: AttachmentClass;
  /** true = served inline (image src); false = chip + Content-Disposition: attachment */
  inline: boolean;
  /** max bytes */
  maxBytes: number;
  /** fixed MIME type for serving */
  contentType: string;
}

const POLICY: Record<string, PolicyEntry> = {
  png:  { cls: "image", inline: true,  maxBytes: 10 * 1024 * 1024, contentType: "image/png" },
  jpg:  { cls: "image", inline: true,  maxBytes: 10 * 1024 * 1024, contentType: "image/jpeg" },
  jpeg: { cls: "image", inline: true,  maxBytes: 10 * 1024 * 1024, contentType: "image/jpeg" },
  gif:  { cls: "image", inline: true,  maxBytes: 10 * 1024 * 1024, contentType: "image/gif" },
  webp: { cls: "image", inline: true,  maxBytes: 10 * 1024 * 1024, contentType: "image/webp" },
  md:   { cls: "text",  inline: false, maxBytes:  1 * 1024 * 1024, contentType: "text/markdown; charset=utf-8" },
  txt:  { cls: "text",  inline: false, maxBytes:  1 * 1024 * 1024, contentType: "text/plain; charset=utf-8" },
  log:  { cls: "text",  inline: false, maxBytes:  1 * 1024 * 1024, contentType: "text/plain; charset=utf-8" },
  csv:  { cls: "text",  inline: false, maxBytes:  1 * 1024 * 1024, contentType: "text/csv; charset=utf-8" },
  json: { cls: "text",  inline: false, maxBytes:  1 * 1024 * 1024, contentType: "application/json" },
  svg:  { cls: "svg",   inline: false, maxBytes:  1 * 1024 * 1024, contentType: "application/octet-stream" },
  // XML follows the svg precedent: a render-capable type (XSLT / embedded
  // markup) is served as a download in octet-stream, never interpreted.
  // Added 2026-06-12 (Alex: XML attach rejected).
  xml:  { cls: "text",  inline: false, maxBytes:  1 * 1024 * 1024, contentType: "application/octet-stream" },
};

/**
 * ANY-TYPE DEFAULT (2026-06-12, Alex: "lets open it up to any
 * file?"). Extensions outside the table are accepted as plain files:
 * always download-only (Content-Disposition: attachment), always
 * application/octet-stream so the browser never interprets active content
 * (HTML/JS/anything renderable downloads instead of executing), and a
 * larger size cap bounded well below anything that could wedge the box.
 * Only the curated table above earns typed serving or inline rendering.
 */
const DEFAULT_POLICY: PolicyEntry = {
  cls: "file",
  inline: false,
  maxBytes: 25 * 1024 * 1024,
  contentType: "application/octet-stream",
};

export function policyForExtension(ext: string): PolicyEntry {
  return POLICY[ext.toLowerCase()] ?? DEFAULT_POLICY;
}

// ---------------------------------------------------------------------------
// resolveAttachmentsRoot
// ---------------------------------------------------------------------------

/**
 * Read process.env.ATTACHMENTS_ROOT and return it as an absolute path string.
 *
 * Throws if:
 *   - ATTACHMENTS_ROOT is unset or empty (no default).
 *   - ATTACHMENTS_ROOT is not an absolute path (relative paths are rejected).
 */
export function resolveAttachmentsRoot(): string {
  const root = process.env["ATTACHMENTS_ROOT"];
  if (!root || root.trim() === "") {
    throw new Error(
      "ATTACHMENTS_ROOT is required but not set. " +
        "Set ATTACHMENTS_ROOT to an absolute path to the attachments directory. " +
        "There is no default."
    );
  }
  if (!path.isAbsolute(root)) {
    throw new Error(
      `ATTACHMENTS_ROOT must be an absolute path, got: "${root}". ` +
        "Relative paths are rejected."
    );
  }
  return root;
}

// ---------------------------------------------------------------------------
// assertSafeAttachmentPath
// ---------------------------------------------------------------------------

/**
 * Assert that targetPath is safe to read or write within ATTACHMENTS_ROOT.
 *
 * TASK-434: rebased onto the shared confineToRootReal primitive in
 * safe-fs.server.ts (realpath both sides, parent-realpath + basename,
 * final-component realpath, sep-suffixed prefix assert). The substring ban
 * is gone; the MC_SANDBOX_ONLY live-silo refusal guards the root instead.
 *
 * For forWrite: false (read), also asserts the file exists.
 *
 * @returns The resolved absolute path (safe to use for fs operations).
 */
export function assertSafeAttachmentPath(
  targetPath: string,
  options: { forWrite: boolean }
): string {
  const root = resolveAttachmentsRoot();
  const rootReal = fs.realpathSync(root);
  assertNoLiveSiloRoot(rootReal, "attachments");

  return confineToRootReal(targetPath, rootReal, {
    forWrite: options.forWrite,
    label: "attachments",
    notFound: `Attachment not found: "${targetPath}".`,
  });
}

// ---------------------------------------------------------------------------
// saveAttachment
// ---------------------------------------------------------------------------

export interface AttachmentFile {
  name: string;
  type: string;
  bytes: Buffer;
}

export interface SaveAttachmentResult {
  relPath: string;
  markdown: string;
}

/**
 * Sanitise a filename: strip path separators + control chars, collapse
 * whitespace to underscores, lowercase extension, cap base at 80 chars.
 */
export function sanitiseFilename(name: string): string {
  // Strip path separators and control characters.
  let safe = name.replace(/[/\\<>:"|?*\x00-\x1f]/g, "");
  // Collapse whitespace to underscore.
  safe = safe.replace(/\s+/g, "_");
  // Strip leading dots.
  safe = safe.replace(/^\.+/, "");
  if (safe === "") safe = "file";

  // Lowercase extension.
  const dotIdx = safe.lastIndexOf(".");
  if (dotIdx > 0) {
    const base = safe.slice(0, dotIdx);
    const ext = safe.slice(dotIdx + 1).toLowerCase();
    const cappedBase = base.slice(0, 80);
    safe = `${cappedBase}.${ext}`;
  } else {
    safe = safe.slice(0, 80);
  }
  return safe;
}

/**
 * Build a YYYYMMDD-HHMMSS timestamp prefix from a Date.
 */
function timestampPrefix(d: Date): string {
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `-${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

/**
 * Save an uploaded file for a given agent.
 *
 * Validates the type policy (extension must be in the policy table, file must
 * not exceed the per-class size cap). Writes to <ATTACHMENTS_ROOT>/<agent>/mc/
 * with a YYYYMMDD-HHMMSS timestamp prefix. On collision appends -1, -2, etc.
 *
 * Returns { relPath, markdown } where relPath is the path relative to
 * ATTACHMENTS_ROOT (used as the URL subpath) and markdown is the ready-to-insert
 * link string.
 */
export async function saveAttachment(
  agent: string,
  file: AttachmentFile
): Promise<SaveAttachmentResult> {
  const sanitised = sanitiseFilename(file.name);
  const dotIdx = sanitised.lastIndexOf(".");
  const ext = dotIdx > 0 ? sanitised.slice(dotIdx + 1).toLowerCase() : "";

  // Any-type policy (2026-06-12): every extension resolves - curated types
  // get typed handling, everything else the download-only default.
  const policy = policyForExtension(ext);

  if (file.bytes.length > policy.maxBytes) {
    const mbLimit = Math.round(policy.maxBytes / (1024 * 1024));
    throw new Error(
      `File too large: "${file.name}" is ${(file.bytes.length / (1024 * 1024)).toFixed(1)}MB, limit is ${mbLimit}MB for .${ext} files.`
    );
  }

  // Validate the agent segment BEFORE any filesystem effect: mkdirSync below
  // creates directories, so a traversal-shaped agent ("../../evil") must be
  // rejected here, not caught later by the file-path guard. Same regex as the
  // roster AGENT_NAME convention.
  if (!/^[a-z0-9][a-z0-9-]*$/.test(agent)) {
    throw new Error(`Invalid agent name for attachment storage: "${agent}".`);
  }

  const root = resolveAttachmentsRoot();
  // Ensure the agent/mc subdirectory exists.
  const agentDir = path.join(root, agent, "mc");
  fs.mkdirSync(agentDir, { recursive: true });

  const prefix = timestampPrefix(new Date());
  let finalName = `${prefix}-${sanitised}`;
  let targetPath = path.join(agentDir, finalName);

  // Collision suffix: if the file already exists, append -1, -2, etc.
  if (fs.existsSync(targetPath)) {
    let n = 1;
    while (fs.existsSync(targetPath)) {
      finalName = `${prefix}-${sanitised.slice(0, dotIdx > 0 ? dotIdx : undefined)}-${n}${dotIdx > 0 ? "." + ext : ""}`;
      targetPath = path.join(agentDir, finalName);
      n++;
    }
  }

  const safePath = assertSafeAttachmentPath(targetPath, { forWrite: true });
  atomicWriteBuffer(safePath, file.bytes);

  // relPath is relative to ATTACHMENTS_ROOT, used as the URL path component.
  const relPath = path.join(agent, "mc", finalName);
  const urlPath = `/attachments/${relPath.replace(/\\/g, "/")}`;

  const markdown =
    policy.cls === "image"
      ? `![${sanitised}](${urlPath})`
      : `[${sanitised}](${urlPath})`;

  return { relPath, markdown };
}

// ---------------------------------------------------------------------------
// readAttachment
// ---------------------------------------------------------------------------

export interface ReadAttachmentResult {
  bytes: Buffer;
  contentType: string;
  /** "inline" | "attachment" */
  disposition: "inline" | "attachment";
}

/**
 * Read an attachment by its path relative to ATTACHMENTS_ROOT.
 *
 * Guards the path (read variant), determines content-type from the extension
 * (never from the stored filename beyond the extension), and returns the
 * disposition rule from the policy.
 *
 * Throws on any guard failure (caller maps to 404).
 */
export function readAttachment(relPath: string): ReadAttachmentResult {
  const root = resolveAttachmentsRoot();
  const targetPath = path.join(root, relPath);
  const safePath = assertSafeAttachmentPath(targetPath, { forWrite: false });

  const dotIdx = relPath.lastIndexOf(".");
  const ext = dotIdx > 0 ? relPath.slice(dotIdx + 1).toLowerCase() : "";

  // TASK-431 lesson, applied to attachments (TASK-434 sweep): the policy gate
  // must also hold on the RESOLVED path. A symlink like notes.md -> creds.env
  // inside the root would otherwise serve .env bytes under a .md policy.
  const resolvedExt = path.extname(safePath).replace(/^\./, "").toLowerCase();
  if (resolvedExt !== ext) {
    throw new Error(
      `Refusing to serve: resolved file extension ".${resolvedExt}" does not ` +
        `match the requested extension ".${ext}" (symlink extension swap).`
    );
  }

  // Any-type policy (2026-06-12) supersedes the TASK-430 read allowlist:
  // an unmapped extension now serves through the download-only default
  // (octet-stream + attachment disposition - bytes move, nothing is ever
  // interpreted). The symlink extension-swap guard above still holds, and
  // typed/inline serving remains exclusive to the curated table.
  const policy = policyForExtension(ext);

  const bytes = fs.readFileSync(safePath);

  const contentType = policy.contentType;
  const disposition: "inline" | "attachment" =
    policy.inline === true ? "inline" : "attachment";

  return { bytes, contentType, disposition };
}
