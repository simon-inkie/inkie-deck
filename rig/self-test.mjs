/**
 * The rig's self-test: prove the harness's own guards fire, before the
 * harness is allowed to make a claim about anything else.
 *
 * Same posture as `scripts/leak-gate.mjs --self-test`, and for the same
 * reason. The gate's problem was a denylist rule that could rot into never
 * matching, and report the resulting silence as a clean scan. This harness's
 * equivalent is worse: its accounting, its two-kinds-of-failure rule and its
 * missing-binary handling are all code that only executes when something has
 * already gone wrong, so on a healthy run none of it is exercised at all. An
 * untested guard on the failure path is not a guard.
 *
 * No docker, no containers, no network: these are decisions, tested as
 * decisions, in about a second.
 */
import { control, probe } from "./lib/harness.mjs";
import {
  accountFor,
  classifyStage,
  exitCodeFor,
  overallOutcome,
  runDeclaredStages,
  STATUS,
} from "./lib/harness.mjs";
import { exec, must, stripAnsi } from "./lib/exec.mjs";
import { contaminatedEntries, dirtyTreeDecision } from "./lib/source.mjs";
import { versionAtLeast } from "./lib/version.mjs";
import { parseExitCodes, parseSuiteCounts } from "./stages/03-documented-checks.mjs";

const ABSENT = "rig-self-test-absent-binary";

/** @param {{ quiet?: boolean }} [options] */
export async function selfTest(options = {}) {
  const failures = [];
  let checks = 0;
  /** @param {string} label @param {boolean} condition @param {unknown} [observed] */
  const assert = (label, condition, observed) => {
    checks += 1;
    if (!condition) failures.push(`${label}${observed === undefined ? "" : ` (observed: ${JSON.stringify(observed)})`}`);
  };

  // -- the missing-binary trap ----------------------------------------------
  // The shape this repository has already been bitten by: a spawn that never
  // ran, scored as an exit code of 0.
  const missing = exec(ABSENT, ["--version"]);
  assert("a missing binary yields a null status", missing.status === null, missing.status);
  assert("a missing binary is not ok", missing.ok === false);
  assert("a missing binary is flagged as a spawn failure", missing.spawnFailed === true);
  const zero = exec("sh", ["-c", "exit 0"]);
  const three = exec("sh", ["-c", "exit 3"]);
  assert("a real zero exit is ok", zero.ok === true && zero.status === 0);
  assert("a real non-zero exit is not ok", three.ok === false && three.status === 3, three.status);
  let threw = false;
  try {
    must(ABSENT, []);
  } catch {
    threw = true;
  }
  assert("must() throws when its dependency is absent", threw);

  // -- completeness accounting ----------------------------------------------
  const declared = [
    { id: "a", title: "a", run: async () => ({}) },
    { id: "b", title: "b", run: async () => ({}) },
    { id: "c", title: "c", run: async () => ({}) },
  ];
  const short = accountFor(declared, new Map([["a", {}], ["b", {}]]));
  assert("a stage that did not run breaks the accounting", short.ok === false, short);
  assert("the missing stage is named", short.missing.includes("c"), short.missing);
  assert("N comes from the declaration, not from what ran", short.declared === 3 && short.executed === 2, short);
  const undeclared = accountFor(declared, new Map([["a", {}], ["b", {}], ["c", {}], ["surprise", {}]]));
  assert("a result for an undeclared stage breaks the accounting", undeclared.ok === false, undeclared);
  const whole = accountFor(declared, new Map([["a", {}], ["b", {}], ["c", {}]]));
  assert("a complete run accounts", whole.ok === true && whole.declared === whole.executed);

  // -- product failure is not rig failure -----------------------------------
  const provenControl = control({ id: "x", title: "x", expectation: "y", satisfied: true, observed: "" });
  const brokenControl = control({ id: "x", title: "x", expectation: "y", satisfied: false, observed: "" });
  assert(
    "a green stage passes",
    classifyStage({ probes: [probe({ id: "p", title: "p", ok: true })], controls: [provenControl], error: null }) === STATUS.PASS,
  );
  assert(
    "a red probe is a PRODUCT failure",
    classifyStage({ probes: [probe({ id: "p", title: "p", ok: false })], controls: [provenControl], error: null }) === STATUS.PRODUCT_FAIL,
  );
  assert(
    "a control that did not go red is a RIG failure, even with every probe green",
    classifyStage({ probes: [probe({ id: "p", title: "p", ok: true })], controls: [brokenControl], error: null }) === STATUS.RIG_FAIL,
  );
  assert(
    "a stage with no negative control at all is a RIG failure",
    classifyStage({ probes: [probe({ id: "p", title: "p", ok: true })], controls: [], error: null }) === STATUS.RIG_FAIL,
  );
  assert(
    "a finding-severity probe does not fail the stage",
    classifyStage({
      probes: [probe({ id: "p", title: "p", ok: false, severity: "finding" })],
      controls: [provenControl],
      error: null,
    }) === STATUS.PASS,
  );
  assert(
    "a stage that threw is a RIG failure",
    classifyStage({ probes: [], controls: [provenControl], error: "boom" }) === STATUS.RIG_FAIL,
  );
  assert(
    "the two failure kinds have different exit codes",
    exitCodeFor(STATUS.PASS) === 0 && exitCodeFor(STATUS.PRODUCT_FAIL) === 1 && exitCodeFor(STATUS.RIG_FAIL) === 2,
  );
  assert(
    "broken accounting outranks green stages",
    overallOutcome([{ status: STATUS.PASS }], { ok: false, missing: ["c"], undeclared: [] }) === STATUS.RIG_FAIL,
  );

  // -- the whole loop, end to end -------------------------------------------
  // A stage that throws must stop the run AND leave the rest visibly not-run,
  // rather than letting a truncated list report itself as complete.
  const endToEnd = await runDeclaredStages([
    { id: "one", title: "one", run: async () => ({ probes: [probe({ id: "p", title: "p", ok: true })], controls: [provenControl] }) },
    { id: "two", title: "two", run: async () => { throw new Error("stage exploded"); } },
    { id: "three", title: "three", run: async () => ({ probes: [], controls: [provenControl] }) },
  ], {});
  assert("a thrown stage produces a RIG failure", endToEnd.outcome === STATUS.RIG_FAIL, endToEnd.outcome);
  assert(
    "stages after a rig failure are reported as not run, not omitted",
    endToEnd.stages.length === 3 && endToEnd.stages[2].status === STATUS.DID_NOT_RUN,
    endToEnd.stages.map((s) => s.status),
  );
  assert("the truncated run's accounting is broken", endToEnd.accounting.ok === false, endToEnd.accounting);

  // -- source-entry decisions ------------------------------------------------
  assert("a dirty tree is refused", dirtyTreeDecision({ porcelain: "?? junk\n", allowDirty: false }).refuse === true);
  assert("a clean tree is permitted", dirtyTreeDecision({ porcelain: "", allowDirty: false }).refuse === false);
  const overridden = dirtyTreeDecision({ porcelain: " M app.tsx\n", allowDirty: true });
  assert("the override permits but still reports dirty", overridden.refuse === false && overridden.dirty === true);
  assert(
    "developer state in an archive is detected",
    contaminatedEntries(["package.json", "node_modules/x/index.js"]).length === 1,
  );
  assert(
    "committed fixture .runtime files are not mistaken for developer state",
    contaminatedEntries(["packages/deck/fixtures/agents/quill/.runtime/pane.txt"]).length === 0,
  );
  assert(
    "a real .env is developer state",
    contaminatedEntries(["packages/deck/.env", "packages/deck/.env.production"]).length === 2,
  );
  assert(
    "the tracked .env.example is not",
    contaminatedEntries(["packages/deck/.env.example"]).length === 0,
  );

  // -- version arithmetic ----------------------------------------------------
  assert("20.19.5 is below the 22.18.0 floor", versionAtLeast("20.19.5", "22.18.0") === false);
  assert("22.9.0 is below 22.18.0 (the float trap)", versionAtLeast("22.9.0", "22.18.0") === false);
  assert("22.18.0 meets its own floor", versionAtLeast("22.18.0", "22.18.0") === true);
  assert("22.23.2 is above the floor", versionAtLeast("v22.23.2", "22.18.0") === true);

  // -- output parsing --------------------------------------------------------
  // A command with no exit marker must read as null, never as 0. This is the
  // `?? 0` shape again, in the place a rig would most plausibly reintroduce it.
  const codes = parseExitCodes("###BEGIN install\n###EXIT install 0\n###BEGIN test\n");
  assert("a completed command reports its code", codes.install === 0, codes);
  assert("a command that never finished reports null, not 0", codes.test === null, codes);
  const combined = [
    "> inkie-agents-base@0.0.0 test",
    " Test Files  1 passed (1)",
    "      Tests  27 passed (27)",
    "> inkie-deck@0.0.0 test",
    " Test Files  86 passed (86)",
    "      Tests  1770 passed | 11 skipped (1781)",
  ].join("\n");
  const parsed = parseSuiteCounts(combined);
  assert("each workspace's count is attributed to that workspace", parsed.base?.passed === 27 && parsed.deck?.passed === 1770, parsed);
  assert("skipped counts are read", parsed.deck?.skipped === 11 && parsed.base?.skipped === 0, parsed);
  const withFailures = "> inkie-deck@0.0.0 test\n      Tests  4 failed | 1766 passed | 11 skipped (1781)";
  assert(
    "a run with failures still yields its counts",
    parseSuiteCounts(withFailures).deck?.failed === 4 && parseSuiteCounts(withFailures).deck?.passed === 1766,
    parseSuiteCounts(withFailures).deck,
  );
  assert("a run with no summary reports null rather than zero", parseSuiteCounts("nothing here").deck === null);
  // The regression that mattered: vitest colours its summary, and a parser
  // written against the plain text reported "the suite did not run" about a
  // suite that had just run 1770 tests. The count instrument is the whole
  // point of the checks stage, so it is tested against coloured output.
  const ESC = String.fromCharCode(27);
  const coloured = [
    "> " + "inkie-deck@0.0.0 test",
    " " + ESC + "[2mTest Files" + ESC + "[22m  " + ESC + "[1m" + ESC + "[32m86 passed" + ESC + "[39m" + ESC + "[22m (86)",
    " " + ESC + "[2m      Tests" + ESC + "[22m  " + ESC + "[1m" + ESC + "[32m1770 passed" + ESC + "[39m" + ESC + "[22m | " + ESC + "[33m11 skipped" + ESC + "[39m (1781)",
  ].join("\n");
  assert(
    "a coloured vitest summary is still read",
    parseSuiteCounts(coloured).deck?.passed === 1770 && parseSuiteCounts(coloured).deck?.files === 86,
    parseSuiteCounts(coloured).deck,
  );
  assert(
    "stripping colour does not eat ordinary bracketed prefixes",
    stripAnsi("[prod] FATAL: something") === "[prod] FATAL: something",
    stripAnsi("[prod] FATAL: something"),
  );

  if (failures.length > 0) {
    for (const failure of failures) console.error(`rig self-test: FAILED - ${failure}`);
    console.error(`rig self-test: ${failures.length} of ${checks} checks failed`);
    return false;
  }
  if (!options.quiet) console.log(`rig self-test: all ${checks} checks passed`);
  return true;
}
