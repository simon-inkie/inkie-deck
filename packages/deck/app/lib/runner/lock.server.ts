import { spawnSync } from "node:child_process";
import {
  closeSync, constants, fstatSync, ftruncateSync, lstatSync, openSync,
  readFileSync, unlinkSync, writeSync,
} from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { signalGroup } from "./runner.js";

interface LockRecord {
  deckPid: number;
  deckBirth: string;
  childPid: number | null;
  childBirth: string | null;
  bootId: string;
  sessionId: string;
  startedAt: number;
  phase?: "reserved" | "spawning";
}

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function hasCode(error: unknown, code: string): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

function bootId(): string {
  return readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
}

function processInfo(pid: number) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    return { state: fields[0], group: Number(fields[2]), session: Number(fields[3]), birth: fields[19] };
  } catch (error) {
    if (!hasCode(error, "ENOENT") && !hasCode(error, "ESRCH")) throw error;
    return undefined;
  }
}

function live(state: string | undefined): boolean {
  return state !== "Z" && state !== "X";
}

function groupExists(group: number): boolean {
  try {
    process.kill(-group, 0);
    return true;
  } catch (error) {
    if (hasCode(error, "ESRCH")) return false;
    throw error;
  }
}

async function waitForGroupExit(group: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt++) {
    if (!groupExists(group)) return;
    await delay(20);
  }
  throw new Error("The PTY process group did not stop.");
}

function sameLock(file: string, owned: { dev: number; ino: number }): boolean {
  const current = lstatSync(file, { throwIfNoEntry: false });
  return current?.dev === owned.dev && current.ino === owned.ino;
}

export function claimRunnerLock(file: string, sessionId: string, startedAt: number) {
  const deckBirth = processInfo(process.pid)?.birth;
  if (!deckBirth) throw new Error("Could not identify the Deck process.");
  const record: LockRecord = {
    deckPid: process.pid, deckBirth, childPid: null, childBirth: null,
    bootId: bootId(), sessionId, startedAt, phase: "reserved",
  };
  const fd = openSync(file, "wx", 0o600);
  const owned = fstatSync(fd);

  function persist() {
    const bytes = Buffer.from(JSON.stringify(record) + "\n");
    if (writeSync(fd, bytes, 0, bytes.length, 0) !== bytes.length) {
      throw new Error("Could not write the runner lock.");
    }
    ftruncateSync(fd, bytes.length);
  }

  function unlinkOwned() {
    if (!lstatSync(file, { throwIfNoEntry: false })) return;
    if (!sameLock(file, owned)) throw new Error("The runner lock changed owners.");
    unlinkSync(file);
  }

  try {
    persist();
  } catch (error) {
    try {
      unlinkOwned();
    } finally {
      closeSync(fd);
    }
    throw error;
  }

  return {
    beforeSpawn() {
      const previousPhase = record.phase;
      record.phase = "spawning";
      try {
        persist();
      } catch (error) {
        record.phase = previousPhase;
        throw error;
      }
    },
    spawned(pid: number) {
      record.childPid = pid;
      record.childBirth = processInfo(pid)?.birth ?? null;
      persist();
      if (record.childBirth === null) throw new Error("Could not identify the PTY child.");
    },
    async release() {
      if (record.childPid !== null) {
        await waitForGroupExit(record.childPid);
      } else if (record.phase !== "reserved") {
        throw new Error("The PTY child was not recorded.");
      }
      unlinkOwned();
      closeSync(fd);
    },
    retain() { closeSync(fd); },
  };
}

function validPid(pid: unknown): pid is number {
  return typeof pid === "number" && Number.isInteger(pid) && pid > 1 && pid <= 0x7fffffff;
}

function readLock(fd: number): LockRecord {
  const stat = fstatSync(fd);
  if (!stat.isFile() || stat.size > 4096 || stat.uid !== process.getuid?.() || (stat.mode & 0o022) !== 0) {
    throw new Error("Invalid runner lock.");
  }
  const record = JSON.parse(readFileSync(fd, "utf8")) as Partial<LockRecord> | null;
  if (!record || !validPid(record.deckPid) ||
      !(record.childPid === null || validPid(record.childPid)) ||
      typeof record.deckBirth !== "string" || !/^\d+$/.test(record.deckBirth) ||
      !(record.childBirth === null || (typeof record.childBirth === "string" && /^\d+$/.test(record.childBirth))) ||
      typeof record.bootId !== "string" || !uuid.test(record.bootId) ||
      typeof record.sessionId !== "string" || !uuid.test(record.sessionId) ||
      !(record.phase === undefined || record.phase === "spawning" ||
        (record.phase === "reserved" && record.childPid === null && record.childBirth === null)) ||
      !Number.isSafeInteger(record.startedAt)) {
    throw new Error("Invalid runner lock.");
  }
  return record as LockRecord;
}

export async function recoverRunnerLock(file: string): Promise<"absent" | "recovered" | "unrecovered"> {
  let fd: number;
  try {
    fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (error) {
    if (hasCode(error, "ENOENT")) return "absent";
    throw error;
  }
  try {
    const guard = spawnSync("flock", ["-n", "3"], {
      env: { PATH: "/usr/bin:/bin" }, stdio: ["ignore", "ignore", "ignore", fd], timeout: 1_000,
    });
    if (guard.error || guard.status !== 0) {
      throw new Error("Could not lock the runner claim for recovery.", { cause: guard.error });
    }
    const owned = fstatSync(fd);
    if (!sameLock(file, owned)) return "unrecovered";
    const record = readLock(fd);
    if (record.bootId === bootId()) {
      const deck = processInfo(record.deckPid);
      if (deck?.birth === record.deckBirth && live(deck.state)) return "unrecovered";
      if (record.phase !== "reserved") {
        if (record.childPid === null) throw new Error("The PTY child was not recorded.");
        const group = record.childPid;
        if (groupExists(group)) {
          const leader = processInfo(group);
          if (!leader || leader.birth !== record.childBirth || leader.group !== group || leader.session !== group) {
            throw new Error("Could not verify the stale PTY process group.");
          }
          signalGroup(group, "SIGKILL");
        } else {
          const child = processInfo(group);
          if (child && live(child.state) && (record.childBirth === null || child.birth === record.childBirth)) {
            throw new Error("The PTY child is still alive outside its expected group.");
          }
        }
        await waitForGroupExit(group);
      }
    }
    if (!sameLock(file, owned)) return "unrecovered";
    unlinkSync(file);
    return "recovered";
  } finally {
    closeSync(fd);
  }
}
