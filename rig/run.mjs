#!/usr/bin/env node
/**
 * The clean-machine rig.
 *
 * Runs a declared list of stages inside throwaway containers built from a
 * bare OS image, and writes one machine-readable report plus a human summary.
 * The point of the whole apparatus is a single negative property: it must be
 * incapable of reporting a green run against an environment where the product
 * is actually broken. Every structural decision in `rig/` is downstream of
 * that, and the reasoning for each lives next to the code that implements it.
 *
 * USAGE
 *   node rig/run.mjs                 run every declared stage
 *   node rig/run.mjs --self-test     prove the harness's own guards fire
 *                                    (no docker, no containers, seconds)
 *   node rig/run.mjs --allow-dirty   archive HEAD anyway, with the working
 *                                    tree dirty, and say so loudly in the
 *                                    report
 *   node rig/run.mjs --out DIR       write the report elsewhere
 *   node rig/run.mjs --keep          keep the build context (the source tar)
 *
 * EXIT CODES
 *   0  every declared stage ran, every probe green, every control proven
 *   1  PRODUCT failure: the product is broken in the measured environment
 *   2  RIG failure: a control did not go red, a stage did not run, or the
 *      harness itself broke. Nothing this run reported can be trusted.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { requireDocker } from "./lib/docker.mjs";
import { RigError } from "./lib/exec.mjs";
import { exitCodeFor, renderSummary, runDeclaredStages, STATUS, writeReport } from "./lib/harness.mjs";
import { STAGES } from "./stages/index.mjs";
import { selfTest } from "./self-test.mjs";

const RIG_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.dirname(RIG_DIR);

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes("--self-test")) {
    process.exit((await selfTest()) ? 0 : 2);
  }

  const options = {
    allowDirty: argv.includes("--allow-dirty"),
    keep: argv.includes("--keep"),
    outDir: valueOf(argv, "--out") ?? path.join(RIG_DIR, "out"),
  };

  // The harness's own guards are proven before the harness is used, the same
  // posture as `scripts/leak-gate.mjs --self-test`. A rig whose accounting is
  // broken would report a green run over a truncated stage list, so it is not
  // permitted to report anything until it has shown that it cannot.
  if (!(await selfTest({ quiet: true }))) {
    console.error("rig: the harness self-test failed; refusing to run. Details: node rig/run.mjs --self-test");
    process.exit(2);
  }

  const dockerVersion = requireDocker();
  const packageManager = JSON.parse(
    fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
  ).packageManager;

  const contextDir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "inkie-deck-rig-"));
  const startedAt = new Date().toISOString();
  const ctx = {
    repoRoot: REPO_ROOT,
    contextDir,
    allowDirty: options.allowDirty,
    packageManager,
    onStageComplete(result) {
      console.log(`[rig] ${result.status.padEnd(12)} ${result.id} (${(result.durationMs / 1000).toFixed(1)}s)`);
    },
  };

  let run;
  try {
    run = await runDeclaredStages(STAGES, ctx);
  } finally {
    if (!options.keep) fs.rmSync(contextDir, { recursive: true, force: true });
  }

  const report = {
    schema: "inkie-deck-rig/1",
    startedAt,
    finishedAt: new Date().toISOString(),
    host: { docker: dockerVersion, node: process.version },
    source: ctx.source ?? null,
    base: ctx.base ?? null,
    accounting: run.accounting,
    outcome: run.outcome,
    stages: run.stages,
  };
  const written = writeReport({ outDir: options.outDir, report });
  process.stdout.write(`\n${renderSummary(report)}\n`);
  console.log(`report: ${path.relative(REPO_ROOT, written.jsonPath)} and ${path.relative(REPO_ROOT, written.summaryPath)}`);
  if (run.outcome === STATUS.RIG_FAIL) {
    console.error(
      "\nRIG FAILURE. This is not a statement about the product: an instrument did not " +
        "prove itself, or a declared stage did not run, so every green result above is " +
        "unsupported. Fix the rig before reading anything else.",
    );
  }
  process.exit(exitCodeFor(run.outcome));
}

function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

main().catch((error) => {
  console.error(error instanceof RigError ? `rig: ${error.message}` : error);
  process.exit(2);
});
