/**
 * Concurrency stress test for the cross-process inbox lock.
 *
 * This is the property the whole locking mechanism exists to guarantee: when
 * several independent processes append to the SAME thread file at close to the
 * same instant, every message survives, none are lost, none are corrupted or
 * interleaved, and none are duplicated. A hasty port of the lock is the most
 * likely place for a subtle bug to hide (e.g. an off-by-one in the byte-offset
 * patch, or a race between "does the lock file exist" and "create it"), so
 * this deliberately spawns real OS subprocesses -- not worker threads in one
 * Node process -- to exercise the actual O_EXCL-based advisory lock the same
 * way a real CLI process and a real concurrent writer would.
 *
 * child_process.spawn (async) is the equivalent of Python's Popen here: it
 * returns immediately, so every worker is launched before any of them is
 * waited on and they genuinely race each other at the OS level. Using
 * spawnSync would serialise them and quietly turn this into no test at all.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "node:child_process";
import * as fs from "node:fs";

import * as inbox from "../bin/inbox.mts";
import {
  INBOX_PATH,
  baseEnv,
  makeTempDir,
  removeTempDir,
  seedBlock,
  threadFile,
  type Env,
} from "./helpers.ts";

const WORKER_COUNT = 30;

interface WorkerResult {
  index: number;
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Launch every command back-to-back without awaiting, then await them all. */
function raceWorkers(commands: string[][], env: Env): Promise<WorkerResult[]> {
  const pending = commands.map((args, index) => {
    const child = spawn(process.execPath, [INBOX_PATH, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return new Promise<WorkerResult>((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", reject);
      child.on("close", (code) => resolve({ index, code, stdout, stderr }));
    });
  });
  return Promise.all(pending);
}

describe("concurrent append lock", () => {
  let silo = "";

  beforeEach(() => {
    silo = makeTempDir();
  });

  afterEach(() => {
    removeTempDir(silo);
  });

  it("survives many concurrent replies intact", async () => {
    const env = baseEnv({ agentName: "alice", siloHome: silo });
    const filePath = threadFile(silo, "alice", "bob");

    const commands: string[][] = [];
    for (let i = 0; i < WORKER_COUNT; i += 1) {
      const marker = `WORKER-MARKER-${String(i).padStart(3, "0")}`;
      commands.push([
        "reply", "bob",
        "--subject", `concurrent ${i}`,
        "--body", `${marker} payload for worker ${i}`,
      ]);
    }

    const results = await raceWorkers(commands, env);

    const failures = results.filter((r) => r.code !== 0);
    expect(
      failures,
      `${failures.length} worker process(es) exited non-zero: ${JSON.stringify(failures)}`,
    ).toEqual([]);

    // No lock file should be left behind: every acquirer must release
    // (or have its stale lock cleanly stolen and removed) by the time all
    // processes have exited.
    expect(
      fs.existsSync(filePath + ".lock"),
      "a .lock file survived after all writers finished",
    ).toBe(false);

    const text = fs.readFileSync(filePath, "utf8");

    const blocks = inbox.parseBlocks(text);
    expect(
      blocks.length,
      `expected ${WORKER_COUNT} blocks, found ${blocks.length} -- ` +
        "a lost, merged, or duplicated write under contention",
    ).toBe(WORKER_COUNT);

    // Every header must parse cleanly (HEADER_RE match already required
    // by parseBlocks to produce a block at all) -- assert here too so a
    // future refactor that silently drops unparsed blocks doesn't hide a
    // corruption behind "fewer blocks than expected".
    const headerMatches = text.match(/^## /gm) ?? [];
    expect(
      headerMatches.length,
      "raw header-line count disagrees with parsed block count -- " +
        "suggests a corrupted/interleaved header",
    ).toBe(WORKER_COUNT);

    // Each worker's unique marker must appear in exactly one block body,
    // exactly once: proves no message was lost, split, or duplicated.
    const bodies = blocks.map((b) => b.body);
    const seenMarkers = new Set<string>();
    for (let i = 0; i < WORKER_COUNT; i += 1) {
      const marker = `WORKER-MARKER-${String(i).padStart(3, "0")}`;
      const hits = bodies.filter((body) => body.includes(marker));
      expect(
        hits.length,
        `marker ${marker} appeared in ${hits.length} blocks (expected exactly 1)`,
      ).toBe(1);
      expect(
        hits[0]!.split(marker).length - 1,
        `marker ${marker} appeared more than once within its own block body`,
      ).toBe(1);
      seenMarkers.add(marker);
    }
    expect(seenMarkers.size).toBe(WORKER_COUNT);

    // All blocks were sent by the same identity to the same thread, so
    // every single one must show sender "alice" and (post send-time
    // self-flip) status "sent" -- reply flips status for the OTHER
    // party's messages, not its own, so these all remain "sent".
    for (const b of blocks) {
      expect(b.sender).toBe("alice");
      expect(b.status).toBe("sent");
    }
  });

  it("survives concurrent appends plus concurrent reads without corruption", async () => {
    // A second, complementary scenario: half the workers append new
    // "incoming" messages (as bob, into alice's copy of the thread) while
    // the other half concurrently run `inbox read bob` as alice, which
    // both reads AND flips sent->read under the same lock. This exercises
    // the read-modify-write path (flipBlocksInFile), not just the pure
    // append path.
    const envAlice = baseEnv({ agentName: "alice", siloHome: silo });
    const filePath = threadFile(silo, "alice", "bob");

    // Seed some initial messages directly (as if bob had already written
    // them) so the readers have something to flip from the very start.
    for (let i = 0; i < 5; i += 1) {
      seedBlock(
        filePath,
        `2026-07-29T10:${String(i).padStart(2, "0")}:00Z`,
        "bob", "sent", `seed ${i}`, `seed body ${i}`,
      );
    }

    const commands: string[][] = [];
    for (let i = 0; i < 20; i += 1) {
      if (i % 2 === 0) {
        commands.push(["read", "bob"]);
      } else {
        const marker = `LATE-MARKER-${String(i).padStart(3, "0")}`;
        commands.push(["reply", "bob", "--subject", `late ${i}`, "--body", marker]);
      }
    }

    const results = await raceWorkers(commands, envAlice);
    const failures = results.filter((r) => r.code !== 0);
    expect(failures, `worker(s) exited non-zero: ${JSON.stringify(failures)}`).toEqual([]);

    const text = fs.readFileSync(filePath, "utf8");
    const blocks = inbox.parseBlocks(text);

    // 5 seeded + 10 "late" replies (odd i in range(20)) = 15 total.
    expect(blocks).toHaveLength(15);

    // None of the seeded bob->alice messages should still say "sent"
    // (some concurrent `read` must have flipped every one of them).
    const seeded = blocks.filter((b) => b.sender === "bob");
    expect(seeded).toHaveLength(5);
    for (const b of seeded) {
      expect(b.status).toBe("read");
    }

    // Every late marker survived exactly once.
    const bodies = blocks.map((b) => b.body);
    for (let i = 1; i < 20; i += 2) {
      const marker = `LATE-MARKER-${String(i).padStart(3, "0")}`;
      const hits = bodies.filter((body) => body.includes(marker));
      expect(hits.length, `${marker} appeared ${hits.length} times`).toBe(1);
    }
  });
});
