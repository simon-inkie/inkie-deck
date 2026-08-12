#!/usr/bin/env node
/**
 * CI guard: fail the build if any tracked file contains U+2014 (em-dash) or U+2013 (en-dash).
 * Uses ripgrep (rg) with --pcre2 for exact codepoint matching.
 *
 * Exit codes:
 *   0 = no banned glyphs found (clean)
 *   1 = banned glyph found, or rg emitted stdout on error
 *   throws = rg binary missing or real rg error (exit code 2)
 *
 * The pattern uses \x{} escapes so this source file never trips the guard itself.
 * Codepoints: U+2014 (em-dash), U+2013 (en-dash)
 */
import { execFileSync } from "node:child_process";

const PATTERN = "[\\x{2014}\\x{2013}]";

try {
  const out = execFileSync(
    "rg",
    [
      "--pcre2",
      "-n",
      PATTERN,
      "--glob", "!node_modules",
      "--glob", "!build",
      "--glob", "!.git",
      "--glob", "!.react-router",
    ],
    { encoding: "utf8" }
  );
  // rg exit 0: match found -> that is BAD for us
  if (out.trim()) {
    console.error("Banned dash found:\n" + out);
    process.exit(1);
  }
} catch (e) {
  // rg exits 1 when NO matches -> that is SUCCESS for us
  if (e.status === 1 && !e.stdout) {
    process.exit(0);
  }
  // rg produced stdout (matches found) on non-zero exit
  if (e.stdout) {
    console.error("Banned dash found:\n" + e.stdout);
    process.exit(1);
  }
  // rg exit 2 or missing binary: real error, re-throw
  throw e;
}
