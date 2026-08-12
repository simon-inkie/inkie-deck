/**
 * Test helper utilities for creating isolated temp directories.
 * Available via the ~/* alias: import { mkdtempSync } from "~/lib/test-helpers"
 * This module is test-only; do not import from production app code.
 */
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

/**
 * Create an isolated temp directory under os.tmpdir().
 * Returns the real path (symlinks resolved) suitable for use as INBOX_ROOT.
 */
export function mkdtempSync(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mc-test-"));
  return fs.realpathSync(dir);
}

/**
 * Remove a directory created by mkdtempSync().
 * Safe to call in afterEach / afterAll cleanup.
 */
export function rmSync(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}
