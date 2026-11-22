import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, ftruncateSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimRunnerLock, recoverRunnerLock } from "../../app/lib/runner/lock.server.js";

vi.mock("node:fs", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs")>();
  return { ...fs, ftruncateSync: vi.fn(fs.ftruncateSync), readFileSync: vi.fn(fs.readFileSync) };
});

const sessionId = "01234567-89ab-4cde-8fab-0123456789ab";
const lockModule = new URL("../../app/lib/runner/lock.server.ts", import.meta.url).href;
const fixtureEnv = { PATH: "/usr/bin:/bin" };
const readFile = vi.mocked(readFileSync).getMockImplementation()!;
const statText = (pid: number, group: number, session: number, birth: string) =>
  `${pid} (fixture) S 1 ${group} ${session} ${"0 ".repeat(15)}${birth} 0\n`;
let home: string;
let file: string;

describe.runIf(process.platform === "linux")("runner lock recovery", () => {
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "deck-lock-"));
    file = join(home, ".runner.lock");
  });

  afterEach(() => {
    vi.mocked(readFileSync).mockReset();
    vi.restoreAllMocks();
    rmSync(home, { force: true, recursive: true });
  });

  function crashClaim(phase: "reserved" | "spawning") {
    const deck = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", `
      import { claimRunnerLock } from ${JSON.stringify(lockModule)};
      const [file, sessionId, phase] = process.argv.slice(1);
      const claim = claimRunnerLock(file, sessionId, Date.now());
      if (phase === "spawning") claim.beforeSpawn();
      process.kill(process.pid, "SIGKILL");
    `, file, sessionId, phase], { env: fixtureEnv, encoding: "utf8", timeout: 3_000 });
    expect(deck.signal, deck.stderr).toBe("SIGKILL");
    expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ phase, childPid: null });
  }

  it("does not trust an empty process listing when the kernel still sees a group", async () => {
    const group = 0x7fffffff;
    writeFileSync(file, JSON.stringify({
      deckPid: process.pid, deckBirth: "0", childPid: group, childBirth: "0",
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), sessionId, startedAt: Date.now(),
    }));
    const realKill = process.kill.bind(process);
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) =>
      pid === -group ? true : realKill(pid, signal));
    try {
      await expect(recoverRunnerLock(file)).rejects.toThrow("Could not verify the stale PTY process group.");
      expect(kill.mock.calls.filter(([pid]) => pid === -group)).toEqual([[-group, 0]]);
      expect(existsSync(file)).toBe(true);
    } finally {
      kill.mockRestore();
    }
  });

  it("rechecks the reservation after its owner updates the same inode and dies", async () => {
    const deckPid = 0x7fffffff;
    const childPid = deckPid - 1;
    const reservation = {
      deckPid, deckBirth: "1", childPid: null, childBirth: null, phase: "reserved",
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), sessionId, startedAt: Date.now(),
    };
    writeFileSync(file, JSON.stringify(reservation));
    const inode = statSync(file).ino;
    const spawned = JSON.stringify({ ...reservation, childPid, childBirth: "2", phase: "spawning" });
    vi.mocked(readFileSync).mockImplementation((path, options) => {
      if (path === `/proc/${deckPid}/stat`) {
        writeFileSync(file, spawned);
        throw Object.assign(new Error("Deck exited"), { code: "ENOENT" });
      }
      if (path === `/proc/${childPid}/stat`) return statText(childPid, childPid, childPid, "2");
      return readFile(path, options);
    });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);

    await expect(recoverRunnerLock(file)).rejects.toThrow("The PTY process group did not stop.");
    expect(kill).toHaveBeenCalledWith(-childPid, "SIGKILL");
    expect(statSync(file).ino).toBe(inode);
    expect(readFileSync(file, "utf8")).toBe(spawned);
  });

  it.each([
    { name: "matching members", otherSession: false, otherToken: false, verified: true },
    { name: "a different session", otherSession: true, otherToken: false, verified: false },
    { name: "a different session UUID", otherSession: false, otherToken: true, verified: false },
  ])("recovers a leaderless group only with matching members ($name)", async ({ otherSession, otherToken, verified }) => {
    const group = 0x7fffffff;
    const member = process.pid;
    const secondMember = process.ppid;
    writeFileSync(file, JSON.stringify({
      deckPid: member, deckBirth: "0", childPid: group, childBirth: "1",
      bootId: readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(), sessionId, startedAt: Date.now(),
    }));
    vi.mocked(readFileSync).mockImplementation((path, options) => {
      if (path === `/proc/${member}/stat`) return statText(member, group, group, "2");
      if (path === `/proc/${secondMember}/stat`) return statText(secondMember, group, otherSession ? 1 : group, "3");
      if (path === `/proc/${member}/environ`) return `DECK_PTY_SESSION_ID=${sessionId}\0`;
      if (path === `/proc/${secondMember}/environ`) return `DECK_PTY_SESSION_ID=${otherToken ? "different" : sessionId}\0`;
      return readFile(path, options);
    });
    let groupAlive = true;
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      expect(pid).toBe(-group);
      if (!groupAlive) throw Object.assign(new Error("Group exited"), { code: "ESRCH" });
      if (signal === "SIGKILL") groupAlive = false;
      return true;
    });

    if (verified) {
      await expect(recoverRunnerLock(file)).resolves.toBe("recovered");
      expect(kill.mock.calls).toEqual([[-group, 0], [-group, "SIGKILL"], [-group, 0]]);
      expect(existsSync(file)).toBe(false);
    } else {
      await expect(recoverRunnerLock(file)).rejects.toThrow("Could not verify the stale PTY process group.");
      expect(kill.mock.calls).toEqual([[-group, 0]]);
      expect(existsSync(file)).toBe(true);
    }
  });

  it("refuses a competing recoverer and releases the mutex after its owner is killed", async () => {
    crashClaim("reserved");
    writeFileSync(`${file}.recovery`, "");
    const ready = join(home, "recovery-ready");
    const holder = spawn(process.execPath, ["-e", `
      const { openSync, writeFileSync } = require("node:fs");
      const fd = openSync(process.argv[1], "r");
      const result = require("node:child_process").spawnSync("flock", ["-n", "3"], {
        stdio: ["ignore", "ignore", "ignore", fd], timeout: 1000,
      });
      if (result.status !== 0) process.exit(1);
      writeFileSync(process.argv[2], "ready");
      setInterval(() => {}, 1000);
    `, file, ready], { env: fixtureEnv, stdio: "ignore" });
    const exited = once(holder, "exit");
    try {
      await vi.waitFor(() => expect(existsSync(ready)).toBe(true));
      await expect(recoverRunnerLock(file)).rejects.toThrow("Could not lock the runner claim for recovery.");
      expect(existsSync(file)).toBe(true);
    } finally {
      holder.kill("SIGKILL");
      await exited;
    }
    await expect(recoverRunnerLock(file)).resolves.toBe("recovered");
    expect(existsSync(file)).toBe(false);
  });

  it("releases its reservation after a failed pre-spawn update", async () => {
    const claim = claimRunnerLock(file, sessionId, Date.now());
    const failure = new Error("Could not truncate the runner lock.");
    vi.mocked(ftruncateSync).mockImplementationOnce(() => { throw failure; });
    try {
      expect(() => claim.beforeSpawn()).toThrow(failure);
      expect(JSON.parse(readFileSync(file, "utf8"))).toMatchObject({ phase: "spawning", childPid: null });
      await claim.release();
    } finally {
      if (existsSync(file)) claim.retain();
    }
    expect(existsSync(file)).toBe(false);
  });

  it("treats an externally removed claim as released", async () => {
    const claim = claimRunnerLock(file, sessionId, Date.now());
    rmSync(file);
    await expect(claim.release()).resolves.toBeUndefined();
    expect(existsSync(file)).toBe(false);
  });

  it("reclaims a dead Deck's pre-spawn reservation but not a missing PID after the spawn boundary", async () => {
    crashClaim("reserved");
    await expect(recoverRunnerLock(file)).resolves.toBe("recovered");
    expect(existsSync(file)).toBe(false);

    crashClaim("spawning");
    await expect(recoverRunnerLock(file)).rejects.toThrow("The PTY child was not recorded.");
    expect(existsSync(file)).toBe(true);
  });
});
