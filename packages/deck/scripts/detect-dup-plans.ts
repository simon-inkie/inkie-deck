#!/usr/bin/env tsx
/**
 * detect-dup-plans.ts - CLI: read a plan fixture JSON, report overlapping plans.
 *
 * Usage: tsx scripts/detect-dup-plans.ts [fixture-path]
 * Default fixture: fixtures/plans/plans-fixture.json
 *
 * Exit codes:
 *   0 = no overlaps found (clean)
 *   1 = overlaps found, or fixture unreadable, or malformed input
 *
 * Mirrors the check-dashes.mjs convention: no interactive input, stdout report,
 * exit non-zero on findings so the future AUTO-02 cron is a config change only.
 *
 * IO at the edge. The predicate (detectDupPlans) is pure;
 * all fixture reading lives here, not in the predicate.
 *
 * Pitfall 5: uses a RELATIVE import, not the ~/lib path alias.
 * tsx uses esbuild which does NOT resolve TypeScript path aliases at Node runtime.
 *
 * ASCII only - no em-dashes (check:dashes gate).
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { detectDupPlans } from "../app/lib/dup-plan-detect.js";
import type { ContentPlan } from "../app/lib/dup-plan-detect.js";

// ---------------------------------------------------------------------------
// Header banner (mirrors check-dashes.mjs style)
// ---------------------------------------------------------------------------

console.log("------------------------------------------");
console.log(" detect-dup-plans - overlapping plan check");
console.log("------------------------------------------");

// ---------------------------------------------------------------------------
// Fixture loading (IO at the edge per D-04)
// ---------------------------------------------------------------------------

const fixturePath = process.argv[2] ?? resolve("fixtures/plans/plans-fixture.json");

let raw: string;
try {
  raw = readFileSync(fixturePath, "utf8");
} catch (err) {
  console.error(`ERROR: Failed to read fixture file: ${fixturePath}`);
  console.error(String(err));
  process.exit(1);
}

let parsed: unknown;
try {
  parsed = JSON.parse(raw);
} catch (err) {
  console.error(`ERROR: Failed to parse fixture JSON from: ${fixturePath}`);
  console.error(String(err));
  process.exit(1);
}

// Defensive: must be an array
if (!Array.isArray(parsed)) {
  console.error(`ERROR: Fixture must be a JSON array of content plans, got: ${typeof parsed}`);
  process.exit(1);
}

const plans = parsed as ContentPlan[];

// ---------------------------------------------------------------------------
// Run the predicate (pure, no IO)
// ---------------------------------------------------------------------------

const overlaps = detectDupPlans(plans);

// ---------------------------------------------------------------------------
// Report results and exit
// ---------------------------------------------------------------------------

if (overlaps.length === 0) {
  console.log("No overlapping plans detected.");
  process.exit(0);
}

console.log(`Detected ${overlaps.length} overlapping plan pair(s):\n`);
for (const o of overlaps) {
  console.log(`  client:  ${o.client_id}`);
  console.log(`  plans:   ${o.plan_id_a}  <->  ${o.plan_id_b}`);
  console.log(`  overlap: ${o.overlap_description}`);
  console.log();
}
process.exit(1);
