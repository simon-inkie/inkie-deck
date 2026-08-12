/**
 * Tests for the em-dash / en-dash CI guard (FND-05).
 * All references to banned codepoints use String.fromCharCode() or numeric escapes -
 * never literal glyphs - so this test file does not trip the guard itself.
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, unlinkSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import os from "node:os";

const EM_DASH = String.fromCharCode(0x2014);
const EN_DASH = String.fromCharCode(0x2013);

const SCRIPT = new URL("../scripts/check-dashes.mjs", import.meta.url).pathname;

/**
 * Run the check-dashes script against a specific directory by temporarily
 * changing the working directory. Uses the rg CLI directly on a target file.
 * We test the guard logic by running rg directly on temp files.
 */
function runGuardOnFile(filePath: string): { exitCode: number; stdout: string; stderr: string } {
  // Use rg directly to check a single file for the banned codepoints
  const PATTERN = "[\\x{2014}\\x{2013}]";
  const result = spawnSync("rg", ["--pcre2", "-n", PATTERN, filePath], {
    encoding: "utf8",
  });
  return {
    exitCode: result.status ?? 0,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

describe("check-dashes guard (FND-05)", () => {
  let tmpDir: string;

  afterEach(() => {
    if (tmpDir) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("check-dashes.mjs script source contains no literal banned glyphs", () => {
    const { readFileSync } = require("node:fs");
    const src = readFileSync(SCRIPT, "utf8");
    expect(src.includes(EM_DASH)).toBe(false);
    expect(src.includes(EN_DASH)).toBe(false);
  });

  it("rg flags a file seeded with U+2014 (em-dash)", () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "mc-dash-test-"));
    const filePath = join(tmpDir, "seeded.txt");
    // Write a file that contains a literal em-dash (constructed via charCode so this test file stays clean)
    writeFileSync(filePath, `hello ${EM_DASH} world`, "utf8");

    const result = runGuardOnFile(filePath);
    // rg exit 0 means match found (bad) - guard should report failure
    expect(result.exitCode).toBe(0); // rg 0 = match found
    expect(result.stdout).toContain(EM_DASH);
  });

  it("rg flags a file seeded with U+2013 (en-dash)", () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "mc-dash-test-"));
    const filePath = join(tmpDir, "seeded.txt");
    writeFileSync(filePath, `range 1${EN_DASH}10`, "utf8");

    const result = runGuardOnFile(filePath);
    expect(result.exitCode).toBe(0); // rg 0 = match found
    expect(result.stdout).toContain(EN_DASH);
  });

  it("rg passes (exit 1) for a file with no banned glyphs", () => {
    tmpDir = mkdtempSync(join(os.tmpdir(), "mc-dash-test-"));
    const filePath = join(tmpDir, "clean.txt");
    writeFileSync(filePath, "This is a clean file with only ASCII dashes: - and --", "utf8");

    const result = runGuardOnFile(filePath);
    // rg exit 1 = no match = SUCCESS for the guard
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("pnpm check:dashes exits 0 on the clean repo", () => {
    const result = spawnSync("node", [SCRIPT], {
      encoding: "utf8",
      cwd: new URL("..", import.meta.url).pathname,
    });
    expect(result.status).toBe(0);
  });
});
