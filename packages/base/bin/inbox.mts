#!/usr/bin/env node
/**
 * inbox -- agent inbox helper CLI.
 *
 * Commands:
 *   inbox read [correspondent]         Print unread blocks, flip sent->read.
 *   inbox reply <correspondent> ...    Append a block, flip their last sent->read.
 *   inbox ack <correspondent>          Flip-only: mark their unread blocks read.
 *   inbox unread                       List correspondents with unread counts.
 *
 * Identity:   AGENT_NAME env var (hard-error if unset).
 * Inbox root: $SILO_HOME/<AGENT_NAME>/inbox/  (SILO_HOME defaults to ~/.agent-silo)
 *
 * Runs with no install step and no build step: it is a `.mts` file, which Node
 * type-strips natively (Node 22.18+ / 24+). `.mts` rather than `.ts` on
 * purpose: `.mts` is always an ES module regardless of the nearest
 * package.json's "type" field, so the file keeps working when copied into an
 * arbitrary directory on someone's PATH.
 */
import { spawnSync } from "node:child_process";
import { randomBytes, randomInt } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

// U+2014 / U+2013 are written as escapes rather than literally: this repo
// forbids a literal em-dash in source, and the character is protocol syntax
// here (a header field separator), not prose.
export const EM_DASH = "\u2014";
export const EN_DASH = "\u2013";

export const SEP_PATTERN = "(?:\u2014|\u2013| - )";

// The `d` flag records the character range of every capture group. It changes
// nothing about WHAT matches; flipBlocksInFile needs the exact range of the
// `status` group, and must derive it from THIS grammar rather than re-searching
// the header with a second, looser pattern. See the comment there for the file
// corruption a second pattern causes.
export const HEADER_RE =
  /^## (?<ts>[^\s]+)\s*(?:\u2014|\u2013| - )\s*from:\s*(?<sender>[^\s]+)\s*(?:\u2014|\u2013| - )\s*status:\s*(?<status>sent|read)\s*(?:\u2014|\u2013| - )\s*subject:(?<subject>.*)/di;

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
// Python's print() writes through a stream that is flushed on interpreter exit
// even after sys.exit(). Node's process.stdout is ASYNCHRONOUS when it is a
// pipe, so console.log() immediately followed by process.exit() can drop the
// text entirely. Every write here goes through fs.writeSync on the raw fd,
// which is synchronous for pipes, files and TTYs alike, so an error message
// printed just before a non-zero exit is never lost.
function out(line = ""): void {
  fs.writeSync(1, line + "\n");
}

function err(line: string): void {
  fs.writeSync(2, line + "\n");
}

// ---------------------------------------------------------------------------
// Cross-process inbox lock
// ---------------------------------------------------------------------------
// Inbox thread files may be written by more than one uncoordinated process:
// this CLI, and potentially a companion app (e.g. a web UI) sharing the same
// silo. A writer that does a full-file read-modify-write via temp+rename will
// orphan a concurrent append (rename swaps the inode), so a send here
// interleaving with such a rewrite would be silently lost. Fix: every writer
// takes a shared advisory lock on "<file>.lock" via O_EXCL.
//
// Any other writer sharing these files MUST implement this identical lock
// protocol, or the two sides will not mutually exclude each other. Keep the
// critical section TINY (just the mutation): a reply append can be
// high-frequency, and holding the lock longer than the mutation itself only
// increases contention for everyone else waiting on it.
const LOCK_STALE_SECONDS = 10.0; // legit holds are ms; >10s => holder died (steal it)
const LOCK_CEILING = 30.0; // past this, raise LOUDLY -- never silently drop a write
const LOCK_BACKOFF = 0.004;
const LOCK_JITTER = 0.004;

/**
 * Raised if the lock can't be acquired within the ceiling. Loud by design:
 * a dropped write is the very data loss this fix exists to stop.
 */
export class InboxLockTimeout extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InboxLockTimeout";
  }
}

function errnoCode(e: unknown): string | undefined {
  return typeof e === "object" && e !== null && "code" in e
    ? String((e as { code: unknown }).code)
    : undefined;
}

// Synchronous sleep. The whole lock protocol is synchronous by construction
// (an async release would let a second command in this same process interleave
// inside the critical section), so the backoff must block the thread too.
// Atomics.wait on a throwaway SharedArrayBuffer is the only stdlib way to do
// that; busy-waiting on Date.now() would burn a core under contention, which is
// exactly the situation the backoff exists to survive.
function sleepSeconds(seconds: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(shared, 0, 0, Math.max(0, seconds * 1000));
}

export function withInboxLock<T>(targetPath: string, body: () => T): T {
  const lockpath = targetPath + ".lock";
  const token = `${process.pid}:${process.hrtime.bigint()}:${randomBytes(4).toString("hex")}`;
  const deadline = performance.now() / 1000 + LOCK_CEILING;
  for (;;) {
    try {
      // "wx" is O_CREAT | O_EXCL | O_WRONLY: the create either wins outright or
      // fails with EEXIST. That atomicity is the whole mutual exclusion.
      const fd = fs.openSync(lockpath, "wx", 0o644);
      fs.writeSync(fd, token + "\n");
      fs.closeSync(fd);
      break;
    } catch (e) {
      if (errnoCode(e) !== "EEXIST") {
        throw e;
      }
    }
    let age: number;
    try {
      age = Date.now() / 1000 - fs.statSync(lockpath).mtimeMs / 1000;
    } catch (e) {
      if (errnoCode(e) === "ENOENT") {
        continue; // released between our open and stat -> retry create
      }
      throw e;
    }
    if (age > LOCK_STALE_SECONDS) {
      const steal = `${lockpath}.steal.${token}`;
      try {
        fs.renameSync(lockpath, steal); // ATOMIC: only one winner can steal
      } catch {
        continue;
      }
      try {
        fs.unlinkSync(steal);
      } catch (e) {
        if (errnoCode(e) !== "ENOENT") {
          throw e;
        }
      }
      continue;
    }
    if (performance.now() / 1000 >= deadline) {
      throw new InboxLockTimeout(
        `inbox lock ${lockpath} not acquired in ${LOCK_CEILING}s`,
      );
    }
    sleepSeconds(LOCK_BACKOFF + randomInt(Math.trunc(LOCK_JITTER * 1000)) / 1000.0);
  }
  try {
    return body();
  } finally {
    // Release ONLY if the lock still holds our token (a slow holder that was
    // stolen from must not unlink the stealer's lock).
    try {
      const held = fs.readFileSync(lockpath, "utf8").trim();
      if (held === token) {
        fs.unlinkSync(lockpath);
      }
    } catch (e) {
      if (errnoCode(e) !== "ENOENT") {
        throw e;
      }
    }
  }
}

export function agentName(): string {
  const name = (process.env.AGENT_NAME ?? "").trim();
  if (!name) {
    err("ERROR: AGENT_NAME environment variable is not set.");
    process.exit(1);
  }
  return name;
}

// Node has no expanduser. os.homedir() consults the password database when
// HOME is unset, whereas Python's expanduser prefers $HOME when it is set;
// tests (and containers) rely on an overridden HOME, so check it first.
function expandUser(p: string): string {
  if (!p.startsWith("~")) {
    return p;
  }
  const home = process.env.HOME || os.homedir();
  const rest = p.slice(1);
  if (rest === "") {
    return home;
  }
  if (rest.startsWith("/")) {
    return home + rest;
  }
  return p; // "~user" form: not expanded, same as leaving it alone
}

export function siloHome(): string {
  return expandUser(process.env.SILO_HOME || "~/.agent-silo");
}

export function inboxRoot(me: string): string {
  return path.join(siloHome(), me, "inbox");
}

export function threadPath(me: string, correspondent: string): string {
  return path.join(inboxRoot(me), `${correspondent}.md`);
}

/**
 * Non-strict realpath.
 *
 * fs.realpathSync throws ENOENT for a path that does not exist yet, but
 * `inbox reply` resolves the thread path BEFORE creating the file. Python's
 * os.path.realpath resolves as far as it can and leaves the missing tail
 * alone, so replicate that: walk up to the deepest existing ancestor, resolve
 * that, and re-append the tail.
 */
export function realpath(p: string): string {
  const absolute = path.resolve(p);
  try {
    return fs.realpathSync(absolute);
  } catch (e) {
    if (errnoCode(e) !== "ENOENT") {
      throw e;
    }
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) {
    return absolute; // hit the filesystem root without finding anything
  }
  return path.join(realpath(parent), path.basename(absolute));
}

export interface Block {
  ts: string;
  sender: string;
  status: string;
  subject: string;
  body: string;
  header_line: string;
  start: number;
  end: number;
}

/**
 * Parse a thread file into a list of blocks.
 * start/end are character offsets into text.
 *
 * Only a candidate line whose header actually parses may bound a block
 * (protocol section 4). A column-0 "## " line that fails the header grammar
 * is BODY CONTENT of the preceding block, or leading content if no block has
 * begun. Treating every "## " line as a boundary regardless (which is what
 * the Python original did, and what this port did at first) silently
 * truncates a message from any markdown heading its author typed: the bytes
 * on disk are fine, the loss happens on every read. So candidates are
 * validated FIRST, and each block runs to the next VALID header, not to the
 * next header-shaped line.
 */
export function parseBlocks(text: string): Block[] {
  const blocks: Block[] = [];
  const headerStartRe = /^## /gm;
  const valid: {
    start: number;
    headerEnd: number;
    groups: Record<string, string | undefined>;
  }[] = [];
  for (let m = headerStartRe.exec(text); m !== null; m = headerStartRe.exec(text)) {
    const start = m.index;
    let headerEnd = text.indexOf("\n", start);
    if (headerEnd === -1) {
      headerEnd = text.length;
    }
    const hm = HEADER_RE.exec(text.slice(start, headerEnd));
    if (hm && hm.groups) {
      valid.push({ start, headerEnd, groups: hm.groups });
    }
  }
  for (let i = 0; i < valid.length; i += 1) {
    const { start, headerEnd, groups } = valid[i]!;
    const end = i + 1 < valid.length ? valid[i + 1]!.start : text.length;
    const headerLine = text.slice(start, headerEnd);
    const rawBody = text.slice(headerEnd, end);
    blocks.push({
      ts: groups.ts!,
      sender: groups.sender!.trim(),
      status: groups.status!.trim().toLowerCase(),
      subject: groups.subject!.trim(),
      body: cleanBody(rawBody),
      header_line: headerLine,
      start,
      end,
    });
  }
  return blocks;
}

/**
 * Strip leading/trailing blank lines and standalone '---' delimiter lines.
 */
export function cleanBody(raw: string): string {
  const cleaned = raw.split("\n").filter((line) => line.trim() !== "---");
  return cleaned.join("\n").trim();
}

/**
 * Flip status: sent -> read for every block matching predicate(block).
 *
 * Uses a same-length in-place byte patch (4 bytes: "sent" -> "read") so that
 * concurrent appends at EOF are never clobbered and there is no string-replace
 * ambiguity when two headers are identical.
 *
 * Steps:
 * 1. Read the file as text; parse blocks; select those matching the predicate.
 * 2. For each matched block, locate the "sent" token in its header line using a
 *    regex match on the header substring. Compute the token's character index in
 *    the full text, then convert to a UTF-8 byte offset.
 * 3. Open the REAL file in binary read-plus mode ("r+") and overwrite each
 *    located "sent" (4 bytes) with "read" after verifying the bytes are correct.
 * 4. Never truncate or rewrite the whole file.
 *
 * Returns count of blocks actually patched.
 */
export function flipBlocksInFile(
  realPath: string,
  predicate: (block: Block) => boolean,
): number {
  // Hold the lock across the READ and the r+ patch: the byte offsets are computed
  // from `text`, so a concurrent rewrite between read and patch must be excluded
  // (the same lock every other writer takes).
  return withInboxLock(realPath, () => {
    const text = fs.readFileSync(realPath, "utf8");
    const blocks = parseBlocks(text);

    const byteOffsets: number[] = [];
    for (const block of blocks) {
      if (!predicate(block)) {
        continue;
      }
      // Locate the status token by re-running the SAME anchored HEADER_RE and
      // reading its own `status` capture range, NOT a second loose pattern like
      // /status:\s*(sent)/.
      //
      // A loose pattern takes the FIRST match in the line, and `from:` comes
      // BEFORE `status:` in the grammar. A correspondent literally named
      // "status:sentinel" therefore matches inside the FROM field, and
      // verify-before-write does NOT catch it: those 4 bytes genuinely spell
      // "sent", so the check trivially passes. It is the wrong "sent", not a
      // corrupted one. The patch then rewrites the sender to
      // "status:readinel" while leaving the real status at "sent", so the
      // message is corrupted AND stays permanently unread.
      // Deriving the offset from the grammar's own capture group makes that
      // structurally impossible rather than merely unlikely: the offset can
      // only ever be where the anchored status field matched.
      const m = HEADER_RE.exec(block.header_line);
      const statusRange = m?.indices?.groups?.["status"];
      if (!statusRange) {
        // Defensive: parseBlocks matched this same grammar to produce the
        // block at all, so this is unreachable; skip rather than guess.
        continue;
      }
      // char index of the status value within the full text
      const sentCharIdx = block.start + statusRange[0];
      // convert to UTF-8 byte offset (an earlier block's body may hold
      // multi-byte UTF-8, so a char index is NOT a byte index)
      byteOffsets.push(Buffer.byteLength(text.slice(0, sentCharIdx), "utf8"));
    }

    if (byteOffsets.length === 0) {
      return 0;
    }

    let patched = 0;
    const fd = fs.openSync(realPath, "r+");
    try {
      const buf = Buffer.alloc(4);
      const read = Buffer.from("read", "utf8");
      for (const off of byteOffsets) {
        const got = fs.readSync(fd, buf, 0, 4, off);
        if (got !== 4 || buf.toString("utf8") !== "sent") {
          // Safety: bytes not what we expected; skip rather than corrupt.
          continue;
        }
        fs.writeSync(fd, read, 0, 4, off);
        patched += 1;
      }
    } finally {
      fs.closeSync(fd);
    }

    return patched;
  });
}

function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

function isFile(p: string): boolean {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

function exists(p: string): boolean {
  return fs.existsSync(p);
}

function cmdRead(me: string, args: { correspondent?: string }): void {
  const root = inboxRoot(me);
  if (!isDirectory(root)) {
    out("no new messages");
    return;
  }

  let correspondents: string[];
  if (args.correspondent) {
    correspondents = [args.correspondent];
  } else {
    correspondents = fs
      .readdirSync(root)
      .filter((f) => f.endsWith(".md") && isFile(path.join(root, f)))
      .map((f) => f.slice(0, -3));
  }

  let anyPrinted = false;
  for (const corr of [...correspondents].sort()) {
    const p = threadPath(me, corr);
    if (!exists(p)) {
      continue;
    }
    const real = realpath(p);
    const text = fs.readFileSync(real, "utf8");
    const blocks = parseBlocks(text);
    const unread = blocks.filter((b) => b.status === "sent" && b.sender !== me);
    if (unread.length === 0) {
      continue;
    }
    for (const block of unread) {
      out(`from ${block.sender} @ ${block.ts} - ${block.subject}`);
      if (block.body) {
        out(block.body);
      }
      out();
      anyPrinted = true;
    }
    flipBlocksInFile(real, (b) => b.status === "sent" && b.sender !== me);
  }

  if (!anyPrinted) {
    out("no new messages");
  }
}

interface ReplyArgs {
  correspondent: string;
  subject?: string;
  body?: string;
  bodyFile?: string;
}

function cmdReply(me: string, args: ReplyArgs): void {
  const correspondent = args.correspondent;

  let bodyText: string;
  if (args.body) {
    bodyText = args.body;
  } else if (args.bodyFile) {
    // "-" reads the body from stdin (standard Unix idiom), so callers can
    // heredoc a multi-line message straight in -- no scratch temp file.
    // fd 0 rather than a stream: the read must be synchronous, like the rest
    // of this command.
    bodyText =
      args.bodyFile === "-"
        ? fs.readFileSync(0, "utf8")
        : fs.readFileSync(args.bodyFile, "utf8");
  } else {
    err("ERROR: supply --body or --body-file");
    process.exit(1);
  }

  const subject = args.subject ? args.subject : "";

  if (subject.includes(EM_DASH)) {
    err("ERROR: subject contains an em-dash (U+2014). Remove it before sending.");
    process.exit(1);
  }

  if (bodyText.includes(EM_DASH)) {
    err("ERROR: body contains an em-dash (U+2014). Remove it before sending.");
    process.exit(1);
  }

  const ts = new Date().toISOString().slice(0, 19) + "Z";
  const header = `## ${ts} - from: ${me} - status: sent - subject: ${subject}`;
  // Structured "card" metadata (decision-id:/action-id: as first body line)
  // must be flush to the header; a blank separator would empty the metadata
  // region before it starts.
  bodyText = bodyText.replace(/^\n+/, "");
  const isCard =
    bodyText.startsWith("decision-id:") || bodyText.startsWith("action-id:");
  const sep = isCard ? "" : "\n";

  // For card bodies, guarantee the metadata region is terminated by a blank
  // line. A renderer built over these files is expected to define the
  // metadata region as the lines from (header + 1) up to the FIRST blank
  // line. If prose runs straight on from the last metadata key with no
  // preceding blank, the block would render as plain prose and any
  // re-serialiser would lock it there permanently.
  //
  // Rule: scan the leading contiguous metadata run. A metadata line is:
  //   - a top-level YAML key at column 0: ^[a-z][a-z0-9_-]*:
  //   - an indented continuation/list line: ^\s+\S
  // The run ends at the first line that is either blank or a column-0 line
  // that is NOT a top-level key (i.e. prose).
  // If the line immediately after the run is not blank, insert one blank line
  // there so the metadata region is correctly terminated.
  // Pure-metadata bodies (endIdx >= lines.length) need no insertion here;
  // the block construction below adds the trailing blank for isCard.
  // CONSERVATISM: only ever INSERT a single blank; never remove, reorder, or
  // merge lines. Ambiguous detection degrades to "renders as prose" (same as
  // today's worst case), never to corrupted content.
  if (isCard) {
    const TOP_KEY_RE = /^[a-z][a-z0-9_-]*:/;
    const INDENT_RE = /^\s+\S/;
    const lines = bodyText.split("\n");
    // endIdx is either the index of the first blank/prose line, or
    // lines.length when every line is metadata.
    let endIdx = lines.length;
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i]!;
      const isBlank = line.trim() === "";
      const isTopKey = TOP_KEY_RE.test(line);
      const isIndented = INDENT_RE.test(line);
      if (isBlank || (!isTopKey && !isIndented)) {
        // This line is outside the metadata run; stop here.
        endIdx = i;
        break;
      }
    }

    if (endIdx < lines.length) {
      if (lines[endIdx]!.trim() !== "") {
        // Prose line immediately after metadata run -- insert blank.
        lines.splice(endIdx, 0, "");
        bodyText = lines.join("\n");
      }
    }
    // If endIdx >= lines.length: pure metadata; block construction handles it.
  }

  // For isCard bodies, end the block with "\n\n" (guaranteed terminating
  // blank line) rather than relying on a trailing trim which would eat it.
  // For non-card bodies, behaviour is identical to before (trim + "\n").
  const block = isCard
    ? `\n${header}\n${rstrip(bodyText)}\n\n`
    : `\n${header}\n${sep}${rstrip(bodyText)}\n`;

  const p = threadPath(me, correspondent);
  const real = realpath(p);
  // Parent must exist before we create the "<real>.lock" sibling.
  fs.mkdirSync(path.dirname(real), { recursive: true });

  // Lock the create + append as ONE critical section: serialises against a
  // concurrent full-file rewrite from another writer (no orphaned-by-rename
  // loss) AND against a second concurrent reply racing the create (a plain
  // truncating create would wipe the first writer's file).
  withInboxLock(real, () => {
    if (!exists(real)) {
      fs.writeFileSync(real, "", "utf8");
    }
    fs.appendFileSync(real, block, "utf8");
  });

  // flipBlocksInFile takes the same lock internally (own tiny critical section).
  flipBlocksInFile(real, (b) => b.sender === correspondent && b.status === "sent");

  out(`replied to ${correspondent}`);

  // Best-effort LIVE delivery: persist above is the source of truth and
  // always happens; this push is additive over it and NEVER fails the send.
  // It hands off to inbox-push, a separate, out-of-scope-here send path
  // (runtime / idle / clean-composer gates + capture-verify are its concern,
  // not this file's). Reports a status so the sender never has to poll.
  // Receipt flips (read/ack) deliberately do NOT push.
  maybePush(me, correspondent, subject, bodyText);
}

// Python's str.rstrip() with no argument strips all trailing whitespace,
// including newlines. JS trimEnd() is the same set for practical purposes.
function rstrip(s: string): string {
  return s.replace(/\s+$/, "");
}

/**
 * Resolve whether `inbox reply` should fire a live push.
 *
 * INBOX_NO_PUSH=1 is an absolute off (scripted/bulk sends that must stay
 * silent). The default is ON. INBOX_PUSH=0 is the per-send opt-out;
 * INBOX_NO_PUSH=1 remains the hard off for scripted/bulk runs.
 */
export function pushEnabled(): boolean {
  if (process.env.INBOX_NO_PUSH === "1") {
    return false;
  }
  return (process.env.INBOX_PUSH ?? "1") === "1";
}

// ---------------------------------------------------------------------------
// Attachment path rewrite for live pane delivery
// ---------------------------------------------------------------------------
// A message body may carry a markdown image ref like
//   ![x.png](/attachments/2026-07/x.png)
// The URL is a WEB-relative HTTP route that a companion web app serves against
// ATTACHMENTS_ROOT. A browser resolves it over HTTP, but an agent reading the
// raw text pushed into its pane has no HTTP client - it needs a real local
// filesystem path for its file/image-view tool. Rewrite /attachments/<relPath>
// -> <root>/<relPath> for the pushed text ONLY (the inbox record stays
// web-relative, that is what the browser needs). Conservative: only rewrites
// inside an actual ![...](...) image link, never bare prose nor a non-image
// [...](...) link.
export const ATTACHMENT_IMG_RE = /(!\[[^\]]*\]\()\/attachments\/([^)\s]+)/g;

// ---------------------------------------------------------------------------
// POSIX path normalisation for the containment check
// ---------------------------------------------------------------------------
// node:path's posix.join and posix.normalize are NOT drop-in equivalents of
// Python's posixpath, and the difference is security-relevant here:
//   - posixpath.join("/root", "/etc/passwd") == "/etc/passwd" (an absolute
//     second component REPLACES the first), while path.posix.join would give
//     "/root/etc/passwd". A body containing "/attachments//etc/passwd" yields
//     the capture "/etc/passwd", so with node's join the escape would land
//     back INSIDE the root and be accepted as contained, i.e. silently
//     rewritten instead of rejected.
//   - posixpath.normpath strips a trailing slash; path.posix.normalize keeps
//     it, which would change the rewritten text for "/attachments/dir/".
// So both are reimplemented to Python's semantics rather than approximated.
function posixJoin(base: string, part: string): string {
  if (part.startsWith("/")) {
    return part;
  }
  if (base === "" || base.endsWith("/")) {
    return base + part;
  }
  return base + "/" + part;
}

function posixNormpath(p: string): string {
  if (p === "") {
    return ".";
  }
  let initialSlashes = p.startsWith("/") ? 1 : 0;
  // POSIX reserves exactly two leading slashes as implementation-defined;
  // three or more collapse to one. Python preserves that distinction.
  if (p.startsWith("//") && !p.startsWith("///")) {
    initialSlashes = 2;
  }
  const comps: string[] = [];
  for (const comp of p.split("/")) {
    if (comp === "" || comp === ".") {
      continue;
    }
    if (
      comp !== ".." ||
      (initialSlashes === 0 && comps.length === 0) ||
      (comps.length > 0 && comps[comps.length - 1] === "..")
    ) {
      comps.push(comp);
    } else if (comps.length > 0) {
      comps.pop();
    }
  }
  const joined = "/".repeat(initialSlashes) + comps.join("/");
  return joined || ".";
}

/**
 * Resolve ATTACHMENTS_ROOT for the live-push rewrite.
 *
 * Purely env-var driven: reads the ATTACHMENTS_ROOT env var and returns it
 * if set, else null. A caller that gets null degrades to leaving the pane
 * text unchanged, never crashing the push.
 */
export function resolveAttachmentsRoot(): string | null {
  const val = (process.env.ATTACHMENTS_ROOT ?? "").trim();
  return val || null;
}

/**
 * Rewrite web-relative /attachments/ image refs to real fs paths.
 *
 * No-op (returns body unchanged) when attachmentsRoot is falsy or the body
 * carries no matching markdown image link. Handles multiple refs.
 *
 * CONTAINMENT INVARIANT: the rewritten path is guaranteed to stay inside
 * attachmentsRoot. Each match's relPath is resolved against the root and
 * normalised (lexically, no filesystem I/O); a candidate that escapes the
 * root (via ../ traversal or an absolute-looking segment) is REJECTED - that
 * specific match is left COMPLETELY UNCHANGED (its original /attachments/...
 * text is preserved), never rewritten to an escaping fs path. Rejection is
 * per-match, so a traversal attempt does not suppress rewriting of other
 * legitimate refs in the same body. This blocks a crafted body from steering
 * a recipient agent's file/image-view tool at an arbitrary file on disk.
 */
export function rewriteAttachmentPaths(
  body: string,
  attachmentsRoot: string | null | undefined,
): string {
  if (!attachmentsRoot) {
    return body;
  }
  const root = attachmentsRoot.replace(/\/+$/, "");

  return body.replace(ATTACHMENT_IMG_RE, (whole, prefix: string, rel: string) => {
    const candidate = posixNormpath(posixJoin(root, rel));
    // Contained iff the resolved candidate is the root itself or sits under
    // it (trailing "/" kills a sibling-prefix escape like /root-evil).
    if (candidate === root || candidate.startsWith(root + "/")) {
      return `${prefix}${candidate}`;
    }
    return whole;
  });
}

export function maybePush(
  me: string,
  correspondent: string,
  subject: string,
  bodyText: string,
): void {
  if (!pushEnabled()) {
    return;
  }
  // INBOX_PUSH_BIN overrides the send path (test seam; defaults to a path
  // under the silo so it stays configurable rather than assuming a fixed
  // install layout).
  const pushBin =
    process.env.INBOX_PUSH_BIN || path.join(siloHome(), "bin", "inbox-push");
  if (!isFile(pushBin)) {
    return;
  }
  // Single-line notification. Prefixed so the recipient knows it is an inbox
  // DM -> reply via inbox (channel fidelity). Subject if present, else the
  // first non-empty body line.
  // Pane payload. Full-text-to-pane is the default: deliver the actual
  // subject + body to the recipient's composer so they act on it directly,
  // killing the notification -> go-read-inbox -> act round trip.
  //
  // Two cases degrade to a subject-only nudge (the full body is always in
  // the inbox regardless, so nothing is lost):
  //   - over the send-keys cap: a truncated pane dump could drop the
  //     important part, so nudge-to-read rather than deliver a partial
  //     message.
  //   - structured cards (decision-id:/action-id:): metadata for a card
  //     renderer, not pane prose -- a send-keys line would mangle the card.
  const PANE_PAYLOAD_CAP = 1900; // under inbox-push's send-keys ceiling (tunable)
  const note = subject.trim();
  const fulltext = process.env.INBOX_PUSH_FULLTEXT !== "0";
  const lstripped = bodyText.replace(/^\n+/, "");
  const isCard =
    lstripped.startsWith("decision-id:") || lstripped.startsWith("action-id:");
  // Subject nudge (the fallback): subject, else the first non-empty body line.
  const firstNonEmpty =
    bodyText.split("\n").map((ln) => ln.trim()).find((ln) => ln !== "") ?? "";
  const notifNote = note || firstNonEmpty;
  const nudge = `[inbox from ${me}] ${notifNote}`.replace(/\n/g, " ").trim();
  // Pane-only reply hint: the recipient reads the push in their pane and
  // tends to reply in-terminal, so the sender never gets the answer. Ride a
  // short hint that points them back to the inbox thread. Skipped for cards
  // (answered by a UI tap, not `inbox reply`). Its length is reserved
  // against the cap so full+hint never exceeds the send-keys ceiling.
  // Pane-only: the inbox record is unchanged.
  const replyHint = isCard ? "" : `  [reply via inbox: inbox reply ${me}]`;
  let msg: string;
  if (fulltext && !isCard) {
    // Collapse ALL whitespace/newlines to single spaces: a raw newline in
    // a terminal-paste-style push would inject a mid-message Enter and
    // submit the partial line early. The full body always lives in the
    // inbox as the record.
    let flatBody = bodyText.split(/\s+/).filter((s) => s !== "").join(" ");
    // Rewrite web-relative /attachments/ image refs to real fs paths so the
    // recipient's file/image-view tool can open them. Applied BEFORE the
    // PANE_PAYLOAD_CAP check below (the absolute path is longer than the
    // URL, so it must be counted against the cap). Degrades to unchanged
    // text if ATTACHMENTS_ROOT cannot be resolved - never crashes the push.
    flatBody = rewriteAttachmentPaths(flatBody, resolveAttachmentsRoot());
    const parts = [note, flatBody].filter((p) => p);
    const full = `[inbox from ${me}] ` + parts.join(" | ");
    if (full.length <= PANE_PAYLOAD_CAP - replyHint.length) {
      msg = full;
    } else {
      // OVER THE CAP: say so explicitly rather than sending a bare
      // subject. The plain `nudge` is indistinguishable from a
      // genuinely SHORT message whose body just is that line, because
      // notifNote falls back to the first body line when there is no
      // subject. So the recipient could not tell "that is all they
      // wrote" from "there is more" -- a real ambiguity, worth naming
      // explicitly rather than leaving silent.
      //
      // Report the length of the STORED body, which is what `inbox
      // read` will show them, NOT the flattened/rewritten pane text: a
      // count that does not reconcile with the file teaches the reader
      // to distrust the mechanism.
      //
      // State exactly which characters the number counts, because a
      // precise number invites re-measurement and a mismatch reads as a
      // bug:
      //   - Unicode CODE POINTS of the stored body, hence the spread into
      //     an array rather than String.length. String.length counts UTF-16
      //     code units, which is one MORE than the code-point count for
      //     every non-BMP character (most emoji). Code points is the
      //     reference definition for this protocol; any companion app that
      //     reports a count for the same text must count the same way
      //     rather than compute independently and silently drift.
      //   - INCLUDES a trailing newline if the stored body has one.
      //     That newline is invisible on screen, so counting only the
      //     characters you can SEE gives one less. No single number
      //     satisfies both "characters stored" and "characters a human
      //     counts on screen"; this is the former.
      //   - EXCLUDES the subject, the "[inbox from x]" prefix and the
      //     hint.
      const flatNote = note.split(/\s+/).filter((s) => s !== "").join(" ");
      const codePointLength = [...bodyText].length;
      const marker =
        `MESSAGE TOO LONG TO DELIVER IN FULL (${codePointLength} chars).` +
        ` Full text: inbox read ${me}`;
      msg = flatNote
        ? `[inbox from ${me}] ${flatNote} | ${marker}`
        : `[inbox from ${me}] ${marker}`;
      if (msg.length > PANE_PAYLOAD_CAP - replyHint.length) {
        // Never sacrifice the marker to keep a long subject. The
        // subject is a label; the marker is the thing preventing
        // silent loss.
        msg = `[inbox from ${me}] ${marker}`;
      }
    }
  } else {
    msg = nudge;
  }
  msg = msg + replyHint;
  try {
    const env = { ...process.env, AGENT_NAME: me };
    // spawnSync reports a failed spawn / timeout through result.error rather
    // than throwing (Python's subprocess.run raises), so check it explicitly
    // and route it down the same "never fail the send" path.
    const result = spawnSync(pushBin, [correspondent, msg], {
      encoding: "utf8",
      timeout: 15000,
      env,
    });
    if (result.error) {
      throw result.error;
    }
    const stdout = (result.stdout || "").trim();
    const lines = stdout.split("\n");
    const verdict = stdout ? lines[lines.length - 1]! : "";
    if (result.status === 0) {
      out(`  push: ${verdict || "pushed"}`);
    } else {
      out(`  push: ${verdict || "skip"} (persisted, not pushed)`);
    }
  } catch {
    // A push failure must never fail the send -- the block is already persisted.
    out("  push: skip:error (persisted, not pushed)");
  }
}

function cmdAck(me: string, args: { correspondent: string }): void {
  const correspondent = args.correspondent;
  const p = threadPath(me, correspondent);
  if (!exists(p)) {
    out(`no thread with ${correspondent}`);
    return;
  }
  const real = realpath(p);
  const flipped = flipBlocksInFile(
    real,
    (b) => b.sender === correspondent && b.status === "sent",
  );
  if (flipped === 0) {
    out(`nothing to ack from ${correspondent}`);
  } else {
    out(`acked ${flipped} block(s) from ${correspondent}`);
  }
}

function cmdUnread(me: string): void {
  const root = inboxRoot(me);
  if (!isDirectory(root)) {
    out("no unread");
    return;
  }

  let found = false;
  for (const fname of fs.readdirSync(root).sort()) {
    if (!fname.endsWith(".md")) {
      continue;
    }
    const corr = fname.slice(0, -3);
    const p = path.join(root, fname);
    if (!isFile(p)) {
      continue;
    }
    const real = realpath(p);
    const text = fs.readFileSync(real, "utf8");
    const blocks = parseBlocks(text);
    const count = blocks.filter((b) => b.status === "sent" && b.sender !== me).length;
    if (count > 0) {
      out(`${corr}: ${count} unread`);
      found = true;
    }
  }

  if (!found) {
    out("no unread");
  }
}

const USAGE = `usage: inbox [-h] {read,reply,ack,unread} ...

Agent inbox helper

positional arguments:
  {read,reply,ack,unread}
    read                Print and ack unread blocks
    reply               Append a block to a thread
    ack                 Flip-only read receipt
    unread              List correspondents with unread counts

options:
  -h, --help            show this help message and exit`;

export function main(argv: string[] = process.argv.slice(2)): void {
  const me = agentName();

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === "-h" || command === "--help") {
    out(USAGE);
    return;
  }

  // node:util's parseArgs replaces argparse. It has no subcommand support, so
  // the subcommand is peeled off first and each command declares only its own
  // options. strict:true keeps argparse's reject-unknown-flags behaviour;
  // argparse exits 2 on a usage error, so match that code.
  type OptionSpec = Record<string, { type: "string"; default?: string }>;
  const parse = (
    options: OptionSpec,
    expectedPositionals: number,
  ): { values: Record<string, string | undefined>; positionals: string[] } => {
    try {
      const { values, positionals } = parseArgs({
        args: rest,
        options,
        allowPositionals: true,
        strict: true,
      });
      if (positionals.length > expectedPositionals) {
        throw new Error(
          `unrecognized arguments: ${positionals.slice(expectedPositionals).join(" ")}`,
        );
      }
      return {
        values: values as Record<string, string | undefined>,
        positionals,
      };
    } catch (e) {
      err(USAGE);
      err(`inbox ${command}: error: ${e instanceof Error ? e.message : String(e)}`);
      process.exit(2);
    }
  };

  if (command === "read") {
    const { positionals } = parse({}, 1);
    cmdRead(me, { correspondent: positionals[0] });
  } else if (command === "reply") {
    const { values, positionals } = parse(
      {
        subject: { type: "string", default: "" },
        body: { type: "string" },
        "body-file": { type: "string" },
      },
      1,
    );
    if (positionals.length < 1) {
      err(USAGE);
      err("inbox reply: error: the following arguments are required: correspondent");
      process.exit(2);
    }
    cmdReply(me, {
      correspondent: positionals[0]!,
      subject: values.subject,
      body: values.body,
      bodyFile: values["body-file"],
    });
  } else if (command === "ack") {
    const { positionals } = parse({}, 1);
    if (positionals.length < 1) {
      err(USAGE);
      err("inbox ack: error: the following arguments are required: correspondent");
      process.exit(2);
    }
    cmdAck(me, { correspondent: positionals[0]! });
  } else if (command === "unread") {
    parse({}, 0);
    cmdUnread(me);
  } else {
    out(USAGE);
    process.exit(1);
  }
}

// Python's `if __name__ == "__main__"`. realpath on both sides so that a
// symlink on PATH pointing at this file (the recommended way to install it
// under the bare name `inbox`) still counts as a direct invocation.
function invokedDirectly(): boolean {
  const entry = process.argv[1];
  if (!entry) {
    return false;
  }
  try {
    return fs.realpathSync(entry) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main();
}
