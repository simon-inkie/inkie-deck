import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireOwnerLock,
  checkFilesystemSafety,
  isOwnerLocked,
  resolveProjectDataDir,
  RunnerLockBusyError,
  UnsafeFilesystemError,
} from "../../app/lib/flows/owner.server.js";

describe("Owner Lock & Filesystem Safety (owner.server.ts)", () => {
  let scratchDir: string;
  const projectId = "test-owner-project";

  beforeEach(() => {
    scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-owner-"));
  });

  afterEach(() => {
    if (scratchDir && fs.existsSync(scratchDir)) {
      fs.rmSync(scratchDir, { recursive: true, force: true });
    }
  });

  it("acquires and releases SQLite exclusive lock cleanly with 0700 dir and 0600 lock file", () => {
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);

    const lock = acquireOwnerLock(projectId, scratchDir);
    expect(isOwnerLocked(projectId, scratchDir)).toBe(true);

    const dirMode = fs.statSync(path.dirname(lock.lockPath)).mode & 0o777;
    const fileMode = fs.statSync(lock.lockPath).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);

    lock.release();
    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);
    // Lock file stays on disk (never unlinked)
    expect(fs.existsSync(lock.lockPath)).toBe(true);
  });

  it("refuses second runner in-process with RunnerLockBusyError", () => {
    const lock1 = acquireOwnerLock(projectId, scratchDir);
    try {
      expect(() => {
        acquireOwnerLock(projectId, scratchDir);
      }).toThrow(RunnerLockBusyError);
    } finally {
      lock1.release();
    }
  });

  it("Critical 1: refusing a second same-process runner preserves the active kernel lock against separate OS processes", () => {
    const lock1 = acquireOwnerLock(projectId, scratchDir);
    try {
      // Trigger same-process refusal FIRST; closing any raw fd here would drop POSIX fcntl locks on Linux
      expect(() => {
        acquireOwnerLock(projectId, scratchDir);
      }).toThrow(RunnerLockBusyError);

      // Separate OS process MUST STILL see SQLITE_BUSY on flows.owner after same-process refusal
      const lockPath = path.resolve(scratchDir, "flows", projectId, "flows.owner");
      const childScript = `
        const Database = require("better-sqlite3");
        const db = new Database(${JSON.stringify(lockPath)}, { timeout: 50 });
        try {
          db.pragma("locking_mode = EXCLUSIVE");
          db.pragma("busy_timeout = 50");
          db.exec("BEGIN EXCLUSIVE;");
          process.exit(0);
        } catch (err) {
          if (err.code === "SQLITE_BUSY" || err.code === "SQLITE_LOCKED") {
            process.exit(42);
          }
          process.exit(1);
        }
      `;
      const result = spawnSync(process.execPath, ["-e", childScript], {
        cwd: path.resolve(__dirname, "../.."),
        encoding: "utf8",
      });
      expect(result.status).toBe(42);
    } finally {
      lock1.release();
    }
  });

  it("automatically releases lock via OS kernel when holder process is killed with SIGKILL", async () => {
    const latchFile = path.resolve(scratchDir, "lock.latch");
    const lockPath = path.resolve(scratchDir, "flows", projectId, "flows.owner");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });

    const childScript = `
      const fs = require("node:fs");
      const Database = require("better-sqlite3");
      const db = new Database(${JSON.stringify(lockPath)});
      db.pragma("locking_mode = EXCLUSIVE");
      db.exec("BEGIN EXCLUSIVE;");
      fs.writeFileSync(${JSON.stringify(latchFile)}, "LOCKED");
      setInterval(() => {}, 1000);
    `;

    const child = spawn(process.execPath, ["-e", childScript], {
      cwd: path.resolve(__dirname, "../.."),
      stdio: "ignore",
    });

    const exitPromise = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit) => {
      child.once("exit", (code, signal) => resolveExit({ code, signal }));
    });

    const start = Date.now();
    while (!fs.existsSync(latchFile) && Date.now() - start < 3000) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fs.existsSync(latchFile)).toBe(true);
    expect(isOwnerLocked(projectId, scratchDir)).toBe(true);

    child.kill("SIGKILL");
    const exit = await exitPromise;
    expect(exit.signal).toBe("SIGKILL");

    expect(isOwnerLocked(projectId, scratchDir)).toBe(false);
  });

  it("Major 4: rejects projectId path traversal, git worktrees, and ancestor symlinks", () => {
    expect(() => resolveProjectDataDir("../escape", scratchDir)).toThrow(/Invalid flow projectId/);
    expect(() => resolveProjectDataDir("a/b", scratchDir)).toThrow(/Invalid flow projectId/);

    // Git worktree refusal: this test directory is inside the deck git repository
    expect(() => resolveProjectDataDir(projectId, __dirname)).toThrow(UnsafeFilesystemError);

    // Ancestor symlink escape refusal
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "deck-flows-outside-"));
    try {
      const flowsRoot = path.join(scratchDir, "flows");
      fs.mkdirSync(flowsRoot, { recursive: true });
      fs.symlinkSync(outsideDir, path.join(flowsRoot, "sym-proj"));
      expect(() => resolveProjectDataDir("sym-proj", scratchDir)).toThrow(/Symlink component forbidden/);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });

  it("Major 5 & 6 + Critical 2: refuses WSL /mnt/c, virtiofs, unreadable mountinfo, non-Linux platforms, and hard-linked flows.owner", () => {
    expect(() => {
      checkFilesystemSafety("/mnt/c/repos/project", { allowGitWorktree: true });
    }).toThrow(UnsafeFilesystemError);

    // Non-Linux platforms fail closed in Slice 1a (including local darwin/win32 paths)
    expect(() => {
      checkFilesystemSafety("/tmp/local-data", { allowGitWorktree: true, platformOverride: "darwin" });
    }).toThrow(UnsafeFilesystemError);
    expect(() => {
      checkFilesystemSafety("C:\\Users\\example\\data", { allowGitWorktree: true, platformOverride: "win32" });
    }).toThrow(UnsafeFilesystemError);

    // Mock mountinfo with a virtiofs mount covering scratchDir
    const fakeMountinfo = path.join(scratchDir, "fake-mountinfo");
    const realScratch = fs.realpathSync(scratchDir);
    fs.writeFileSync(
      fakeMountinfo,
      `36 35 98:0 / / rw,noatime - ext4 /dev/root rw\n99 36 0:50 / ${realScratch} rw - virtiofs hostshare rw\n`,
    );
    expect(() => {
      checkFilesystemSafety(path.join(scratchDir, "flows", "proj"), { mountinfoPath: fakeMountinfo });
    }).toThrow(UnsafeFilesystemError);

    // Fail CLOSED when mountinfo is missing/unreadable
    expect(() => {
      checkFilesystemSafety(path.join(scratchDir, "flows", "proj"), {
        mountinfoPath: path.join(scratchDir, "nonexistent-mountinfo"),
      });
    }).toThrow(UnsafeFilesystemError);

    // Critical 2: Hard-linked flows.owner (st_nlink > 1) MUST be refused BEFORE SQLite opens or chmods it
    const decoyPath = path.join(scratchDir, "decoy-owner-target");
    fs.writeFileSync(decoyPath, "", { mode: 0o644 });
    fs.chmodSync(decoyPath, 0o644);
    const hlProjDir = path.join(scratchDir, "flows", "hl-owner-proj");
    fs.mkdirSync(hlProjDir, { recursive: true, mode: 0o700 });
    fs.linkSync(decoyPath, path.join(hlProjDir, "flows.owner"));

    expect(() => acquireOwnerLock("hl-owner-proj", scratchDir)).toThrow(/Hard-linked file forbidden/);
    expect(fs.statSync(decoyPath).mode & 0o777).toBe(0o644);
  });
});
