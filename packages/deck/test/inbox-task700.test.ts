/**
 * inbox-task700.test.ts - the P1 fix (a 3.6MB / 4029-block thread
 * spun Deck on open, paying a full parse of every block TWICE per 3s poll).
 *
 * Four pieces, all proved here:
 *   1. readBlocksWindow parses ONLY the window's blocks (not the whole file).
 *   2. A module-level (mtimeMs, size)-guarded cache serves an unchanged window
 *      with zero re-read and zero re-parse.
 *   3. markRead fast-skips (no lock, no scan, no write) when the file is
 *      unchanged since this process last settled it; a genuine change falls
 *      through to the full read + flip.
 *   4. The flip is a SAME-LENGTH in-place byte patch of the sent->read token,
 *      byte-identical to the old whole-file rewrite everywhere EXCEPT the
 *      flipped tokens (the format three other live consumers read directly).
 *
 * A fifth piece, the sidebar/shell perf fix, rides the same seams:
 *   5. readBlocks - the WHOLE-file read shell.tsx does for every agent on every
 *      nav and every 3s poll tick - is itself (mtimeMs, size)-cached, and
 *      markRead's byte-patch invalidates that cache alongside the window one.
 *
 * Instrumentation seams mirror file-description.server.ts
 * (__descriptionCacheReadCount): __windowBlocksParsed / __windowReadCount /
 * __markReadScanCount / __blocksReadCount / __blocksParsed, cleared by
 * __resetInboxCaches.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  FileInboxRepository,
  DEFAULT_WINDOW_LIMIT,
  __resetInboxCaches,
  __windowBlocksParsed,
  __windowReadCount,
  __markReadScanCount,
  __blocksReadCount,
  __blocksParsed,
} from "~/lib/inbox.server";
import { splitBlocks, parseBlock, serializeBlock } from "~/lib/blocks";
import type { MessageBlock } from "~/lib/blocks";
import { mkdtempSync, rmSync } from "~/lib/test-helpers";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A canonical tail-window thread of `count` plain blocks, alternating sender. */
function buildThread(count: number): string {
  let out = "";
  for (let i = 0; i < count; i++) {
    const from = i % 2 === 0 ? "quill" : "alex";
    const status = "read";
    const minute = String(i % 60).padStart(2, "0");
    const hour = String(10 + Math.floor(i / 60)).padStart(2, "0");
    out += `## 2026-06-10T${hour}:${minute}:00Z - from: ${from} - status: ${status} - subject: msg ${i}\n\nBody of message ${i}.\n\n---\n`;
  }
  return out;
}

/** A single un-done action card - the fixture for the card-mutator cache test. */
const ACTION_THREAD = [
  `## 2026-06-09T15:00:00Z - from: quill - status: read - subject: review the spec`,
  `action-id: TASK-500-review`,
  `priority: high`,
  ``,
  `Please review before merge.`,
  ``,
  `---`,
  ``,
].join("\n");

/**
 * The OLD markRead mechanism, verbatim: parse the WHOLE file, flip the other
 * side's sent blocks, re-serialize ALL blocks. The byte-patch must reproduce
 * this output byte-for-byte on a canonical file.
 */
function oldRewrite(
  raw: string,
  participant: string
): { output: string; flipped: number } {
  const blocks = splitBlocks(raw).map((rb) => parseBlock(rb));
  let flipped = 0;
  const updated = blocks.map((b) => {
    if (b.header.from !== participant && b.header.status === "sent") {
      flipped++;
      return { ...b, header: { ...b.header, status: "read" as const } };
    }
    return b;
  });
  const output = updated.map((b) => serializeBlock(b)).join("\n") + "\n";
  return { output, flipped };
}

describe("TASK-700 inbox thread-wedge fix", () => {
  let sandbox: string;
  let repo: FileInboxRepository;
  let savedInboxRoot: string | undefined;

  function seed(agent: string, participant: string, content: string) {
    const dir = path.join(sandbox, agent, "inbox");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${participant}.md`), content, "utf8");
  }

  function threadFile(agent: string, participant: string): string {
    return path.join(sandbox, agent, "inbox", `${participant}.md`);
  }

  beforeEach(() => {
    sandbox = mkdtempSync();
    savedInboxRoot = process.env["INBOX_ROOT"];
    process.env["INBOX_ROOT"] = sandbox;
    repo = new FileInboxRepository(sandbox);
    __resetInboxCaches();
  });

  afterEach(() => {
    rmSync(sandbox);
    __resetInboxCaches();
    if (savedInboxRoot === undefined) {
      delete process.env["INBOX_ROOT"];
    } else {
      process.env["INBOX_ROOT"] = savedInboxRoot;
    }
  });

  // -------------------------------------------------------------------------
  // 1. Parse-window-only
  // -------------------------------------------------------------------------

  describe("readBlocksWindow parses only the window", () => {
    it("tail window parses exactly `limit` blocks, not the whole file", async () => {
      seed("quill", "alex", buildThread(100));
      const win = await repo.readBlocksWindow("quill", "alex", { limit: 30 });

      // Correct window (unchanged contract).
      expect(win.totalCount).toBe(100);
      expect(win.startIndex).toBe(70);
      expect(win.blocks).toHaveLength(30);
      expect(win.blocks[0]!.header.subject).toBe("msg 70");
      expect(win.blocks[29]!.header.subject).toBe("msg 99");

      // The fix: only 30 blocks were parseBlock'd, not 100.
      expect(__windowBlocksParsed()).toBe(30);
      expect(__windowReadCount()).toBe(1);
    });

    it("before-cursor parses only that chunk's blocks", async () => {
      seed("quill", "alex", buildThread(100));
      const older = await repo.readBlocksWindow("quill", "alex", {
        before: 70,
        limit: 30,
      });
      expect(older.startIndex).toBe(40);
      expect(older.blocks).toHaveLength(30);
      expect(older.blocks[0]!.header.subject).toBe("msg 40");
      expect(__windowBlocksParsed()).toBe(30);
    });

    it("anchorId keeps the wider scan (rare, user-driven deep-link)", async () => {
      // A card at block 12; anchor extends the window back to it.
      let raw = "";
      for (let i = 0; i < 100; i++) {
        const from = i % 2 === 0 ? "quill" : "alex";
        raw += `## 2026-06-10T10:${String(i % 60).padStart(2, "0")}:00Z - from: ${from} - status: read - subject: msg ${i}\n`;
        if (i === 12) {
          raw += `decision-id: DEEP-1\noptions:\n  - key: A\n    label: "A"\n    detail: "First."\n`;
        }
        raw += `\nBody ${i}.\n\n---\n`;
      }
      seed("quill", "alex", raw);
      const win = await repo.readBlocksWindow("quill", "alex", {
        limit: 30,
        anchorId: "DEEP-1",
      });
      expect(win.startIndex).toBe(12);
      expect(win.blocks[0]!.card?.decisionId).toBe("DEEP-1");
      // The anchor path intentionally parses all blocks to find the card.
      expect(__windowBlocksParsed()).toBe(100);
    });
  });

  // -------------------------------------------------------------------------
  // 2. Window cache stat-gate
  // -------------------------------------------------------------------------

  describe("readBlocksWindow module-level stat-gated cache", () => {
    it("serves an unchanged window with zero re-read and zero re-parse", async () => {
      seed("quill", "alex", buildThread(80));

      const first = await repo.readBlocksWindow("quill", "alex", { limit: 30 });
      expect(__windowReadCount()).toBe(1);
      expect(__windowBlocksParsed()).toBe(30);

      // A FRESH repository (makeStores builds one per request) must still hit
      // the module-level cache - the whole point of not putting it on the class.
      const repo2 = new FileInboxRepository(sandbox);
      const second = await repo2.readBlocksWindow("quill", "alex", { limit: 30 });

      // No new read, no new parse - served from the cache.
      expect(__windowReadCount()).toBe(1);
      expect(__windowBlocksParsed()).toBe(30);
      expect(second.blocks.map((b) => b.header.subject)).toEqual(
        first.blocks.map((b) => b.header.subject)
      );
    });

    it("re-reads + re-parses after the file changes (mtime/size differ)", async () => {
      seed("quill", "alex", buildThread(80));
      await repo.readBlocksWindow("quill", "alex", { limit: 30 });
      expect(__windowReadCount()).toBe(1);

      // Append a block: size (and mtime) change, so the cache must invalidate.
      fs.appendFileSync(
        threadFile("quill", "alex"),
        `## 2026-06-10T12:00:00Z - from: quill - status: read - subject: msg 80\n\nBody of message 80.\n\n---\n`,
        "utf8"
      );

      const after = await repo.readBlocksWindow("quill", "alex", { limit: 30 });
      expect(__windowReadCount()).toBe(2);
      expect(after.totalCount).toBe(81);
      expect(after.blocks[29]!.header.subject).toBe("msg 80");
    });

    it("distinct window options are cached independently", async () => {
      seed("quill", "alex", buildThread(100));
      await repo.readBlocksWindow("quill", "alex", { limit: 30 }); // tail
      await repo.readBlocksWindow("quill", "alex", { before: 70, limit: 30 }); // older
      expect(__windowReadCount()).toBe(2); // two distinct windows, two reads

      // Re-request each - both are cache hits now.
      await repo.readBlocksWindow("quill", "alex", { limit: 30 });
      await repo.readBlocksWindow("quill", "alex", { before: 70, limit: 30 });
      expect(__windowReadCount()).toBe(2);
    });

    it("evicts the oldest entry once past the cap, but a recently-used entry survives (review finding)", async () => {
      // Distinct `limit` values are cheap, valid, distinct cache keys (no need
      // for a giant thread file to exercise the LRU bookkeeping itself).
      seed("quill", "alex", buildThread(20));

      // Fill past the cap (200) by one, so eviction must have happened.
      const FILL = 201;
      for (let limit = 1; limit <= FILL; limit++) {
        await repo.readBlocksWindow("quill", "alex", { limit });
      }
      expect(__windowReadCount()).toBe(FILL); // every fill was a genuine miss

      // The very FIRST key inserted (limit: 1) should have been evicted (it
      // is the oldest, and was never re-touched) - re-requesting it is a
      // fresh miss, bumping the read count.
      const before = __windowReadCount();
      await repo.readBlocksWindow("quill", "alex", { limit: 1 });
      expect(__windowReadCount()).toBe(before + 1);

      // The MOST RECENT key (limit: FILL) is still cached - re-requesting it
      // is a hit, no new read.
      const afterEvictedRefetch = __windowReadCount();
      await repo.readBlocksWindow("quill", "alex", { limit: FILL });
      expect(__windowReadCount()).toBe(afterEvictedRefetch);
    });

    it("a get() bumps an entry to most-recently-used, protecting it from eviction", async () => {
      seed("quill", "alex", buildThread(20));

      // Insert exactly at the cap (200), then re-touch the OLDEST key (limit: 1)
      // via a cache-hit get before pushing one more insert past the cap.
      for (let limit = 1; limit <= 200; limit++) {
        await repo.readBlocksWindow("quill", "alex", { limit });
      }
      const afterFill = __windowReadCount();
      await repo.readBlocksWindow("quill", "alex", { limit: 1 }); // bump: cache hit
      expect(__windowReadCount()).toBe(afterFill); // confirm it WAS a hit, not a miss

      // One more distinct insert pushes past the cap - without the bump this
      // would evict limit:1 (the true insertion-order-oldest); the bump should
      // make limit:2 the eviction target instead.
      await repo.readBlocksWindow("quill", "alex", { limit: 201 });

      const beforeRefetch = __windowReadCount();
      await repo.readBlocksWindow("quill", "alex", { limit: 1 }); // bumped - still cached
      expect(__windowReadCount()).toBe(beforeRefetch); // hit, no new read

      const beforeRefetch2 = __windowReadCount();
      await repo.readBlocksWindow("quill", "alex", { limit: 2 }); // never bumped - evicted
      expect(__windowReadCount()).toBe(beforeRefetch2 + 1); // miss, fresh read
    });
  });

  // -------------------------------------------------------------------------
  // 2b. readBlocks whole-file cache stat-gate
  //
  // Same class of bug as the thread wedge, on the OTHER call path: shell.tsx (the layout
  // route wrapping every page) readBlocks EVERY agent on every nav + every 3s
  // poll tick. Unlike the thread view this genuinely needs the whole file
  // (hasUnhandled / hasUnread / the bell are all "any such block ANYWHERE"),
  // so the fix is a cache, not a window.
  // -------------------------------------------------------------------------

  describe("readBlocks module-level stat-gated cache", () => {
    const TWO_UNREAD = `## 2026-06-07T18:00:00Z - from: quill - status: sent - subject: one

First inbound.

---
## 2026-06-07T18:05:00Z - from: alex - status: sent - subject: mine

The user's own - never flips.

---
## 2026-06-07T18:10:00Z - from: quill - status: sent - subject: two

Second inbound.

---
`;

    /**
     * A fixed, whole-millisecond mtime. Freezing the file's mtime to a known
     * value (rather than reading and restoring whatever the OS produced) makes
     * "the stat guard cannot see this write" reproducible EXACTLY: sub-ms
     * timestamp precision can survive a stat/utimes round-trip, which would
     * make the guard spuriously notice the change and pass the test for the
     * wrong reason. Every test below that relies on the freeze also ASSERTS the
     * stat really is byte-identical afterwards.
     */
    const FIXED_MTIME = new Date(1_750_000_000_000);

    function freezeMtime(agent: string, participant: string): void {
      fs.utimesSync(threadFile(agent, participant), FIXED_MTIME, FIXED_MTIME);
    }

    /** quill's block statuses, in file order - the thing the magenta dot reads. */
    function ioStatuses(
      blocks: readonly { header: { from: string; status: string } }[]
    ) {
      return blocks.filter((b) => b.header.from === "quill").map((b) => b.header.status);
    }

    it("serves an unchanged file with zero re-read and zero re-parse", async () => {
      seed("quill", "alex", buildThread(80));

      const first = await repo.readBlocks("quill", "alex");
      expect(first).toHaveLength(80);
      expect(__blocksReadCount()).toBe(1);
      expect(__blocksParsed()).toBe(80);

      // A FRESH repository (makeStores builds one per request, so every nav and
      // every poll tick gets a new instance) must still hit the module-level
      // cache - that is the whole reason it is not on the class.
      const repo2 = new FileInboxRepository(sandbox);
      const second = await repo2.readBlocks("quill", "alex");

      // The proof: no new disk read, no new parseBlock. Not "it returned the
      // same thing" - it did no work to do so.
      expect(__blocksReadCount()).toBe(1);
      expect(__blocksParsed()).toBe(80);
      expect(second.map((b) => b.header.subject)).toEqual(
        first.map((b) => b.header.subject)
      );
    });

    it("re-reads + re-parses after a real append, never serving the stale list", async () => {
      seed("quill", "alex", buildThread(80));
      const before = await repo.readBlocks("quill", "alex");
      expect(before).toHaveLength(80);
      expect(__blocksReadCount()).toBe(1);

      // A genuine new inbound DM (external writer): size changes.
      fs.appendFileSync(
        threadFile("quill", "alex"),
        `## 2026-06-10T12:00:00Z - from: quill - status: sent - subject: msg 80\n\nBody of message 80.\n\n---\n`,
        "utf8"
      );

      const after = await repo.readBlocks("quill", "alex");
      expect(__blocksReadCount()).toBe(2); // paid a real re-read
      expect(after).toHaveLength(81);
      expect(after[80]!.header.subject).toBe("msg 80");
      // The sidebar's two derived signals both move with it.
      expect(after.some((b) => b.header.from !== "alex" && b.header.status === "sent")).toBe(true);
    });

    it("distinct agents are cached independently", async () => {
      seed("quill", "alex", buildThread(10));
      seed("nova", "alex", buildThread(4));

      await repo.readBlocks("quill", "alex");
      await repo.readBlocks("nova", "alex");
      expect(__blocksReadCount()).toBe(2);

      // Second sweep over both (what every poll tick does): all hits.
      expect(await repo.readBlocks("quill", "alex")).toHaveLength(10);
      expect(await repo.readBlocks("nova", "alex")).toHaveLength(4);
      expect(__blocksReadCount()).toBe(2);
    });

    it("a missing inbox file returns [] without caching or throwing", async () => {
      // shell.tsx sweeps every agent dir, including ones with no thread file
      // for this instance's user - the stat-gate must keep that contract.
      fs.mkdirSync(path.join(sandbox, "ghost", "inbox"), { recursive: true });
      expect(await repo.readBlocks("ghost", "alex")).toEqual([]);
      expect(__blocksReadCount()).toBe(0); // no read was even attempted

      // And it starts working the moment the file appears (no negative cache).
      seed("ghost", "alex", buildThread(3));
      expect(await repo.readBlocks("ghost", "alex")).toHaveLength(3);
      expect(__blocksReadCount()).toBe(1);
    });

    // -----------------------------------------------------------------------
    // THE correctness case: markRead's flip is a SAME-LENGTH byte patch, so the
    // file size never moves. If the mtime bump is also invisible (coarse-mtime
    // filesystem, or the bump landing in a tick already read), the (mtime,size)
    // guard CANNOT see the write, and the cache would keep serving "sent" -
    // a magenta unread dot on a thread the operator has already read. The explicit
    // invalidateParsedCaches() call inside markRead is the only thing standing
    // between the cache and that bug; these two tests are what pin it.
    // -----------------------------------------------------------------------

    it("reflects markRead's byte-patch even when the stat guard cannot see the write", async () => {
      seed("quill", "alex", TWO_UNREAD);
      freezeMtime("quill", "alex");

      // Prime the cache on the PRE-flip file, exactly as shell.tsx's sidebar
      // sweep does on the nav that opens the thread.
      const primed = await repo.readBlocks("quill", "alex");
      expect(ioStatuses(primed)).toEqual(["sent", "sent"]);
      const primedStat = fs.statSync(threadFile("quill", "alex"));

      // The read receipt fires (threads.$agent.tsx's loader, same navigation).
      expect(await repo.markRead("quill", "alex")).toBe(2);

      // Simulate the filesystem the subtlety is about: the flip's mtime bump is
      // invisible. Size is ALREADY unchanged - that is the byte-patch's whole
      // design - so after restoring mtime the stat is bit-identical to the one
      // the cache entry was tagged with.
      freezeMtime("quill", "alex");
      const afterStat = fs.statSync(threadFile("quill", "alex"));
      expect(afterStat.size).toBe(primedStat.size); // same-length patch, confirmed
      expect(afterStat.mtimeMs).toBe(primedStat.mtimeMs); // guard is now blind
      // The flip really did happen on disk (we are testing the cache, not a no-op).
      expect(fs.readFileSync(threadFile("quill", "alex"), "utf8")).not.toContain(
        "from: quill - status: sent"
      );

      // With the stat guard blind, ONLY the explicit invalidation can save this.
      const after = await repo.readBlocks("quill", "alex");
      expect(ioStatuses(after)).toEqual(["read", "read"]);
    });

    it("a readBlocks in flight across markRead's write never installs its pre-flip parse", async () => {
      // The interleave is not hypothetical: threads.$agent.tsx's loader calls
      // markRead while shell.tsx - its PARENT layout loader, which React Router
      // runs CONCURRENTLY - is mid-readBlocks over every agent. So on every
      // thread click a readBlocks can observe pre-flip bytes and only reach its
      // cache write AFTER markRead has patched and invalidated. Deleting the
      // invalidation is not enough to be safe here; the epoch guard is.
      seed("quill", "alex", TWO_UNREAD);
      freezeMtime("quill", "alex");
      const preFlipRaw = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      const primedStat = fs.statSync(threadFile("quill", "alex"));

      // Park readBlocks inside its read, holding the exact PRE-flip bytes, and
      // signal once it is parked so markRead runs strictly afterwards. Only the
      // FIRST readFile is gated (mockImplementationOnce), so markRead's own read
      // uses the real filesystem.
      let signalParked!: () => void;
      const parked = new Promise<void>((resolve) => {
        signalParked = resolve;
      });
      let release!: () => void;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const spy = vi.spyOn(fs.promises, "readFile").mockImplementationOnce((async () => {
        signalParked();
        await gate;
        return preFlipRaw;
      }) as unknown as typeof fs.promises.readFile);

      const inFlight = repo.readBlocks("quill", "alex");
      await parked; // readBlocks has stat'd, missed, and is inside its read

      expect(await repo.markRead("quill", "alex")).toBe(2); // patches + invalidates

      release();
      const stale = await inFlight;
      spy.mockRestore();

      // The in-flight call honestly returns the snapshot it read (pre-flip) -
      // it answered the question it was asked, at the time it was asked.
      expect(ioStatuses(stale)).toEqual(["sent", "sent"]);

      // Blind the stat guard again, so a wrongly-installed entry WOULD be served.
      freezeMtime("quill", "alex");
      const afterStat = fs.statSync(threadFile("quill", "alex"));
      expect(afterStat.size).toBe(primedStat.size);
      expect(afterStat.mtimeMs).toBe(primedStat.mtimeMs);

      // The next request must still see the receipt. If the in-flight parse had
      // been installed after the invalidation, this returns ["sent","sent"].
      const next = await repo.readBlocks("quill", "alex");
      expect(ioStatuses(next)).toEqual(["read", "read"]);
    });

    // -----------------------------------------------------------------------
    // The cached list is handed back BY REFERENCE, so a caller that mutated it
    // in place would corrupt every later reader of that thread. The contract
    // was documented but unenforced, and it is now
    // frozen, and frozen on EVERY path so behaviour cannot depend on cache luck.
    // -----------------------------------------------------------------------

    it("refuses in-place mutation of the list it hands back, on a miss and on a hit alike", async () => {
      seed("quill", "alex", buildThread(4));

      const fromMiss = await repo.readBlocks("quill", "alex"); // parsed this call
      const fromHit = await repo.readBlocks("quill", "alex"); // served from memo
      expect(__blocksReadCount()).toBe(1); // the second really was a cache hit

      for (const list of [fromMiss, fromHit]) {
        expect(Object.isFrozen(list)).toBe(true);
        // Enforced at RUNTIME, not only by the `readonly` type: a sort/reverse
        // in a future caller throws at its own call site instead of silently
        // poisoning every subsequent hit for this file.
        const mutable = list as MessageBlock[];
        expect(() => mutable.reverse()).toThrow(TypeError);
        expect(() => mutable.push(mutable[0]!)).toThrow(TypeError);
      }

      // ... and the memo still serves the untouched parse afterwards.
      const after = await repo.readBlocks("quill", "alex");
      expect(after.map((b) => b.header.subject)).toEqual([
        "msg 0",
        "msg 1",
        "msg 2",
        "msg 3",
      ]);
      expect(__blocksReadCount()).toBe(1);
    });

    it("hands back a frozen list for a missing file too, not a mutable empty array", async () => {
      fs.mkdirSync(path.join(sandbox, "ghost", "inbox"), { recursive: true });
      const empty = await repo.readBlocks("ghost", "alex");
      expect(empty).toEqual([]);
      expect(Object.isFrozen(empty)).toBe(true);
    });

    // -----------------------------------------------------------------------
    // The atomicWrite card mutators (answerCard, markActionDone, supersede*,
    // ...) rewrite the whole file. The cache originally leaned on the stat
    // guard to notice them - an assumption, not a guarantee:
    // a card-state rewrite can be the same length, and
    // rename(2) lands an mtime that can fall inside the same coarse tick as a
    // concurrent reader's priming stat. They now invalidate explicitly, and
    // this pins that they do.
    // -----------------------------------------------------------------------

    it("reflects a card action's rewrite even when the stat guard cannot see the write", async () => {
      seed("quill", "alex", ACTION_THREAD);
      const file = threadFile("quill", "alex");

      // Prime the cache pre-action, as shell.tsx's sidebar sweep does.
      const primed = await repo.readBlocks("quill", "alex");
      expect(primed[0]!.rawMeta).not.toContain("done:");
      const primedStat = fs.statSync(file);

      const result = await repo.markActionDone("quill", "alex", "TASK-500-review");
      expect("markedDone" in result).toBe(true);

      // Blind the guard: every stat of THIS file now reports the PRE-write
      // (mtimeMs, size). That is exactly what the two real cases look like from
      // readBlocks' side - a same-length card rewrite, or a fresh mtime landing
      // inside the tick the priming stat was taken in. With the guard blind,
      // only markActionDone's own invalidation can keep the sidebar honest.
      const realStat = fs.promises.stat.bind(fs.promises);
      const spy = vi
        .spyOn(fs.promises, "stat")
        .mockImplementation((async (p: fs.PathLike) => {
          const st = await realStat(p);
          if (String(p) === file) {
            st.mtimeMs = primedStat.mtimeMs;
            st.size = primedStat.size;
          }
          return st;
        }) as unknown as typeof fs.promises.stat);

      const after = await repo.readBlocks("quill", "alex");
      spy.mockRestore();

      expect(after[0]!.rawMeta).toContain("done:");
    });
  });

  // -------------------------------------------------------------------------
  // 3. markRead fast-skip
  // -------------------------------------------------------------------------

  describe("markRead stat-gated fast-skip", () => {
    const TWO_UNREAD = `## 2026-06-07T18:00:00Z - from: quill - status: sent - subject: one

First inbound.

---
## 2026-06-07T18:05:00Z - from: alex - status: sent - subject: mine

The user's own - never flips.

---
## 2026-06-07T18:10:00Z - from: quill - status: sent - subject: two

Second inbound.

---
`;

    it("skips the lock+scan entirely when nothing changed since our last settle", async () => {
      seed("quill", "alex", TWO_UNREAD);

      const first = await repo.markRead("quill", "alex");
      expect(first).toBe(2);
      expect(__markReadScanCount()).toBe(1); // paid the full scan once

      const statBefore = fs.statSync(threadFile("quill", "alex"));
      const second = await repo.markRead("quill", "alex");
      expect(second).toBe(0);
      // Fast-skip: NO new scan, NO write.
      expect(__markReadScanCount()).toBe(1);
      const statAfter = fs.statSync(threadFile("quill", "alex"));
      expect(statAfter.mtimeMs).toBe(statBefore.mtimeMs);
    });

    it("falls through to a full scan when new content lands", async () => {
      seed("quill", "alex", TWO_UNREAD);
      await repo.markRead("quill", "alex");
      expect(__markReadScanCount()).toBe(1);

      // A new inbound DM appends (external writer): size + mtime change.
      fs.appendFileSync(
        threadFile("quill", "alex"),
        `## 2026-06-07T18:20:00Z - from: quill - status: sent - subject: three\n\nThird inbound.\n\n---\n`,
        "utf8"
      );

      const flipped = await repo.markRead("quill", "alex");
      expect(flipped).toBe(1); // only the new block was still sent
      expect(__markReadScanCount()).toBe(2); // did NOT fast-skip
      const raw = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      expect(raw).not.toContain("from: quill - status: sent");
    });

    it("the window cache sees markRead's byte-patch (stat changes) and reflects the flip", async () => {
      seed("quill", "alex", TWO_UNREAD);
      // Prime the window cache on the pre-flip file.
      const before = await repo.readBlocksWindow("quill", "alex", { limit: 30 });
      expect(
        before.blocks.filter((b) => b.header.from === "quill").map((b) => b.header.status)
      ).toEqual(["sent", "sent"]);

      await repo.markRead("quill", "alex");

      // markRead's write bumped mtime -> the window cache invalidates and the
      // next read shows the flipped state.
      const after = await repo.readBlocksWindow("quill", "alex", { limit: 30 });
      expect(
        after.blocks.filter((b) => b.header.from === "quill").map((b) => b.header.status)
      ).toEqual(["read", "read"]);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Byte-patch correctness
  // -------------------------------------------------------------------------

  describe("markRead byte-patch (edge cases)", () => {
    /**
     * Canonical multi-block fixture that exercises every edge named:
     *  - block 0: quill sent            -> flips
     *  - block 1: alex sent         -> own, never flips
     *  - block 2: quill read (+ emoji)  -> not flipped; multi-byte shifts later
     *                                   byte offsets, proving char->byte convert
     *  - block 3: quill sent, BODY holds "status: sent" / "status: read" lines
     *                                -> header flips, body must NOT be touched
     *  - block 4: quill working         -> not flipped
     *  - block 5: quill sent decision card (rawMeta) -> flips, meta survives
     *  - block 6: quill sent at EOF     -> flips (EOF boundary)
     */
    const FIXTURE = [
      `## 2026-06-07T18:00:00Z - from: quill - status: sent - subject: first\n\nFirst inbound.\n\n---\n`,
      `## 2026-06-07T18:05:00Z - from: alex - status: sent - subject: mine\n\nMy own reply.\n\n---\n`,
      `## 2026-06-07T18:10:00Z - from: quill - status: read - subject: emoji\n\nAlready read party time.\n\n---\n`,
      `## 2026-06-07T18:15:00Z - from: quill - status: sent - subject: trap\n\nDo not corrupt these body lines:\nstatus: sent should be preserved verbatim\nstatus: read as well\n\n---\n`,
      `## 2026-06-07T18:20:00Z - from: quill - status: working - subject: wip\nticket: TASK-700\n\nWorking state.\n\n---\n`,
      `## 2026-06-07T18:25:00Z - from: quill - status: sent - subject: card\ndecision-id: TEST-C\noptions:\n  - key: A\n    label: "Option A"\n    detail: "First."\nlean: "A"\n\nCard body - meta must survive the byte patch.\n\n---\n`,
      `## 2026-06-07T18:30:00Z - from: quill - status: sent - subject: last\n\nFinal inbound at EOF.\n\n---\n`,
    ].join("");

    // Inject a real multi-byte char into block 2's body so byte offsets of the
    // later flipped tokens diverge from their char indices.
    const RAW = FIXTURE.replace("party time", "party \u{1F389} time");

    it("fixture is canonical (parse->serialize round-trips byte-for-byte)", () => {
      const rebuilt =
        splitBlocks(RAW)
          .map((rb) => parseBlock(rb))
          .map((b) => serializeBlock(b))
          .join("\n") + "\n";
      expect(rebuilt).toBe(RAW);
    });

    it("flips every unread block, none skipped, none double-patched", async () => {
      seed("quill", "alex", RAW);
      const flipped = await repo.markRead("quill", "alex");
      // quill sent blocks: first, trap, card, last = 4. alex own + read + working excluded.
      expect(flipped).toBe(4);

      const raw = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      expect(raw).not.toContain("from: quill - status: sent");
      for (const subj of ["first", "trap", "card", "last"]) {
        expect(raw).toContain(`from: quill - status: read - subject: ${subj}`);
      }
    });

    it("flips the block at the very EOF boundary", async () => {
      seed("quill", "alex", RAW);
      await repo.markRead("quill", "alex");
      const raw = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      // Last block header (EOF) flipped; the file still ends exactly as before.
      expect(raw).toContain("from: quill - status: read - subject: last");
      expect(raw.endsWith("Final inbound at EOF.\n\n---\n")).toBe(true);
    });

    it("does NOT false-positive on 'status: sent' in a message body", async () => {
      seed("quill", "alex", RAW);
      await repo.markRead("quill", "alex");
      const raw = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      // The body lines are untouched - only the header status field flipped.
      expect(raw).toContain("status: sent should be preserved verbatim");
      expect(raw).toContain("status: read as well");
    });

    it("does NOT false-positive on 'status: sent' inside the 'from' field (peer-review catch)", async () => {
      // "from" comes BEFORE "status" in the header grammar, so an unanchored
      // /status:\s*sent/ search of the raw line would match INSIDE this from
      // value first - and verify-before-write would NOT catch it, because the
      // bytes there genuinely spell "sent" (just the wrong "sent"). The offset
      // must come from HEADER_RE's own status capture group, never a re-search.
      const trap =
        `## 2026-06-07T19:00:00Z - from: agent status: sent impersonator - status: sent - subject: trap2\n\nBody.\n\n---\n`;
      seed("quill", "alex", trap);

      const flipped = await repo.markRead("quill", "alex");
      expect(flipped).toBe(1);

      const raw = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      // The impostor text inside "from" is untouched, byte-for-byte.
      expect(raw).toContain("from: agent status: sent impersonator");
      // The REAL status field flipped.
      expect(raw).toContain("status: read - subject: trap2");
      // And parseHeader still reads it back as a single, correctly-attributed block.
      const reparsed = splitBlocks(raw).map((rb) => parseBlock(rb));
      expect(reparsed).toHaveLength(1);
      expect(reparsed[0]!.header.from).toBe("agent status: sent impersonator");
      expect(reparsed[0]!.header.status).toBe("read");
    });

    it("preserves rawMeta (decision card) through the flip", async () => {
      seed("quill", "alex", RAW);
      await repo.markRead("quill", "alex");
      const raw = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      expect(raw).toContain("decision-id: TEST-C");
      expect(raw).toContain('label: "Option A"');
      expect(raw).toContain('lean: "A"');
      expect(raw).toContain("ticket: TASK-700");
    });

    it("byte-identical to the old whole-file rewrite EXCEPT the flipped tokens", async () => {
      seed("quill", "alex", RAW);
      const returned = await repo.markRead("quill", "alex");

      const newOutput = fs.readFileSync(threadFile("quill", "alex"), "utf8");
      const { output: oldOutput, flipped } = oldRewrite(RAW, "alex");

      // (a) The byte-patch reproduces the old mechanism's output exactly.
      expect(newOutput).toBe(oldOutput);
      expect(returned).toBe(flipped);

      // (b) Full-file byte-diff vs the ORIGINAL: same byte length, and every
      //     differing byte lies inside a flipped 4-byte sent->read token.
      const rawBuf = Buffer.from(RAW, "utf8");
      const newBuf = Buffer.from(newOutput, "utf8");
      expect(newBuf.length).toBe(rawBuf.length);

      // Independently compute the expected flip token byte offsets from the
      // fixture headers (unique subjects -> unambiguous indexOf).
      const expectedOffsets: number[] = [];
      for (const subj of ["first", "trap", "card", "last"]) {
        const headerFrag = `- status: sent - subject: ${subj}`;
        const charIdx = RAW.indexOf(headerFrag) + "- status: ".length;
        expect(RAW.slice(charIdx, charIdx + 4)).toBe("sent");
        expectedOffsets.push(Buffer.byteLength(RAW.slice(0, charIdx), "utf8"));
      }
      expect(expectedOffsets).toHaveLength(4);

      // Every expected token flipped sent->read on disk.
      for (const off of expectedOffsets) {
        expect(rawBuf.subarray(off, off + 4).toString("utf8")).toBe("sent");
        expect(newBuf.subarray(off, off + 4).toString("utf8")).toBe("read");
      }

      // Every byte that differs is INSIDE one of those token windows - nothing
      // else in the 3.6MB-class file moved (bodies, meta, line endings intact).
      const inAToken = (i: number) =>
        expectedOffsets.some((off) => i >= off && i < off + 4);
      for (let i = 0; i < rawBuf.length; i++) {
        if (rawBuf[i] !== newBuf[i]) {
          expect(inAToken(i)).toBe(true);
        }
      }
    });
  });
});
