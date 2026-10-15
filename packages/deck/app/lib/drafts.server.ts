/**
 * drafts.server.ts - Markdown drafts as ordinary files under a workspace
 * `drafts/` folder (#66, first slice).
 *
 * A draft is a plain `<workspace>/drafts/<name>.md` file. The agent reads and
 * writes it with its normal file tools; the Deck editor reads and writes it
 * through this module. Nothing here is a new service: it is one directory, one
 * hidden sidecar file and the shared safe-fs primitives.
 *
 * WORKSPACE_ROOT (absolute, must exist) names the workspace. Every path is
 * confined to the realpath of `<WORKSPACE_ROOT>/drafts` (confineToRootReal),
 * and draft names are a single flat `*.md` component, so there is no
 * subfolder, traversal or dotfile surface.
 *
 * Version and conflicts. A draft's `version` is the sha256 of its bytes. The
 * editor sends the version it loaded as `baseVersion`; a save whose base no
 * longer matches the file on disk is refused with `conflict: true` and the
 * current copy, unless `force` is set. The check and the write run under the
 * shared advisory lock, so two saves through this module cannot interleave.
 * An external writer that does not take that lock can still land between the
 * check and the rename; atomicWrite keeps the file whole, but that one write
 * would be lost. The editor also polls, which narrows the window in practice.
 *
 * Who wrote the current version. Files carry no author. The sidecar
 * `drafts/.deck-drafts.json` records, per draft, the version hash the Deck
 * last saved for the person. If the file's current hash equals the recorded
 * one the writer is "person"; any other content is reported as "agent",
 * meaning "changed outside this editor". That is an inference, not an
 * identity: a person editing the file in another tool also reads as "agent".
 * The time shown is the file's mtime.
 *
 * ASCII only - no em-dashes.
 */

import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {
  atomicWrite,
  assertNoLiveSiloRoot,
  confineToRootReal,
  withInboxLock,
} from "./safe-fs.server.js";

export const DRAFTS_DIRNAME = "drafts";
export const META_FILENAME = ".deck-drafts.json";
export const MAX_DRAFT_BYTES = 1024 * 1024;

/** Flat file name: letters, digits, dot, dash, underscore, ending in .md. */
const DRAFT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

export type DraftWriter = "person" | "agent";

export interface DraftSummary {
  name: string;
  savedAt: string;
  writer: DraftWriter;
}

export interface DraftView extends DraftSummary {
  content: string;
  version: string;
}

export type DraftResult =
  | { ok: true; draft: DraftView }
  | { ok: false; error: string; status: number; conflict?: boolean; current?: DraftView };

export function resolveWorkspaceRoot(
  env: Record<string, string | undefined> = process.env
): string | undefined {
  const v = env["WORKSPACE_ROOT"]?.trim();
  if (!v) return undefined;
  if (!path.isAbsolute(v)) {
    throw new Error(`WORKSPACE_ROOT must be an absolute path, got: "${v}".`);
  }
  return v;
}

let lastConfigWarning = "";

/** Whether this instance has a workspace configured (never throws). */
export function draftsEnabled(
  env: Record<string, string | undefined> = process.env
): boolean {
  try {
    return resolveWorkspaceRoot(env) !== undefined;
  } catch (err) {
    // A relative path would silently hide the feature; say why, once per message.
    const msg = err instanceof Error ? err.message : String(err);
    if (msg !== lastConfigWarning) {
      lastConfigWarning = msg;
      console.warn(`[drafts] Drafts disabled: ${msg}`);
    }
    return false;
  }
}

/** Normalise a user-typed name to `<name>.md`, or null when it is not a safe flat name. */
export function normaliseDraftName(raw: string): string | null {
  let n = raw.trim();
  if (!n) return null;
  if (!n.toLowerCase().endsWith(".md")) n += ".md";
  return DRAFT_NAME_RE.test(n) && !n.includes("..") ? n : null;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Realpath of the drafts dir, created on demand. Throws when WORKSPACE_ROOT is
 * unset or missing, or when `drafts` resolves outside the workspace.
 */
function draftsDirReal(create: boolean): string {
  const ws = resolveWorkspaceRoot();
  if (!ws) throw new Error("WORKSPACE_ROOT is not set.");
  const wsReal = fs.realpathSync(ws);
  assertNoLiveSiloRoot(wsReal, "workspace");
  const dir = path.join(wsReal, DRAFTS_DIRNAME);
  if (create) fs.mkdirSync(dir, { recursive: true });
  const real = fs.realpathSync(dir);
  if (!real.startsWith(wsReal + path.sep)) {
    throw new Error("drafts folder resolves outside the workspace.");
  }
  return real;
}

function draftPath(dirReal: string, name: string, forWrite: boolean): string {
  return confineToRootReal(path.join(dirReal, name), dirReal, {
    forWrite,
    label: "drafts",
    notFound: "Draft not found.",
  });
}

// ---------------------------------------------------------------------------
// Sidecar
// ---------------------------------------------------------------------------

type Meta = Record<string, string>; // name -> version hash last saved by the person

/**
 * Read a regular file as UTF-8 through one file descriptor, never more than
 * max + 1 bytes: a file that grows after a stat cannot defeat the cap.
 * Throws DraftTooLarge when the file is over max, and the plain fs error
 * (ENOENT, EISDIR) otherwise.
 */
function readCapped(file: string, max: number): { text: string; mtime: Date } {
  // O_NONBLOCK: opening a FIFO for reading blocks until a writer appears, and
  // this runs synchronously, so a FIFO named x.md (or a symlink to one) would
  // freeze the whole server. With it the open returns at once, fstat shows a
  // non-regular file, and it is refused before any read. Regular files read
  // normally.
  // Cheap pre-check so a device node or pipe is not opened at all. It is only
  // a mitigation: the fstat below is the authoritative check, because the path
  // can be swapped between this stat and the open.
  if (!fs.statSync(file).isFile()) throw new Error("Not a regular file.");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile()) throw new Error("Not a regular file.");
    if (st.size > max) throw new DraftTooLarge();
    // Uninitialised on purpose (no 1 MB zero-fill per list or poll); only the
    // n bytes actually read are ever used.
    const buf = Buffer.allocUnsafe(max + 1);
    let n = 0;
    for (;;) {
      const r = fs.readSync(fd, buf, n, buf.length - n, null);
      if (r === 0) break;
      n += r;
      if (n > max) throw new DraftTooLarge();
    }
    return { text: buf.subarray(0, n).toString("utf8"), mtime: st.mtime };
  } finally {
    fs.closeSync(fd);
  }
}

function readMeta(dirReal: string): Meta {
  try {
    const parsed = JSON.parse(readCapped(path.join(dirReal, META_FILENAME), MAX_DRAFT_BYTES).text);
    const files = parsed?.files;
    if (!files || typeof files !== "object") return {};
    const out: Meta = {};
    for (const [k, v] of Object.entries(files)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Read the sidecar for a read-modify-write. Unlike readMeta this must not
 * silently treat a corrupt file as empty: the rewrite would then drop every
 * other draft's attribution. A file that exists but does not parse is copied
 * to `<sidecar>.bad` and logged before it is replaced. Any other read error
 * (for example the path is a directory) throws, so nothing is overwritten.
 */
function readMetaForWrite(dirReal: string): Meta {
  const file = path.join(dirReal, META_FILENAME);
  let raw: string;
  try {
    raw = readCapped(file, MAX_DRAFT_BYTES).text;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw err;
  }
  try {
    JSON.parse(raw);
  } catch {
    // Never follow a planted link: remove whatever is at the backup path
    // (unlink acts on a symlink itself) and create the copy exclusively.
    const bad = `${file}.bad`;
    fs.rmSync(bad, { force: true });
    fs.copyFileSync(file, bad, fs.constants.COPYFILE_EXCL);
    console.warn(`[drafts] ${META_FILENAME} is not valid JSON; kept a copy as ${META_FILENAME}.bad`);
    return {};
  }
  return readMeta(dirReal);
}

function writeMeta(dirReal: string, meta: Meta): void {
  atomicWrite(
    path.join(dirReal, META_FILENAME),
    JSON.stringify({ version: 1, files: meta }, null, 2) + "\n"
  );
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** An existing file over the cap: never read into memory by the Deck. */
class DraftTooLarge extends Error {
  constructor() {
    super("Draft is larger than 1 MB.");
  }
}

function view(dirReal: string, name: string, meta: Meta): DraftView {
  const p = draftPath(dirReal, name, false);
  const { text: content, mtime } = readCapped(p, MAX_DRAFT_BYTES);
  const version = sha256(content);
  return {
    name,
    content,
    version,
    savedAt: mtime.toISOString(),
    writer: meta[name] === version ? "person" : "agent",
  };
}

export function listDrafts(): DraftSummary[] {
  const dirReal = draftsDirReal(false);
  const meta = readMeta(dirReal);
  const out: DraftSummary[] = [];
  for (const entry of fs.readdirSync(dirReal, { withFileTypes: true })) {
    if (!(entry.isFile() || entry.isSymbolicLink()) || !DRAFT_NAME_RE.test(entry.name)) continue;
    try {
      try {
        const { name, savedAt, writer } = view(dirReal, entry.name, meta);
        out.push({ name, savedAt, writer });
      } catch (err) {
        if (!(err instanceof DraftTooLarge)) throw err;
        // Listed without being read; the Deck cannot have saved it (cap), so
        // it reads as the agent's. Opening it answers 413.
        const st = fs.statSync(draftPath(dirReal, entry.name, false));
        out.push({ name: entry.name, savedAt: st.mtime.toISOString(), writer: "agent" });
      }
    } catch {
      /* unreadable or escaping entry: not listed */
    }
  }
  return out.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
}

export function readDraft(rawName: string): DraftResult {
  const name = normaliseDraftName(rawName);
  if (!name) return { ok: false, error: "Invalid draft name.", status: 400 };
  try {
    const dirReal = draftsDirReal(false);
    return { ok: true, draft: view(dirReal, name, readMeta(dirReal)) };
  } catch (err) {
    if (err instanceof DraftTooLarge) {
      return { ok: false, error: "Draft is larger than 1 MB; edit it outside the Deck.", status: 413 };
    }
    return { ok: false, error: "Draft not found.", status: 404 };
  }
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

export interface SaveInput {
  name: string;
  content: string;
  /** Version the editor loaded. null/undefined = the editor believes the file is new. */
  baseVersion?: string | null;
  /** Overwrite whatever is on disk (the person chose "keep mine"). */
  force?: boolean;
  /** true = create only; refuse when the file already exists. */
  create?: boolean;
}

export async function saveDraft(input: SaveInput): Promise<DraftResult> {
  const name = normaliseDraftName(input.name);
  if (!name) return { ok: false, error: "Invalid draft name.", status: 400 };
  if (typeof input.content !== "string") {
    return { ok: false, error: "Content must be text.", status: 400 };
  }
  // Multipart form posts turn LF into CRLF; store LF so the file and the
  // editor text compare equal and the file is not CRLF-polluted.
  const content = input.content.replace(/\r\n?/g, "\n");
  if (Buffer.byteLength(content, "utf8") > MAX_DRAFT_BYTES) {
    return { ok: false, error: "Draft is larger than 1 MB.", status: 413 };
  }

  let dirReal: string;
  let target: string;
  try {
    dirReal = draftsDirReal(true);
    target = draftPath(dirReal, name, true);
    // A dangling symlink passes confinement (nothing to resolve) and would be
    // silently replaced by the rename; refuse any symlinked draft on write.
    if (fs.lstatSync(path.join(dirReal, name), { throwIfNoEntry: false })?.isSymbolicLink()) {
      return { ok: false, error: "Draft is a symbolic link.", status: 400 };
    }
  } catch {
    return { ok: false, error: "Drafts folder is not available.", status: 500 };
  }

  try {
    return await withInboxLock(target, async (): Promise<DraftResult> => {
      const meta = readMeta(dirReal);
      let current: DraftView | null = null;
      try {
        current = view(dirReal, name, meta);
      } catch (err) {
        if (err instanceof DraftTooLarge) {
          return { ok: false, error: "Existing draft is larger than 1 MB; edit it outside the Deck.", status: 413 };
        }
        // Absent (or vanished a moment ago) is a new file; anything else
        // present at that path (a directory) is not a draft.
        if (fs.lstatSync(target, { throwIfNoEntry: false })) {
          return { ok: false, error: "That path is not a draft file.", status: 400 };
        }
      }

      if (input.create && current) {
        return { ok: false, error: "A draft with that name already exists.", status: 409 };
      }
      if (!input.force && !input.create) {
        const base = input.baseVersion ?? null;
        const currentVersion = current ? current.version : null;
        if (base !== currentVersion) {
          return {
            ok: false,
            error: "This draft changed outside the editor.",
            status: 409,
            conflict: true,
            ...(current ? { current } : {}),
          };
        }
      }

      // The confinement checks above ran before the lock wait. Re-run them
      // now, immediately before the write, so a drafts folder swapped for a
      // symlink while this save was queued cannot redirect the write.
      if (draftsDirReal(false) !== dirReal) {
        return { ok: false, error: "Drafts folder changed; not saved.", status: 500 };
      }
      draftPath(dirReal, name, true);
      if (fs.lstatSync(target, { throwIfNoEntry: false })?.isSymbolicLink()) {
        return { ok: false, error: "Draft is a symbolic link.", status: 400 };
      }

      atomicWrite(target, content);
      const version = sha256(content);
      let savedAt = new Date().toISOString();
      try {
        savedAt = fs.statSync(target).mtime.toISOString();
      } catch {
        /* keep the clock time */
      }
      // The file is on disk now, so nothing below may turn this into a
      // failure: a retry would 409 against the person's own text. The result
      // is the version THIS save wrote, not a re-read: another writer may land
      // while the sidecar lock is awaited, and echoing their version would let
      // the next ordinary save overwrite it without a conflict. The sidecar is
      // shared by every draft, so its read-modify-write takes its own lock
      // (always after the per-draft lock, so no ordering cycle). A sidecar
      // failure is logged; the draft then reads as "agent" until the next save.
      try {
        await withInboxLock(path.join(dirReal, META_FILENAME), async () => {
          if (draftsDirReal(false) !== dirReal) throw new Error("drafts folder changed");
          const fresh = readMetaForWrite(dirReal);
          fresh[name] = version;
          writeMeta(dirReal, fresh);
        });
      } catch (err) {
        console.warn("[drafts] saved draft but could not update the sidecar:", err);
      }
      return { ok: true, draft: { name, content, version, savedAt, writer: "person" } };
    });
  } catch {
    return { ok: false, error: "Could not save the draft.", status: 500 };
  }
}
