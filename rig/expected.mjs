/**
 * What a green run looks like, stated as data with its provenance.
 *
 * These are the numbers the rig asserts against. They are written down here,
 * once, so that a change to the product that moves one of them shows up as a
 * red probe naming the old and new value rather than as a rig that quietly
 * agrees with whatever it just measured.
 */

/**
 * The Node range, verbatim from the `engines` field of all three manifests.
 *
 * Copied here rather than read out of package.json, so that a change to the
 * product's floor shows up as a red probe naming the old and new value, which
 * is this file's whole job. The self-test asserts the copy still matches all
 * three manifests, so the duplication cannot rot into a lie.
 */
export const NODE_ENGINES = "^22.13.0 || >=24.0.0";

/**
 * The lowest version the range admits, for the places that need one number.
 *
 * NOT interchangeable with the range: 25.0.0 is above this and is permitted,
 * 23.0.0 is above it and is NOT. Anything deciding "is this Node allowed"
 * must evaluate the range; this constant only reports where the bottom is.
 */
export const NODE_FLOOR = "22.13.0";

/**
 * The three manifests that must all carry `NODE_ENGINES`.
 *
 * A floor enforced in the root and forgotten in a package is not enforced:
 * pnpm checks each workspace project's own manifest, so a stale one is a
 * second, quieter answer to the same question.
 */
export const ENGINES_MANIFESTS = ["package.json", "packages/base/package.json", "packages/deck/package.json"];

/**
 * The file that turns the engines field from advice into a refusal.
 *
 * pnpm treats `engines` as advisory by default; measured, a clean Node 20
 * machine installed, typechecked, tested and passed every gate against a
 * `>=22.18.0` floor. The floor and the setting are one change, so the rig
 * asserts the setting is present rather than only that the range is right.
 */
export const ENGINE_STRICT_FILE = ".npmrc";
export const ENGINE_STRICT_SETTING = "engine-strict=true";

/**
 * Tools the product needs and the README names, plus the two the README does
 * not (curl is needed to install node at all on a bare Ubuntu; tmux is needed
 * for the live-agent tier, which phase 2 does not exercise but does install).
 *
 * python3 arrived here the way this list is supposed to grow: the README
 * gained it as a prerequisite, the image did not, and the documented check
 * list then failed IN THE RIG with two of the base package's shell suites red
 * and no mention anywhere of what was missing. The instrument was a day behind
 * the thing it measures.
 */
export const REQUIRED_TOOLS = ["node", "corepack", "pnpm", "git", "rg", "curl", "tmux", "python3", "xxd"];

/**
 * Test-count instrument.
 *
 * The README documents these as a diagnostic for the reader: the full figure
 * means git and ripgrep are both present, and a lower number names the missing
 * one. The rig asserts the exact figure, because "the suite passed" is
 * satisfied by a suite that quietly stopped running 67 of its tests, and that
 * is not a hypothetical here - it is what an unprepared machine measured in
 * the baseline run.
 *
 * These numbers are also the reason to distrust a published count that nothing
 * asserts: the README carried 1790 for a tree that measured 1810, and this
 * file carried 1770 for the same tree, each stale from a different day. A
 * number in prose rots silently; a number a stage compares against goes red.
 *
 * `base` is measured rather than documented: the README's number is deck's
 * alone and does not mention the base package's suite at all.
 *
 * deck moved 1810 -> 1813 on 2026-08-14: three tests pinning that a markdown
 * heading in a message body no longer ends the block it sits in. base holds at
 * 38 because its shell suites are one vitest case each however many cases they
 * contain; the bash tally there went 54 -> 55 for the same fix.
 *
 * deck moved 1813 -> 1819 on 2026-08-17: six tests for MC_BRIEFS_AGENT, which
 * replaced a hardcoded agent name in the briefs path with a validated config
 * value. base is unchanged.
 *
 * deck moved 1819 -> 2023 on 2026-08-18, and 88 -> 95 files: merging PR #2
 * (an empty subject still opens a block after trim() ate the trailing space
 * the header's own grammar requires: four tests plus one more corpus case)
 * into PR #3 (117 tests for the Nudges route, which had none: scheduler-route
 * and scheduler-nav, plus additions to cron-validate and instance).
 *
 * The 1936/90 this branch carried into the merge was itself stale: its own
 * first merge of main had already brought in activity-escalation,
 * app-shell-escalation, header-roundtrip, panel-state and panel-state-persist
 * (five files, from three unrelated PRs) without repricing the total against
 * them, so 117 got added to a base that predated tests already sitting in
 * the tree. Measured on the fully merged tree rather than summed from the
 * two PRs' own deltas, which is what caught it. None of it shells out or
 * reads the repository, so the two degraded figures in the README move by
 * the same amount as the full one. base holds at 38: its conformance runner
 * is a single vitest case whatever the corpus holds, and its CLI never had
 * the defect.
 */
export const EXPECTED_TESTS = {
  deck: { passed: 2023, skipped: 11, files: 95 },
  base: { passed: 38, skipped: 0, files: 4 },
};

/**
 * The README's own check list, in its order, run from the repository root.
 *
 * Executed as data rather than reimplemented per stage so that the rig runs
 * what the document tells a stranger to run. `pnpm install` is included
 * because it is the first line of that block.
 */
export const DOCUMENTED_CHECKS = [
  { id: "install", command: "pnpm install" },
  { id: "typecheck", command: "pnpm typecheck" },
  { id: "test", command: "pnpm test" },
  { id: "boundaries", command: "pnpm check:boundaries" },
  { id: "leaks", command: "pnpm check:leaks" },
  { id: "licence", command: "pnpm check:licence" },
];

/** Base image under test. Pinned by tag; the digest is recorded per run. */
export const BASE_IMAGE = "ubuntu:24.04";

/**
 * Binaries stage zero requires to be ABSENT from the base image.
 *
 * If any of these is present, the base is not bare and nothing measured
 * downstream distinguishes "the product works from a clean install" from "the
 * base image happened to carry the missing piece".
 */
export const MUST_BE_ABSENT = ["node", "npm", "pnpm", "corepack", "yarn", "tmux", "git", "curl", "rg", "python3", "xxd"];

/**
 * Entries the image's own skeleton puts in $HOME. Anything else means the
 * home directory carries state, which is the contamination the attestation
 * exists to exclude.
 */
export const ALLOWED_HOME_ENTRIES = [".bashrc", ".profile", ".bash_logout"];

/**
 * Paths that may legitimately match the contamination patterns in a `git
 * archive` of a clean tree: committed fixture files that happen to live under
 * a directory named `.runtime`. Anything else matching means developer state
 * has entered the archive.
 */
export const ARCHIVE_CONTAMINATION_ALLOWLIST = [/^packages\/deck\/fixtures\/agents\/[^/]+\/\.runtime\//];

/**
 * Patterns that mean developer state, not source.
 *
 * The `.env` rule excludes `.env.example`, which is a tracked file and is
 * meant to be in the archive; the first version of this rule flagged it and
 * the run went red for a reason that had nothing to do with contamination.
 * A probe that cries wolf on a correct tree gets disabled by the third
 * reader, so the exclusion is part of the assertion rather than an
 * afterthought.
 */
export const ARCHIVE_CONTAMINATION_PATTERNS = [
  /(^|\/)node_modules\//,
  /(^|\/)\.runtime\//,
  /(^|\/)build\//,
  /(^|\/)\.react-router\//,
  /(^|\/)\.env(?!\.example)(\.[^/]*)?$/,
];
