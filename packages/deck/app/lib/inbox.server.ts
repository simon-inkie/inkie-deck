/**
 * inbox.server.ts
 *
 * Data-access seam for the inbox.
 *
 * Exports:
 *   InboxRepository - the interface all routes/loaders consume
 *   FileInboxRepository - the file-backed implementation
 *     reads via the pure parser (splitBlocks + parseBlock)
 *     writes only through the safe-fs guard (assertSafeWritePath / atomicWrite)
 *
 * The .server suffix strips this module from the client bundle (RR7 guarantee).
 * No route or component may import fs or a literal inbox path directly.
 *
 * Security: every write goes through assertSafeWritePath - see safe-fs.server.ts.
 *
 * The wedge fix (parse-window-only, stat-gated
 * caches, byte-patch flip) is described below. Also see test/inbox-task700.test.ts for the full
 * edge-case coverage (byte-patch offsets, LRU eviction, fast-skip behaviour).
 */

import fs from "node:fs";
import path from "node:path";
import {
  splitBlocks,
  isBlockHeaderLine,
  parseBlock,
  parseHeader,
  HEADER_RE,
  serializeBlock,
  applyAnswer,
  applyCustomAnswer,
  applyPushBack,
  applyDone,
  applyDismiss,
  applyDoneNote,
  applyDismissDecision,
  applySupersedeAction,
  applySupersedeDecision,
} from "./blocks/index.js";
import type {
  MessageBlock,
  AnswerResult,
  CustomAnswerResult,
  PushBackResult,
  DoneResult,
  DismissResult,
  DoneNoteResult,
  DismissDecisionResult,
  SupersedeActionResult,
  SupersedeDecisionResult,
} from "./blocks/index.js";
import {
  resolveInboxRoot,
  assertSafeWritePath,
  atomicWrite,
  withInboxLock,
  getInboxAgentAllowlist,
  AGENT_NAME_RE,
} from "./safe-fs.server.js";

export type {
  MessageBlock,
  AnswerResult,
  CustomAnswerResult,
  PushBackResult,
  DoneResult,
  DismissResult,
  DoneNoteResult,
  DismissDecisionResult,
  SupersedeActionResult,
  SupersedeDecisionResult,
};

// ---------------------------------------------------------------------------
// Windowed-read types
// ---------------------------------------------------------------------------

/** Default window size for the thread view's chunked lazy-load. */
export const DEFAULT_WINDOW_LIMIT = 30;

/**
 * Options for readBlocksWindow.
 *
 * The cursor is the ABSOLUTE block index in the full thread. Inbox files are
 * append-only at block granularity (answers/receipts rewrite blocks in place;
 * nothing is inserted or deleted mid-file), so index n names the same block
 * across requests - safe as both pagination cursor and client ordering key.
 */
export interface BlockWindowOptions {
  /** Maximum number of blocks to return. Default DEFAULT_WINDOW_LIMIT. */
  limit?: number;
  /**
   * Exclusive upper bound (load-older): return the `limit` blocks whose
   * absolute index is < before. Takes precedence over anchorId.
   */
  before?: number;
  /**
   * Deep-link focus: a stable card id (decision-id or action-id). When the
   * matching block sits BEFORE the default tail window, the window extends
   * back to include it (target through to the thread end). Unknown ids fall
   * back to the plain tail window.
   */
  anchorId?: string;
}

/** Result of a windowed read. */
export interface BlockWindow {
  /** The blocks in the window, in file order. */
  blocks: MessageBlock[];
  /** Absolute index of blocks[0] in the full thread. 0 = thread start. */
  startIndex: number;
  /** Total number of blocks in the thread file. */
  totalCount: number;
}

// ---------------------------------------------------------------------------
// Module-level caches, cheap header scan, byte-patch flip.
//
// makeStores() builds a FRESH FileInboxRepository per request, so any cache
// that must survive across the 3s poll has to live at MODULE scope, not on the
// instance. Mirrors the mtime/size-guarded Map pattern shipped in
// file-description.server.ts (loadCache) - same shape, same test seams.
//
// The main problem: opening a 3.6MB / 4029-block thread paid a full parse of
// EVERY block TWICE per poll (readBlocksWindow's readBlocks + markRead's own
// splitBlocks+parseBlock), synchronously blocking Node's event loop every 3s.
// These caches + the parse-window-only read + the markRead fast-skip collapse
// the steady-state poll to zero re-read, zero re-parse, zero write.
// ---------------------------------------------------------------------------

/** Parsed render-window cache entry, guarded by the file's (mtimeMs, size). */
interface WindowCacheEntry {
  mtimeMs: number;
  size: number;
  window: BlockWindow;
}

/**
 * (resolved file path + serialized options) -> last parsed window.
 *
 * Bounded LRU: each distinct `before`
 * scroll-cursor is its own cache key, so unbounded scroll-back on a large
 * thread would otherwise grow this Map for the life of the process. Capped at
 * WINDOW_MEMO_MAX_ENTRIES; a `get` bumps the entry to most-recently-used (Map
 * preserves insertion order, so delete+re-set moves it to the end), and a
 * `set` past the cap evicts the single oldest (first) entry before inserting.
 */
const windowMemo = new Map<string, WindowCacheEntry>();
/** Cap on windowMemo entries. Comfortably above realistic concurrent scroll
 * positions for one ops user across MC's threads, while still bounding
 * process memory growth over a long server lifetime. */
const WINDOW_MEMO_MAX_ENTRIES = 200;

/** Read a windowMemo entry and bump it to most-recently-used, or undefined on a miss. */
function windowMemoGet(key: string): WindowCacheEntry | undefined {
  const entry = windowMemo.get(key);
  if (entry === undefined) return undefined;
  windowMemo.delete(key);
  windowMemo.set(key, entry);
  return entry;
}

/** Insert a windowMemo entry, evicting the single oldest entry if over the cap. */
function windowMemoSet(key: string, entry: WindowCacheEntry): void {
  windowMemo.delete(key); // re-inserting an existing key must also bump it
  if (windowMemo.size >= WINDOW_MEMO_MAX_ENTRIES) {
    const oldest = windowMemo.keys().next().value;
    if (oldest !== undefined) windowMemo.delete(oldest);
  }
  windowMemo.set(key, entry);
}

/**
 * markRead fast-skip memo. Distinct semantics from windowMemo: it does NOT
 * cache parsed output, it only records the (mtimeMs, size) this process last
 * saw settled for a file, so an unchanged file skips the lock+scan entirely.
 * The value stored is always the stat AFTER our own write, so our own flip does
 * not make the very next poll think there is new content to rescan.
 */
const markReadMemo = new Map<string, { mtimeMs: number; size: number }>();

// ---------------------------------------------------------------------------
// readBlocks whole-file cache
//
// The sibling problem to the windowed thread read, on the OTHER call path.
// shell.tsx is the LAYOUT route wrapping every page; its loader calls
// readBlocks for EVERY agent on EVERY navigation and every 3s live-poll tick,
// so an ~11MB corpus was fully read and fully parsed each time. Measured on the operator's instance: 420ms
// click-to-content even for an 18KB thread, because the cost is the fixed
// whole-corpus scan, not the target agent's own file.
//
// This is NOT windowable the same way: hasUnhandled / hasUnread / the bell's
// allEntries are all "is there ANY such block ANYWHERE in the full history",
// which genuinely needs the whole file. So the fix is not "read less of the
// file", it is "do not re-read and re-parse the WHOLE file when it has not
// changed" - the mtime/size-guarded shape from file-description.server.ts
// (loadCache) and file-manifest-cache.server.ts, third use of the same pattern.
//
// Correctness-preserving, not a staleness tradeoff: every call still stats the
// file, so an out-of-process writer (the inbox CLI, the other MC) is caught by
// the (mtimeMs, size) guard. In-process writers do not LEAN on that guard at
// all - every writer in this module invalidates the file's cached parses
// explicitly after its write. See invalidateParsedCaches below.
// ---------------------------------------------------------------------------

/** Parsed whole-file cache entry, guarded by the file's (mtimeMs, size). */
interface BlocksCacheEntry {
  mtimeMs: number;
  size: number;
  blocks: readonly MessageBlock[];
}

/**
 * The single frozen empty list every "no thread file" return shares.
 *
 * readBlocks must return a frozen array on EVERY path, not only the memoised
 * one - a caller that behaves differently depending on whether it happened to
 * hit the cache is worse than one that is uniformly unenforced. The missing-file
 * paths have nothing to parse, so they share this constant rather than minting
 * (and freezing) a new empty array per call.
 */
const EMPTY_BLOCKS: readonly MessageBlock[] = Object.freeze([]);

/**
 * resolved file path -> last fully-parsed block list.
 *
 * DELIBERATELY UNBOUNDED (no LRU), unlike windowMemo. windowMemo needed a cap
 * because its key embeds the `before`
 * scroll cursor, so scroll-back mints unbounded distinct keys. readBlocks takes
 * NO options, so the key space here is exactly (agents x participant files) -
 * a few dozen entries on any real instance, fixed for the life of the process.
 * Stated as an explicit assumption: if a deployment ever grows an unbounded
 * number of inbox files, revisit; do not pre-emptively copy windowMemo's
 * LRU bookkeeping for a key space that cannot grow.
 *
 * ALIASING: the cached array is returned BY REFERENCE (same as windowMemo's
 * BlockWindow), so a mutating caller would corrupt every subsequent cache hit
 * for that file. That is ENFORCED, not just documented: readBlocks
 * Object.freeze()s the parsed list before it is memoised
 * and returns that same frozen reference, so an in-place .sort()/.reverse()/
 * .push() throws at the call site instead of silently poisoning the cache. The
 * declared return type is `readonly MessageBlock[]` so the same mistake is a
 * compile error too. All six call sites already comply - they iterate, .some(),
 * .map(), or copy first (threads.$agent.tsx spreads before .reverse()).
 *
 * The freeze is SHALLOW: it pins the array (the aliasing hazard), not each
 * MessageBlock's own fields. Deep-freezing every block on a 4029-block parse
 * would tax the exact path this cache exists to make cheap.
 */
const blocksMemo = new Map<string, BlocksCacheEntry>();

/**
 * Per-file invalidation epoch, bumped by invalidateParsedCaches.
 *
 * Closes a real write-during-read race on the hot path, not a theoretical one:
 * threads.$agent.tsx's loader calls markRead while shell.tsx - its PARENT
 * layout loader, which React Router runs CONCURRENTLY - is mid-readBlocks over
 * all 13 agents. So on every single thread click, a readBlocks can stat the
 * file pre-flip, await its read, and only reach the `set` AFTER markRead has
 * already patched the bytes and invalidated. Without an epoch that late `set`
 * re-installs pre-flip content over the invalidation, and the stat guard is
 * then the only defence left - which is exactly the defence markRead's
 * same-length patch is known to defeat. A read that spans a bump refuses to
 * cache its now-possibly-stale result (it still RETURNS it - the caller asked
 * for a snapshot and gets a real one - it just never becomes the memo).
 */
const blocksEpoch = new Map<string, number>();

/** Test seam: individual parseBlock calls on the readBlocksWindow path. */
let windowBlocksParsed = 0;
/** Test seam: disk read+split runs on the readBlocksWindow path. */
let windowReadCount = 0;
/** Test seam: markRead runs that fell through to the full lock+scan (no skip). */
let markReadScanCount = 0;
/** Test seam: disk read+parse runs on the readBlocks (whole-file) path. */
let blocksReadCount = 0;
/** Test seam: individual parseBlock calls on the readBlocks (whole-file) path. */
let blocksParsed = 0;

/** Test hook: clear all inbox caches + counters between tests. */
export function __resetInboxCaches(): void {
  windowMemo.clear();
  markReadMemo.clear();
  blocksMemo.clear();
  blocksEpoch.clear();
  windowBlocksParsed = 0;
  windowReadCount = 0;
  markReadScanCount = 0;
  blocksReadCount = 0;
  blocksParsed = 0;
}

/** Test hook: total parseBlock calls on the window read path since last reset. */
export function __windowBlocksParsed(): number {
  return windowBlocksParsed;
}

/** Test hook: total disk reads on the window read path since last reset. */
export function __windowReadCount(): number {
  return windowReadCount;
}

/** Test hook: total markRead full-scan runs (non-skips) since last reset. */
export function __markReadScanCount(): number {
  return markReadScanCount;
}

/** Test hook: total disk reads on the readBlocks whole-file path since last reset. */
export function __blocksReadCount(): number {
  return blocksReadCount;
}

/** Test hook: total parseBlock calls on the readBlocks whole-file path since last reset. */
export function __blocksParsed(): number {
  return blocksParsed;
}

/** The 4 bytes markRead's byte-patch verifies before overwriting with "read". */
const SENT_BYTES = Buffer.from("sent", "utf8");
/** The 4 replacement bytes. Same length as SENT_BYTES (in-place, no shift). */
const READ_BYTES = Buffer.from("read", "utf8");

/**
 * HEADER_RE, re-instantiated with the "d" (hasIndices) flag so a match exposes
 * the exact char range of each named capture. Locating the "sent" token's
 * offset via THIS anchored grammar (rather than a second, looser pattern that
 * re-searches the raw line text) makes it structurally impossible to land
 * inside "from" or "subject": the offset can only ever be where the anchored
 * status CAPTURE GROUP matched. Same source as parseHeader, so it can never
 * disagree with what parseHeader already decided.
 */
const HEADER_RE_INDEXED = new RegExp(HEADER_RE.source, HEADER_RE.flags + "d");

/**
 * Drop EVERY cached parse of a file - both the render windows (windowMemo) and
 * the whole-file block list (blocksMemo). markRead's flip is a SAME-LENGTH byte
 * patch, so the file size never changes and (on a coarse-mtime filesystem) the
 * mtime bump can land within the same tick a cache last read - a stat-guarded
 * cache would then wrongly keep serving the pre-flip content, i.e. a magenta
 * unread dot on a thread the operator has already read. markRead ties the caches to
 * its write: after it patches a file, it explicitly invalidates that file here.
 *
 * EVERY writer in this module calls this, not just markRead.
 * The earlier version of this comment claimed the atomicWrite mutators
 * "change the size and/or land a fresh inode mtime, so the stat guard
 * invalidates those without help" - that was an assumption, not a guarantee. A
 * card-state rewrite can be exactly the same length (a status token swapped for
 * an equal-length one, a note replaced by an equal-length note), and rename(2)
 * lands an mtime that can fall inside the SAME millisecond as the stat a
 * concurrent reader just took, on a filesystem whose mtime granularity is
 * coarser than the gap. Both together are rare; neither is impossible, and the
 * cost of being wrong is a silently stale sidebar. So no writer relies on the
 * stat guard alone: every atomicWrite in FileInboxRepository is followed by an
 * invalidateParsedCaches call for the file it wrote, inside the same lock.
 *
 * ONE function drops BOTH deliberately. Two sibling caches over the same bytes,
 * invalidated from two separate call sites, is a standing invitation for a
 * future write path to remember one and forget the other; this way there is no
 * way to drop the window cache without also dropping the block cache.
 */
function invalidateParsedCaches(filePath: string): void {
  // Separator MUST match readBlocksWindow's cacheKey (filePath + "\u0000" + ...).
  // NUL can never appear in a filesystem path, so it is an unambiguous delimiter.
  const prefix = filePath + "\u0000";
  for (const key of windowMemo.keys()) {
    if (key.startsWith(prefix)) windowMemo.delete(key);
  }
  // blocksMemo is keyed by filePath ALONE (readBlocks takes no options), so no
  // prefix scan is needed - a plain delete is the whole invalidation.
  blocksMemo.delete(filePath);
  // Bump the epoch so a readBlocks already in flight over this file cannot
  // re-install its pre-write parse on top of this delete. See blocksEpoch.
  blocksEpoch.set(filePath, (blocksEpoch.get(filePath) ?? 0) + 1);
}

/** A block's header line and the char offset of its start within the raw file. */
interface BlockHeaderRef {
  /** Char offset (into raw) of the first character of the block's header line. */
  charStart: number;
  /** The verbatim header line ("## ... - status: ... - subject: ...") */
  headerLine: string;
}

/**
 * Cheap block-boundary scan: locate every block header line and its char offset
 * in the raw file, WITHOUT a full parseBlock (no YAML, no zod, no body work).
 *
 * Boundary detection calls the SAME predicate splitBlocks does, rather than
 * restating it, so the block SET is identical to what splitBlocks/parseBlock
 * would produce and cannot drift from it. It was a restatement once, and the
 * boundary rule then changed underneath it (only a line
 * that PARSES as a header may bound a block); the flip set here was unaffected
 * because every caller below already discards a header parseHeader rejects, but
 * a copy of a rule is a copy that goes stale. A block's header line is its first
 * line, which is also the line parseBlock resolves the header from on any
 * canonical file - so parseHeader over these lines yields the SAME from/status
 * the full parse would (from/status depend only on parseHeader, never on the
 * card/body stages). This is the "cheap raw-text scan within block boundaries"
 * markRead uses to find unread blocks without parsing all 4029 of them.
 */
function scanBlockHeaders(raw: string): BlockHeaderRef[] {
  const lines = raw.split("\n");
  const out: BlockHeaderRef[] = [];
  let charStart = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (isBlockHeaderLine(line)) {
      out.push({ charStart, headerLine: line });
    }
    // +1 for the "\n" that split consumed between this line and the next.
    charStart += line.length + 1;
  }
  return out;
}

/**
 * Compute a render window from raw file content, parsing ONLY the blocks the
 * window actually needs.
 *
 * splitBlocks is a cheap line-scan (block boundary detection, no YAML/zod), so
 * getting totalCount + the raw slice for the window is O(file) but avoids the
 * per-block parseBlock cost of the whole thread. Only the window's raw slice is
 * parseBlock'd. The anchorId deep-link is the one exception: it is a rare,
 * user-driven path (clicking a link to a specific message), so it keeps the
 * wider full-parse scan - the FIX is scoped to the hot tail-window case the 3s
 * poll and the initial open exercise.
 */
function computeWindow(raw: string, options: BlockWindowOptions): BlockWindow {
  const rawBlocks = splitBlocks(raw);
  const totalCount = rawBlocks.length;
  const rawLimit = options.limit ?? DEFAULT_WINDOW_LIMIT;
  // Clamp a hostile/garbage limit to something sane (>= 1).
  const limit = Number.isFinite(rawLimit)
    ? Math.max(1, Math.floor(rawLimit))
    : DEFAULT_WINDOW_LIMIT;

  const parseSlice = (start: number, end: number): MessageBlock[] => {
    const slice = rawBlocks.slice(start, end);
    windowBlocksParsed += slice.length;
    return slice.map((rb) => parseBlock(rb));
  };

  if (options.before !== undefined) {
    // Load-older: the `limit` blocks ending just before the cursor.
    const end = Math.min(Math.max(0, Math.floor(options.before)), totalCount);
    const start = Math.max(0, end - limit);
    return { blocks: parseSlice(start, end), startIndex: start, totalCount };
  }

  // Deep-link focus (rarer, user-driven): keep the wider full scan so the
  // anchored card can be found anywhere in the thread. Parse all, find, slice.
  if (options.anchorId !== undefined && options.anchorId !== "") {
    windowBlocksParsed += rawBlocks.length;
    const all = rawBlocks.map((rb) => parseBlock(rb));
    let start = Math.max(0, totalCount - limit);
    const anchorIndex = all.findIndex(
      (b) =>
        b.card?.decisionId === options.anchorId ||
        b.actionCard?.actionId === options.anchorId,
    );
    if (anchorIndex !== -1 && anchorIndex < start) start = anchorIndex;
    return { blocks: all.slice(start), startIndex: start, totalCount };
  }

  // Default: the thread tail - parse ONLY the last `limit` blocks.
  const start = Math.max(0, totalCount - limit);
  return { blocks: parseSlice(start, totalCount), startIndex: start, totalCount };
}

// ---------------------------------------------------------------------------
// InboxRepository interface
// ---------------------------------------------------------------------------

/**
 * The single interface all consumers of inbox data must use.
 * Routes and loaders import this type and receive an instance from makeStores().
 * They NEVER import fs or construct a FileInboxRepository directly.
 */
export interface InboxRepository {
  /**
   * List the agent names that have inboxes readable by this participant.
   * Returns agent directory names found under the inbox root.
   */
  listAgents(): Promise<string[]>;

  /**
   * Read all message blocks from an inbox file.
   *
   * READ-ONLY RESULT: the file-backed implementation serves this from a
   * module-level cache and returns the cached array BY REFERENCE, so the list
   * is frozen (and typed `readonly`) - mutating it in place would corrupt every
   * later reader of that thread. Copy first (`[...blocks]`) to sort/reverse.
   *
   * @param agentName - The agent whose inbox to read (e.g. "scribe")
   * @param participantName - The participant file to read (e.g. "alex")
   * @returns Frozen array of parsed MessageBlocks (empty if file does not exist)
   */
  readBlocks(
    agentName: string,
    participantName: string,
  ): Promise<readonly MessageBlock[]>;

  /**
   * Read a WINDOW of message blocks from an inbox file.
   *
   * Used by the thread view's chunked lazy-load. The full readBlocks stays
   * the contract for whole-thread consumers (home/shell queue derivation -
   * that full read is how out-of-window cards surface in Needs-You).
   *
   * Window selection (see BlockWindowOptions):
   * - default: the last `limit` blocks (the thread tail).
   * - before: the `limit` blocks ending just before that absolute index.
   * - anchorId: the tail window, extended back to include the block whose
   *   card/action id matches (deep-link focus).
   *
   * Implementation note: only the blocks in the window are parsed.
   * splitBlocks is a cheap line-scan for boundaries + totalCount; parseBlock
   * runs on the window slice ONLY. The result is served from a module-level
   * (mtimeMs, size)-guarded cache, so a steady 3s poll on a large thread pays
   * zero re-read and zero re-parse. The anchorId deep-link keeps the wider
   * full scan (rare, user-driven).
   *
   * @param agentName - The agent whose inbox to read
   * @param participantName - The participant file to read (e.g. mcUser(env))
   * @param options - Window selection (limit / before / anchorId)
   * @returns BlockWindow (empty window with totalCount 0 if file missing)
   */
  readBlocksWindow(
    agentName: string,
    participantName: string,
    options?: BlockWindowOptions,
  ): Promise<BlockWindow>;

  /**
   * Stat an inbox file for cache validation (file-manifest panel perf).
   *
   * Returns the file's mtimeMs + size, or null when the file does not exist.
   * This is a metadata-only probe: it does NOT read or parse the thread, so
   * the file-manifest route can call it on every panel open to decide whether
   * its cached manifest is still valid without paying the whole-thread parse.
   * Deliberately separate from readBlocks / readBlocksWindow so the live chat
   * thread read path stays untouched.
   *
   * @param agentName - The agent whose inbox file to stat
   * @param participantName - The participant file to stat (e.g. mcUser(env))
   * @returns { mtimeMs, size } or null when the file is absent
   */
  statInbox(
    agentName: string,
    participantName: string,
  ): Promise<{ mtimeMs: number; size: number } | null>;

  /**
   * Write a reply block to an inbox file.
   * The write is guarded by assertSafeWritePath - no raw fs access.
   *
   * Appends the serialized reply block to the end of the inbox file.
   *
   * @param agentName - The agent whose inbox to write to
   * @param participantName - The participant file to write to
   * @param replyBlock - The new MessageBlock to append
   */
  writeReply(
    agentName: string,
    participantName: string,
    replyBlock: MessageBlock,
  ): Promise<void>;

  /**
   * The SYSTEM.md read receipt: flip status:sent ->
   * status:read on blocks NOT authored by the thread's participant. The
   * participant rendering the thread IS the read - MC renders for the operator, so
   * the loader calls this with the operator's participant name before reading.
   *
   * Scope: no symmetric flip - the participant's own
   * blocks are never touched here. "working" and "read" statuses untouched.
   * Idempotent: when nothing needs flipping, no disk write happens at all.
   *
   * @returns The number of blocks flipped (0 = no write occurred)
   */
  markRead(agentName: string, participantName: string): Promise<number>;

  /**
   * Apply an answer to a decision card in an inbox file.
   * Flips the original card to "answered: <key>" state and appends a reply block.
   * Idempotent: if the card is already answered, returns the existing answer without
   * writing anything.
   *
   * Targets the card by stable decision-id, not by positional block index,
   * so a stale or double-tap view stays an idempotent no-op on the SAME card.
   *
   * @param agentName - The agent whose inbox file to update
   * @param participantName - The participant file to update
   * @param decisionId - The stable decision-id of the target card (e.g. "PROJ-123-q1")
   * @param answerKey - The answer key (e.g. "A" or "B")
   * @returns The AnswerResult from applyAnswer
   */
  answerCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    answerKey: string,
  ): Promise<AnswerResult>;

  /**
   * Apply a user-authored custom answer to a decision card in an inbox file.
   * Appends "answered: custom" and "custom-answer: <json>" to the card's rawMeta, and writes
   * a reply block carrying the user text. Idempotent: if the card is already resolved,
   * returns the existing answer without writing anything.
   *
   * @param agentName - The agent whose inbox file to update
   * @param participantName - The participant file to update
   * @param decisionId - The stable decision-id of the target card (e.g. "PROJ-123-q1")
   * @param text - The user-authored answer text
   * @returns The CustomAnswerResult from applyCustomAnswer
   */
  customAnswerCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    text: string,
  ): Promise<CustomAnswerResult>;

  /**
   * Apply a push-back to a decision card in an inbox file.
   * Flips the original card to "answered: pushback" state and appends a distinct
   * push-back reply block. Idempotent: if the card is already resolved (answered or
   * pushed back), returns the existing state without writing anything.
   *
   * Push-back is a distinct third outcome from answer options.
   * Targets by stable decision-id; idempotent no-op on a resolved card.
   *
   * @param agentName - The agent whose inbox file to update
   * @param participantName - The participant file to update
   * @param decisionId - The stable decision-id of the target card (e.g. "PROJ-123-q1")
   * @param note - Optional push-back note to include as the reply body
   * @returns The PushBackResult from applyPushBack
   */
  pushBackCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    note?: string,
  ): Promise<PushBackResult>;

  /**
   * Mark an action card as done in an inbox file.
   * Appends "done: <ISO>" to the action card's rawMeta via targeted line edit.
   * Idempotent: if the action is already marked done, returns the existing
   * done timestamp without writing anything.
   *
   * Targets the action by stable action-id, not positional block index.
   *
   * @param agentName - The agent whose inbox file to update
   * @param participantName - The participant file to update
   * @param actionId - The stable action-id of the target action card
   * @returns The DoneResult from applyDone
   */
  markActionDone(
    agentName: string,
    participantName: string,
    actionId: string,
  ): Promise<DoneResult>;

  /**
   * Dismiss an action card in an inbox file.
   * Appends "dismissed: <ISO>" (and optionally "dismiss-reason: <json>") to the
   * action card's rawMeta. Emits a dismissed-reply block.
   * Idempotent: if already dismissed, returns alreadyDismissed.
   * Mutual exclusion: if done, returns alreadyDone (no write).
   *
   * @param agentName - The agent whose inbox file to update
   * @param participantName - The participant file to update
   * @param actionId - The stable action-id of the target action card
   * @param reason - Optional dismiss reason (plain string)
   * @returns The DismissResult from applyDismiss
   */
  markActionDismissed(
    agentName: string,
    participantName: string,
    actionId: string,
    reason?: string,
  ): Promise<DismissResult>;

  /**
   * Add a note to an already-done action card in an inbox file.
   * Appends "done-note: <json>" to the action card's rawMeta. Emits a done-note reply block.
   * Idempotent: if done-note already present, returns alreadyNoted.
   * Requires done: to be present; returns notDone if absent.
   *
   * @param agentName - The agent whose inbox file to update
   * @param participantName - The participant file to update
   * @param actionId - The stable action-id of the target action card
   * @param note - The note text (non-empty)
   * @returns The DoneNoteResult from applyDoneNote
   */
  addActionNote(
    agentName: string,
    participantName: string,
    actionId: string,
    note: string,
  ): Promise<DoneNoteResult>;

  /**
   * Dismiss a DECISION card in an inbox file (Thread C).
   * Appends "dismissed: <ISO>" (+ optional "dismiss-reason: <json>") to the
   * decision card's rawMeta and emits a dismissed-reply block.
   * Idempotent: already-dismissed returns alreadyDismissed.
   * Mutual exclusion: answered -> alreadyAnswered; superseded -> alreadySuperseded.
   *
   * @param decisionId - The stable decision-id of the target card (e.g. "PROJ-123-q1")
   * @param reason - Optional dismiss reason (plain string)
   * @returns The DismissDecisionResult from applyDismissDecision
   */
  dismissDecisionCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    reason?: string,
  ): Promise<DismissDecisionResult>;

  /**
   * Supersede an ACTION card in an inbox file (Thread C).
   * Appends "superseded: <ISO>" (+ optional "supersede-note: <json>") and emits
   * a superseded-reply block.
   * Idempotent: already-superseded returns alreadySuperseded.
   * Mutual exclusion: done -> alreadyDone; dismissed -> alreadyDismissed.
   *
   * @param actionId - The stable action-id of the target action card
   * @param note - Optional supersede note (plain string)
   * @returns The SupersedeActionResult from applySupersedeAction
   */
  supersedeActionCard(
    agentName: string,
    participantName: string,
    actionId: string,
    note?: string,
  ): Promise<SupersedeActionResult>;

  /**
   * Supersede a DECISION card in an inbox file (Thread C).
   * Appends "superseded: <ISO>" (+ optional "supersede-note: <json>") and emits
   * a superseded-reply block.
   * Idempotent: already-superseded returns alreadySuperseded.
   * Mutual exclusion: answered -> alreadyAnswered; dismissed -> alreadyDismissed.
   *
   * @param decisionId - The stable decision-id of the target card (e.g. "PROJ-123-q1")
   * @param note - Optional supersede note (plain string)
   * @returns The SupersedeDecisionResult from applySupersedeDecision
   */
  supersedeDecisionCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    note?: string,
  ): Promise<SupersedeDecisionResult>;
}

// ---------------------------------------------------------------------------
// FileInboxRepository
// ---------------------------------------------------------------------------

/**
 * File-backed implementation of InboxRepository.
 *
 * Reads: uses fs.promises to read markdown files, then splitBlocks + parseBlock
 * from the pure parser to return typed MessageBlocks.
 *
 * Writes: serialize via serializeBlock/applyAnswer/applyPushBack, then route through
 * safeWrite (assertSafeWritePath + atomicWrite) - NEVER a raw fs write.
 *
 * The inbox root is resolved from INBOX_ROOT env (via resolveInboxRoot),
 * which throws if unset/empty/relative.
 */
export class FileInboxRepository implements InboxRepository {
  /**
   * @param inboxRoot - Absolute path to the inbox root. If omitted, resolved
   *   from INBOX_ROOT env at construction time. Must be absolute.
   *   Pass explicitly in tests to avoid relying on process.env at import time.
   */
  constructor(private readonly inboxRoot?: string) {}

  /** Resolve the inbox root path (may throw if INBOX_ROOT unset). */
  private getRoot(): string {
    return this.inboxRoot ?? resolveInboxRoot();
  }

  /**
   * Absolute path to an agent's inbox directory. Shared sink for both read
   * (readBlocks, readBlocksWindow) and write (via inboxFilePath ->
   * writeReply, markRead, answerCard, pushBackCard) call sites, so the
   * refusal messages below describe "access", not "read", and never echo
   * the allowlist roster (root.tsx renders Error.message directly in the
   * production error boundary, so the roster must not travel in the string).
   */
  private agentInboxDir(agentName: string): string {
    if (!AGENT_NAME_RE.test(agentName)) {
      throw new Error(
        `Refusing to access inbox: agent name "${agentName}" does not match ` +
          `the agent-name shape.`
      );
    }
    const allowed = getInboxAgentAllowlist();
    if (allowed && !allowed.has(agentName)) {
      throw new Error(
        `Refusing to access inbox: agent "${agentName}" is not in MC_INBOX_AGENT_ALLOWLIST.`
      );
    }
    return path.join(this.getRoot(), agentName, "inbox");
  }

  /** Absolute path to a specific inbox file. */
  private inboxFilePath(agentName: string, participantName: string): string {
    // Normalize the participant name to ensure it ends with .md
    const filename = participantName.endsWith(".md")
      ? participantName
      : `${participantName}.md`;
    return path.join(this.agentInboxDir(agentName), filename);
  }

  async listAgents(): Promise<string[]> {
    const root = this.getRoot();
    // Same allowlist as the write guard (default-open when unset): the real
    // an inbox root can carry archived and scratch dirs (harness-*, archived-demo) that
    // are not agents - don't surface anything MC would refuse to write to.
    const allowed = getInboxAgentAllowlist();
    try {
      const entries = await fs.promises.readdir(root, { withFileTypes: true });
      return entries
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((name) => !allowed || allowed.has(name))
        .sort();
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return [];
      }
      throw err;
    }
  }

  async readBlocks(
    agentName: string,
    participantName: string,
  ): Promise<readonly MessageBlock[]> {
    const filePath = this.inboxFilePath(agentName, participantName);

    // Stat-gate: a metadata-only probe, paid on every call. This is what keeps
    // the cache correctness-preserving rather than a staleness window - the
    // cached parse is only ever served when the file is byte-identical to the
    // one it was parsed from. Missing file -> empty, same contract as before.
    let stat: { mtimeMs: number; size: number };
    try {
      const st = await fs.promises.stat(filePath);
      stat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        blocksMemo.delete(filePath);
        return EMPTY_BLOCKS;
      }
      throw err;
    }

    const memo = blocksMemo.get(filePath);
    if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
      // Unchanged since our last full parse: zero read, zero parse. This is the
      // steady state for shell.tsx's 13-agent sweep on every nav + 3s poll.
      return memo.blocks;
    }

    // Snapshot the invalidation epoch BEFORE the read. If a writer invalidates
    // this file while our read is in flight, the epoch moves and we must NOT
    // install this parse - it may predate their write.
    const epochAtRead = blocksEpoch.get(filePath) ?? 0;

    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Raced deletion between stat and read: empty, memoise nothing.
        blocksMemo.delete(filePath);
        return EMPTY_BLOCKS;
      }
      throw err;
    }
    blocksReadCount += 1;

    const rawBlocks = splitBlocks(raw);
    blocksParsed += rawBlocks.length;
    // Frozen BEFORE the epoch check, not at the memo write, so the reference a
    // caller gets is the same frozen one whether this call memoised, skipped
    // the memo (epoch moved), or a later call served it as a cache hit. Freezing
    // only the STORED copy would make mutability depend on cache luck.
    const blocks: readonly MessageBlock[] = Object.freeze(
      rawBlocks.map((rawBlock) => parseBlock(rawBlock)),
    );

    // Still the epoch we read under: safe to memoise against the stat we took.
    // Otherwise return the freshly-parsed blocks (a real snapshot, honestly
    // answering the caller) but leave the cache empty so the next call re-reads.
    if ((blocksEpoch.get(filePath) ?? 0) === epochAtRead) {
      blocksMemo.set(filePath, {
        mtimeMs: stat.mtimeMs,
        size: stat.size,
        blocks,
      });
    }
    return blocks;
  }

  async readBlocksWindow(
    agentName: string,
    participantName: string,
    options: BlockWindowOptions = {},
  ): Promise<BlockWindow> {
    const filePath = this.inboxFilePath(agentName, participantName);

    // Cache key: file path + the exact window options. The 3s poll always asks
    // for the SAME tail window, so a stat-match serves it with zero re-read and
    // zero re-parse. Distinct before-cursors / anchors key separately.
    const cacheKey =
      filePath +
      "\u0000" +
      JSON.stringify({
        limit: options.limit ?? null,
        before: options.before ?? null,
        anchorId: options.anchorId ?? null,
      });

    // Stat-gate: a metadata-only probe. Missing file -> empty window.
    let stat: { mtimeMs: number; size: number } | null;
    try {
      const st = await fs.promises.stat(filePath);
      stat = { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        windowMemo.delete(cacheKey);
        return { blocks: [], startIndex: 0, totalCount: 0 };
      }
      throw err;
    }

    const memo = windowMemoGet(cacheKey);
    if (memo && memo.mtimeMs === stat.mtimeMs && memo.size === stat.size) {
      // Unchanged since the last read for this exact window: serve the cached
      // parsed window + totalCount. No disk read, no parse.
      return memo.window;
    }

    // Miss (first read, an external change, or our own markRead write bumping
    // mtime): pay ONE read, parse only the window, then memoise against stat.
    let raw: string;
    try {
      raw = await fs.promises.readFile(filePath, "utf8");
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        // Raced deletion between stat and read: empty window, memoise nothing.
        windowMemo.delete(cacheKey);
        return { blocks: [], startIndex: 0, totalCount: 0 };
      }
      throw err;
    }
    windowReadCount += 1;

    const window = computeWindow(raw, options);
    windowMemoSet(cacheKey, { mtimeMs: stat.mtimeMs, size: stat.size, window });
    return window;
  }

  async statInbox(
    agentName: string,
    participantName: string,
  ): Promise<{ mtimeMs: number; size: number } | null> {
    const filePath = this.inboxFilePath(agentName, participantName);
    try {
      const st = await fs.promises.stat(filePath);
      return { mtimeMs: st.mtimeMs, size: st.size };
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        return null;
      }
      throw err;
    }
  }

  async writeReply(
    agentName: string,
    participantName: string,
    replyBlock: MessageBlock,
  ): Promise<void> {
    const filePath = this.inboxFilePath(agentName, participantName);

    // Validate the path through the write-guard FIRST, before any fs mutation.
    // This prevents a traversal agentName from creating directories outside the
    // sandbox before the guard has a chance to throw. assertSafeWritePath throws
    // on any violation; we use the resolved path for the subsequent write.
    const resolvedPath = assertSafeWritePath(filePath);

    // Read + write under the cross-process lock so a concurrent append (the CLI or
    // the other MC) cannot be orphaned by our rename. Read is INSIDE the lock.
    await withInboxLock(resolvedPath, async () => {
      // Read the existing content first (or start empty if file does not exist)
      let existing = "";
      try {
        existing = await fs.promises.readFile(resolvedPath, "utf8");
      } catch (err) {
        if (
          !(
            err instanceof Error &&
            "code" in err &&
            (err as NodeJS.ErrnoException).code === "ENOENT"
          )
        ) {
          throw err;
        }
        // File does not exist yet - ensure the parent directory exists.
        // The guard has already validated the path, so mkdir is safe here.
        await fs.promises.mkdir(path.dirname(resolvedPath), {
          recursive: true,
        });
      }

      const serialized = serializeBlock(replyBlock);
      // Append the reply block, separated from existing content by a newline
      const updated = existing
        ? existing.trimEnd() + "\n" + serialized + "\n"
        : serialized + "\n";

      // Write using atomicWrite - path already validated by assertSafeWritePath above.
      atomicWrite(resolvedPath, updated);

      // Drop this file's cached parses inside the lock, on the same key
      // readBlocks/readBlocksWindow cache under (the UNRESOLVED filePath), so a
      // reader can never be served a parse that predates this write. An append
      // does change the size, but the stat guard is a backstop here, not the
      // mechanism - see invalidateParsedCaches.
      invalidateParsedCaches(filePath);
    });
  }

  /**
   * Record the file's post-write (mtimeMs, size) as the "settled" value for the
   * markRead fast-skip. Called AFTER our own byte-patch (and on a zero-flip
   * run), so our own flip does not make the very next poll rescan. Drops the
   * memo if the file cannot be stat'd (a later stat then re-reads, never trusts
   * a mismatched tag).
   */
  private async rememberMarkReadStat(filePath: string): Promise<void> {
    try {
      const st = await fs.promises.stat(filePath);
      markReadMemo.set(filePath, { mtimeMs: st.mtimeMs, size: st.size });
    } catch {
      markReadMemo.delete(filePath);
    }
  }

  async markRead(agentName: string, participantName: string): Promise<number> {
    const filePath = this.inboxFilePath(agentName, participantName);

    // Existence probe + fast-skip stat, BEFORE path validation. markRead fires
    // on every thread view (every 3s poll), including agents whose inbox dir was
    // never created. assertSafeWritePath -> confineToRootReal realpaths the
    // PARENT dir and lets ENOENT propagate by design (the traversal-mkdir
    // guard), so validating first would CRASH on a genuinely missing thread
    // instead of returning 0. stat() (follows symlinks) confirms the file - and
    // thus its parent - exists before we validate + lock; when it succeeds the
    // deferred assertSafeWritePath can no longer re-throw the ENOENT we stepped
    // past, and the write path is still ALWAYS validated by assertSafeWritePath
    // before any write (traversal guard intact, only reordered past the check).
    let st: { mtimeMs: number; size: number };
    try {
      const s = await fs.promises.stat(filePath);
      st = { mtimeMs: s.mtimeMs, size: s.size };
    } catch (err) {
      if (
        err instanceof Error &&
        "code" in err &&
        (err as NodeJS.ErrnoException).code === "ENOENT"
      ) {
        markReadMemo.delete(filePath);
        return 0; // No thread file yet - nothing to receipt, create nothing.
      }
      throw err;
    }

    // Fast-skip: if (mtimeMs, size) matches the value this process last
    // settled for the file, there is provably no new content to receipt - return
    // 0 without the lock, without a read, without a parse.
    //
    // SAFETY INVARIANT (do not weaken): this is ONLY a skip-when-nothing-changed
    // optimization. The moment the stat differs from the memo (or no memo
    // exists) we fall through to the EXACT same lock + fresh-read + flip + write
    // path below. A cached value NEVER substitutes for a fresh read on the write
    // path - that is what stops a clobber of a concurrent write.
    const memo = markReadMemo.get(filePath);
    if (memo && memo.mtimeMs === st.mtimeMs && memo.size === st.size) {
      return 0;
    }

    const resolvedPath = assertSafeWritePath(filePath);

    // Receipt flip under the lock: read INSIDE so a concurrent send is not
    // clobbered by the patch. markRead fires on every thread view -> the most
    // frequent rewriter, the dominant collision in the P1 bug.
    return await withInboxLock(resolvedPath, async () => {
      let raw: string;
      try {
        raw = await fs.promises.readFile(filePath, "utf8");
      } catch (err) {
        if (
          err instanceof Error &&
          "code" in err &&
          (err as NodeJS.ErrnoException).code === "ENOENT"
        ) {
          markReadMemo.delete(filePath);
          return 0; // No thread file yet - nothing to receipt.
        }
        throw err;
      }

      // This run did NOT fast-skip - it paid the full read + scan (test seam).
      markReadScanCount += 1;

      // Cheap scan: header lines only via parseHeader - no full
      // parseBlock (no YAML, no zod, no body work) over all 4029 blocks just to
      // find the ones with status: sent. from/status depend solely on
      // parseHeader, so this yields the SAME flip set the full parse would.
      // Flip sent -> read on the OTHER side's blocks only (no symmetric flip);
      // "working" and already-"read" blocks are untouched.
      //
      // Locating the "sent" TOKEN's char offset re-execs the SAME anchored
      // HEADER_RE (with match indices) rather than a second, looser pattern.
      // A prior version used an unanchored /status:\s*sent/ that took the
      // first match in the line: safe only because "status:" precedes
      // "subject:" in the grammar, but that argument does NOT cover "from",
      // which comes BEFORE status - a participant name literally containing
      // "status: sent" would have matched inside `from` instead, and
      // verify-before-write would NOT have caught it (the bytes there
      // genuinely spell "sent", so the check trivially passes; it is the
      // wrong "sent", not a corrupted one). Re-using HEADER_RE's own status
      // CAPTURE GROUP position makes this structurally impossible rather than
      // argued away: the offset can only ever be where the anchored grammar's
      // own status field matched, never inside from/subject.
      const sentCharIdxs: number[] = [];
      for (const h of scanBlockHeaders(raw)) {
        const parsed = parseHeader(h.headerLine);
        if (!parsed.ok) continue;
        if (parsed.header.from === participantName) continue; // no symmetric flip
        if (parsed.header.status !== "sent") continue; // working/read untouched
        const m = HEADER_RE_INDEXED.exec(h.headerLine);
        // defensive: parseHeader (same grammar) already matched, so this can
        // only fail if the two regexes somehow diverge - skip rather than guess.
        const statusRange = m?.indices?.groups?.["status"];
        if (!statusRange) continue;
        sentCharIdxs.push(h.charStart + statusRange[0]);
      }

      // Idempotent: nothing to flip = no write. Record the settled stat so the
      // next poll fast-skips (unchanged file), then return 0.
      if (sentCharIdxs.length === 0) {
        await this.rememberMarkReadStat(filePath);
        return 0;
      }

      // Char -> UTF-8 byte offsets in ONE ascending pass (sentCharIdxs is in
      // block order = ascending). A message body earlier in the file may hold
      // multi-byte UTF-8, so a char index is NOT a byte index - convert via the
      // encoded length of the intervening slice (mirrors packages/base/bin/inbox).
      const byteOffsets: number[] = [];
      let prevChar = 0;
      let prevByte = 0;
      for (const charIdx of sentCharIdxs) {
        prevByte += Buffer.byteLength(raw.slice(prevChar, charIdx), "utf8");
        prevChar = charIdx;
        byteOffsets.push(prevByte);
      }

      // Same-length in-place byte patch: overwrite each verified "sent" (4 bytes)
      // with "read" at its byte offset. Never rewrites the file and never moves a
      // byte anywhere else, so a concurrent EOF append is never clobbered and
      // every other block stays byte-identical - the format THREE other live
      // consumers read (the inbox CLI, agent read-receipts, MC's own unread-dot).
      // Mirrors flip_blocks_in_file in packages/base/bin/inbox. resolvedPath is
      // already validated by assertSafeWritePath above.
      let patched = 0;
      const fh = await fs.promises.open(resolvedPath, "r+");
      try {
        const verify = Buffer.alloc(4);
        for (const off of byteOffsets) {
          const { bytesRead } = await fh.read(verify, 0, 4, off);
          // Safety: a short read (e.g. concurrent truncation right at this
          // offset) would otherwise leave `verify` holding stale bytes from
          // the PREVIOUS loop iteration (Buffer.alloc(4) only zero-fills once,
          // it is reused across iterations), which could spuriously pass or
          // fail the equals check below - skip rather than trust a partial
          // read.
          if (bytesRead !== 4) continue;
          // Safety: if the bytes are not what we computed from `raw`, the file
          // moved under us - skip rather than corrupt (mirrors the CLI).
          if (!verify.equals(SENT_BYTES)) continue;
          await fh.write(READ_BYTES, 0, 4, off);
          patched++;
        }
        await fh.sync();
      } finally {
        await fh.close();
      }

      // Our same-length patch does not change the file size, so the (mtime,
      // size) guard on BOTH parsed caches cannot be trusted to notice it on a
      // coarse filesystem - invalidate this file's cached parses explicitly.
      // For blocksMemo this is what stops a read-receipt flip leaving a stale
      // magenta unread dot / stale hasUnread in shell.tsx's sidebar.
      invalidateParsedCaches(filePath);

      // Record the POST-WRITE stat so our own flip does not trigger a rescan on
      // the next poll (the fast-skip's cache value is the mtime/size after us).
      await this.rememberMarkReadStat(filePath);
      return patched;
    });
  }

  async answerCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    answerKey: string,
  ): Promise<AnswerResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      // Resolve target by stable decision-id, not positional index
      const targetBlock = blocks.find((b) => b.card?.decisionId === decisionId);
      if (!targetBlock) {
        throw new Error(
          `Decision card with id "${decisionId}" not found in ${filePath}`,
        );
      }

      const result = applyAnswer(targetBlock, answerKey, participantName);

      // No-op (already answered / dismissed / superseded): short-circuit on the
      // ABSENCE of the success key so new terminal-state variants can never fall
      // through to a write against an undefined answeredOriginal.
      if (!("answeredOriginal" in result)) {
        return result;
      }

      // Rebuild the file with the answered original in place
      const updatedBlocks = blocks.map((b) =>
        b.card?.decisionId === decisionId ? result.answeredOriginal : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      // Append the reply block at the end
      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.replyBlock) +
        "\n";

      // path already validated by assertSafeWritePath above.
      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async customAnswerCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    text: string,
  ): Promise<CustomAnswerResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      // Resolve target by stable decision-id, not positional index
      const targetBlock = blocks.find((b) => b.card?.decisionId === decisionId);
      if (!targetBlock) {
        throw new Error(
          `Decision card with id "${decisionId}" not found in ${filePath}`,
        );
      }

      const result = applyCustomAnswer(targetBlock, text, participantName);

      // No-op (already answered / dismissed / superseded): short-circuit on the
      // absence of the success key (see answerCard note).
      if (!("answeredOriginal" in result)) {
        return result;
      }

      // Rebuild the file with the answered original in place
      const updatedBlocks = blocks.map((b) =>
        b.card?.decisionId === decisionId ? result.answeredOriginal : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      // Append the reply block at the end
      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.replyBlock) +
        "\n";

      // path already validated by assertSafeWritePath above.
      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async pushBackCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    note?: string,
  ): Promise<PushBackResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      // Resolve target by stable decision-id, not positional index
      const targetBlock = blocks.find((b) => b.card?.decisionId === decisionId);
      if (!targetBlock) {
        throw new Error(
          `Decision card with id "${decisionId}" not found in ${filePath}`,
        );
      }

      const result = applyPushBack(targetBlock, note, participantName);

      // No-op (already resolved - answered / pushed back / dismissed / superseded):
      // short-circuit on the absence of the success key.
      if (!("pushedBackOriginal" in result)) {
        return result;
      }

      // Rebuild the file with the pushed-back original in place
      const updatedBlocks = blocks.map((b) =>
        b.card?.decisionId === decisionId ? result.pushedBackOriginal : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      // Append the push-back reply block at the end
      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.pushBackBlock) +
        "\n";

      // path already validated by assertSafeWritePath above.
      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async markActionDone(
    agentName: string,
    participantName: string,
    actionId: string,
  ): Promise<DoneResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      // Resolve target by stable action-id, not positional index
      const targetBlock = blocks.find(
        (b) => b.actionCard?.actionId === actionId,
      );
      if (!targetBlock) {
        throw new Error(
          `Action card with id "${actionId}" not found in ${filePath}`,
        );
      }

      const result = applyDone(targetBlock);

      // No-op (already done / dismissed / superseded): short-circuit on the
      // absence of the success key.
      if (!("markedDone" in result)) {
        return result;
      }

      // Rebuild the file with the done-marked action in place.
      // Byte-identical for all other blocks.
      const updatedBlocks = blocks.map((b) =>
        b.actionCard?.actionId === actionId ? result.markedDone : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      // path already validated by assertSafeWritePath above.
      atomicWrite(resolvedFilePath, updatedContent);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async markActionDismissed(
    agentName: string,
    participantName: string,
    actionId: string,
    reason?: string,
  ): Promise<DismissResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      const targetBlock = blocks.find(
        (b) => b.actionCard?.actionId === actionId,
      );
      if (!targetBlock) {
        throw new Error(
          `Action card with id "${actionId}" not found in ${filePath}`,
        );
      }

      const result = applyDismiss(
        targetBlock,
        reason,
        undefined,
        participantName,
      );

      // No-op (already dismissed / done / superseded): short-circuit on the
      // absence of the success key.
      if (!("dismissedBlock" in result)) {
        return result;
      }

      // Rebuild the file with the dismissed action in place.
      const updatedBlocks = blocks.map((b) =>
        b.actionCard?.actionId === actionId ? result.dismissedBlock : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      // Append the reply block at the end.
      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.replyBlock) +
        "\n";

      // path already validated by assertSafeWritePath above.
      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async addActionNote(
    agentName: string,
    participantName: string,
    actionId: string,
    note: string,
  ): Promise<DoneNoteResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      const targetBlock = blocks.find(
        (b) => b.actionCard?.actionId === actionId,
      );
      if (!targetBlock) {
        throw new Error(
          `Action card with id "${actionId}" not found in ${filePath}`,
        );
      }

      const result = applyDoneNote(
        targetBlock,
        note,
        undefined,
        participantName,
      );

      // notDone and alreadyNoted are no-ops (no write).
      if ("notDone" in result || "alreadyNoted" in result) {
        return result;
      }

      // Rebuild the file with the noted block in place.
      const updatedBlocks = blocks.map((b) =>
        b.actionCard?.actionId === actionId ? result.notedBlock : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      // Append the reply block at the end.
      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.replyBlock) +
        "\n";

      // path already validated by assertSafeWritePath above.
      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async dismissDecisionCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    reason?: string,
  ): Promise<DismissDecisionResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      // Resolve target by stable decision-id, not positional index.
      const targetBlock = blocks.find((b) => b.card?.decisionId === decisionId);
      if (!targetBlock) {
        throw new Error(
          `Decision card with id "${decisionId}" not found in ${filePath}`,
        );
      }

      const result = applyDismissDecision(
        targetBlock,
        reason,
        undefined,
        participantName,
      );

      // No-op (already dismissed / answered / superseded): short-circuit on the
      // absence of the success key.
      if (!("dismissedBlock" in result)) {
        return result;
      }

      const updatedBlocks = blocks.map((b) =>
        b.card?.decisionId === decisionId ? result.dismissedBlock : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.replyBlock) +
        "\n";

      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async supersedeActionCard(
    agentName: string,
    participantName: string,
    actionId: string,
    note?: string,
  ): Promise<SupersedeActionResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      const targetBlock = blocks.find(
        (b) => b.actionCard?.actionId === actionId,
      );
      if (!targetBlock) {
        throw new Error(
          `Action card with id "${actionId}" not found in ${filePath}`,
        );
      }

      const result = applySupersedeAction(
        targetBlock,
        note,
        undefined,
        participantName,
      );

      // No-op (already superseded / done / dismissed): short-circuit on the
      // absence of the success key.
      if (!("supersededBlock" in result)) {
        return result;
      }

      const updatedBlocks = blocks.map((b) =>
        b.actionCard?.actionId === actionId ? result.supersededBlock : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.replyBlock) +
        "\n";

      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }

  async supersedeDecisionCard(
    agentName: string,
    participantName: string,
    decisionId: string,
    note?: string,
  ): Promise<SupersedeDecisionResult> {
    const filePath = this.inboxFilePath(agentName, participantName);
    const resolvedFilePath = assertSafeWritePath(filePath);
    return await withInboxLock(resolvedFilePath, async () => {
      const raw = await fs.promises.readFile(filePath, "utf8");
      const rawBlocks = splitBlocks(raw);
      const blocks = rawBlocks.map((rb) => parseBlock(rb));

      const targetBlock = blocks.find((b) => b.card?.decisionId === decisionId);
      if (!targetBlock) {
        throw new Error(
          `Decision card with id "${decisionId}" not found in ${filePath}`,
        );
      }

      const result = applySupersedeDecision(
        targetBlock,
        note,
        undefined,
        participantName,
      );

      // No-op (already superseded / answered / dismissed): short-circuit on the
      // absence of the success key.
      if (!("supersededBlock" in result)) {
        return result;
      }

      const updatedBlocks = blocks.map((b) =>
        b.card?.decisionId === decisionId ? result.supersededBlock : b,
      );
      const updatedContent =
        updatedBlocks.map((b) => serializeBlock(b)).join("\n") + "\n";

      const withReply =
        updatedContent.trimEnd() +
        "\n" +
        serializeBlock(result.replyBlock) +
        "\n";

      atomicWrite(resolvedFilePath, withReply);

      // Our own write never leans on the stat guard (see invalidateParsedCaches).
      // Key is the UNRESOLVED filePath - what readBlocks/readBlocksWindow use.
      invalidateParsedCaches(filePath);

      return result;
    });
  }
}
