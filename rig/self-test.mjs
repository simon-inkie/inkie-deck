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
import * as fs from "node:fs";
import { pathToFileURL } from "node:url";

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
import { coverage, extractFencedBlocks, proseAfter, selectInDocumentOrder } from "./lib/fenced.mjs";
import { parseBlockMarkers } from "./lib/docrun.mjs";
import { satisfiesRange, versionAtLeast } from "./lib/version.mjs";
import { parseExitCodes, parseSuiteCounts } from "./stages/03-documented-checks.mjs";
import { extractRefusal } from "./stages/04-node20-floor.mjs";
import { ENGINE_STRICT_FILE, ENGINE_STRICT_SETTING, ENGINES_MANIFESTS, NODE_ENGINES, NODE_FLOOR } from "./expected.mjs";

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
  assert("20.19.5 is below the 22.13.0 floor", versionAtLeast("20.19.5", "22.13.0") === false);
  assert("22.9.0 is below 22.13.0 (the float trap)", versionAtLeast("22.9.0", "22.13.0") === false);
  assert("22.13.0 meets its own floor", versionAtLeast("22.13.0", "22.13.0") === true);
  assert("22.23.2 is above the floor", versionAtLeast("v22.23.2", "22.13.0") === true);

  // -- the engines RANGE, which a floor comparison cannot express -------------
  // The whole reason the manifests carry a range rather than a `>=`: Node 23
  // is numerically above the floor and is not permitted, because it was never
  // an LTS line and is already end of life. A `>=22.13.0` floor admits it.
  assert("20.20.2 is outside the range", satisfiesRange("v20.20.2", NODE_ENGINES) === false);
  assert("22.12.0, just below the floor, is outside", satisfiesRange("22.12.0", NODE_ENGINES) === false);
  assert("22.13.0, the bottom of the range, is inside", satisfiesRange("22.13.0", NODE_ENGINES) === true);
  assert("22.23.2 is inside", satisfiesRange("v22.23.2", NODE_ENGINES) === true);
  assert("23.11.1 is EXCLUDED despite being above the floor", satisfiesRange("23.11.1", NODE_ENGINES) === false);
  assert("24.0.0 is inside", satisfiesRange("24.0.0", NODE_ENGINES) === true);
  assert("26.4.0, a major that does not exist yet, is inside", satisfiesRange("26.4.0", NODE_ENGINES) === true);
  assert("the floor constant is the bottom of the range", satisfiesRange(NODE_FLOOR, NODE_ENGINES) === true);
  let rangeThrew = false;
  try {
    // A clause form the evaluator does not implement has to be loud. Read
    // silently as "not satisfied" it fails a supported Node; read silently as
    // satisfied it passes an unsupported one. Both without a word.
    satisfiesRange("22.13.0", "~22.13.0");
  } catch {
    rangeThrew = true;
  }
  assert("an unsupported range clause throws rather than guessing", rangeThrew);

  // -- the floor is the same thing everywhere it is written -------------------
  // Three manifests, one .npmrc and this rig's own copy all have to agree. A
  // floor set in the root and left stale in a package is not enforced there,
  // and the range asserted throughout the rig means nothing if the manifests
  // have since moved on.
  const repoRoot = new URL("../", import.meta.url);
  for (const manifest of ENGINES_MANIFESTS) {
    let declared;
    try {
      declared = JSON.parse(fs.readFileSync(new URL(manifest, repoRoot), "utf8")).engines?.node ?? null;
    } catch (error) {
      declared = `unreadable: ${error.message}`;
    }
    assert(`${manifest} declares the range this rig asserts`, declared === NODE_ENGINES, declared);
  }
  let npmrc;
  try {
    npmrc = fs.readFileSync(new URL(ENGINE_STRICT_FILE, repoRoot), "utf8");
  } catch (error) {
    npmrc = `unreadable: ${error.message}`;
  }
  assert(
    `${ENGINE_STRICT_FILE} sets ${ENGINE_STRICT_SETTING}, without which engines is only advice`,
    new RegExp(`^\\s*${ENGINE_STRICT_SETTING.replace(/\./g, "\\.")}\\s*$`, "m").test(npmrc),
    npmrc.slice(0, 200),
  );

  // -- the refusal extractor -------------------------------------------------
  // Cutting the message out of the log is what lets the report quote what a
  // Node 20 user reads. Terminating on the first blank line would keep the
  // headline and drop the two lines naming the expected and actual version,
  // which are the only part of it that tells the reader what to do.
  const refusalLog = [
    "###BEGIN install",
    "Scope: all 3 workspace projects",
    " ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)",
    "",
    'Your Node version is incompatible with "/src".',
    "",
    `Expected version: ${NODE_ENGINES}`,
    "Got: v20.20.2",
    "###EXIT install 1",
    "###BEGIN typecheck",
  ].join("\n");
  const extracted = extractRefusal(refusalLog);
  assert("the refusal is found in the log", extracted !== null);
  assert("the extracted refusal keeps the expected version", String(extracted).includes(`Expected version: ${NODE_ENGINES}`), extracted);
  assert("the extracted refusal keeps the version actually found", String(extracted).includes("Got: v20.20.2"), extracted);
  assert("the extractor stops at the exit marker", !String(extracted).includes("###EXIT"), extracted);
  assert("a log with no refusal in it yields null, not an empty string", extractRefusal("Done in 7.8s") === null);

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

  // -- fenced-block extraction -----------------------------------------------
  // The mechanism that makes a document testable, tested as decisions. Every
  // one of these is a way the extraction could quietly execute something other
  // than what the document says, which is the only way this approach fails
  // without anyone noticing.
  const doc = [
    "# Title",
    "",
    "## First section",
    "",
    "```sh",
    "echo one",
    "```",
    "",
    "```text",
    "one",
    "```",
    "",
    "prose that follows the block",
    "",
    "## Second section",
    "",
    "```sh",
    "# this hash is a shell comment, not a heading",
    "echo two",
    "```",
    "",
  ].join("\n");
  const docBlocks = extractFencedBlocks(doc);
  assert("every fenced block is found", docBlocks.length === 3, docBlocks.length);
  assert(
    "block text is verbatim, with no added or trimmed lines",
    docBlocks[0].text === "echo one\n",
    docBlocks[0].text,
  );
  assert(
    "ids are per heading and per language, so adding an output block does not renumber the executable one",
    docBlocks[0].id === "first-section/sh#1" && docBlocks[1].id === "first-section/text#1" && docBlocks[2].id === "second-section/sh#1",
    docBlocks.map((block) => block.id),
  );
  assert(
    "a # comment inside a block is not read as a heading",
    docBlocks[2].heading === "Second section",
    docBlocks[2].heading,
  );
  assert(
    "the prose after a block is what the drift check reads",
    proseAfter(doc, docBlocks[1]) === "prose that follows the block",
    proseAfter(doc, docBlocks[1]),
  );
  let fenceThrew = false;
  try {
    extractFencedBlocks("```sh\necho unterminated\n");
  } catch {
    fenceThrew = true;
  }
  assert("an unterminated fence raises rather than yielding a partial list", fenceThrew);
  let tildeThrew = false;
  try {
    extractFencedBlocks("~~~sh\necho hidden\n~~~\n");
  } catch {
    tildeThrew = true;
  }
  assert("a fence style the extractor cannot read raises rather than being skipped", tildeThrew);
  const cover = coverage(docBlocks, {
    executableLangs: ["sh"],
    knownLangs: ["sh", "text"],
    runs: { only: ["first-section/sh#1"] },
  });
  assert("an executable block no run claims is reported", cover.unclaimed.includes("second-section/sh#1"), cover.unclaimed);
  const skippedCover = coverage(docBlocks, {
    executableLangs: ["sh"],
    knownLangs: ["sh", "text"],
    runs: { only: ["first-section/sh#1"] },
    skipped: { "second-section/sh#1": "declared skip" },
  });
  assert("a declared skip is accounted for, not reported as unclaimed", skippedCover.unclaimed.length === 0, skippedCover.unclaimed);
  assert("a skip on a block that does not exist is reported as stale", coverage(docBlocks, {
    executableLangs: ["sh"],
    knownLangs: ["sh", "text"],
    runs: { only: ["first-section/sh#1", "second-section/sh#1"] },
    skipped: { "first-section/sh#9": "stale" },
  }).unknownIds.length === 1);
  assert("a claim on a block that does not exist is reported separately", coverage(docBlocks, {
    executableLangs: ["sh"],
    knownLangs: ["sh", "text"],
    runs: { only: ["first-section/sh#9"] },
  }).unknownIds.length === 1);
  assert(
    "a language the plan does not handle is reported rather than ignored",
    coverage(docBlocks, { executableLangs: ["sh"], knownLangs: ["sh"], runs: {} }).unknownLangs.length === 1,
  );
  let orderThrew = false;
  try {
    selectInDocumentOrder(docBlocks, ["first-section/sh#1", "nope#1"]);
  } catch {
    orderThrew = true;
  }
  assert("selecting a block that is not in the document raises", orderThrew);
  assert(
    "blocks are selected in DOCUMENT order, never the order the declaration lists",
    selectInDocumentOrder(docBlocks, ["second-section/sh#1", "first-section/sh#1"]).map((block) => block.id).join(",") ===
      "first-section/sh#1,second-section/sh#1",
  );

  // -- block markers ---------------------------------------------------------
  // The `?? 0` shape once more, in the runner that reads a document's results.
  const markers = parseBlockMarkers(
    ["###BEGIN a/sh#1", "hello", "###EXIT a/sh#1 0", "###BEGIN b/sh#1", "###BG b/sh#1 4242", "###DRIVER-END"].join("\n"),
    [{ id: "a/sh#1" }, { id: "b/sh#1" }, { id: "c/sh#1" }],
  );
  assert("a completed block reports its code", markers.exits["a/sh#1"] === 0, markers.exits);
  assert("a block that never ran reports null, not 0", markers.exits["c/sh#1"] === null, markers.exits);
  assert("a backgrounded block reports its pid and no exit", markers.backgrounded["b/sh#1"] === "4242" && markers.exits["b/sh#1"] === null);
  assert("a block's own output is attributed to it", markers.blockOutput["a/sh#1"] === "hello", markers.blockOutput);
  assert("the driver's completion is recorded", markers.completed === true);
  assert(
    "a truncated driver log is not read as complete",
    parseBlockMarkers("###BEGIN a/sh#1\n", [{ id: "a/sh#1" }]).completed === false,
  );

  if (failures.length > 0) {
    for (const failure of failures) console.error(`rig self-test: FAILED - ${failure}`);
    console.error(`rig self-test: ${failures.length} of ${checks} checks failed`);
    return false;
  }
  if (!options.quiet) console.log(`rig self-test: all ${checks} checks passed`);
  return true;
}

// Running this file directly used to execute nothing and exit 0 in silence,
// because the module only exports. A file named self-test.mjs that reports
// success without running a check is the failure this whole directory exists
// to prevent, so it runs when invoked directly as well as via run.mjs.
if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  selfTest().then((passed) => process.exit(passed ? 0 : 2));
}
