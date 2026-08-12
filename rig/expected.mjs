/**
 * What a green run looks like, stated as data with its provenance.
 *
 * These are the numbers the rig asserts against. They are written down here,
 * once, so that a change to the product that moves one of them shows up as a
 * red probe naming the old and new value rather than as a rig that quietly
 * agrees with whatever it just measured.
 */

/** Node floor, from the `engines` field of the workspace root package.json. */
export const NODE_FLOOR = "22.18.0";

/**
 * Tools the product needs and the README names, plus the two the README does
 * not (curl is needed to install node at all on a bare Ubuntu; tmux is needed
 * for the live-agent tier, which phase 2 does not exercise but does install).
 */
export const REQUIRED_TOOLS = ["node", "corepack", "pnpm", "git", "rg", "curl", "tmux"];

/**
 * Test-count instrument.
 *
 * The README documents these as a diagnostic for the reader: 1770 means git
 * and ripgrep are both present, and a lower number names the missing one. The
 * rig asserts the exact figure, because "the suite passed" is satisfied by a
 * suite that quietly stopped running 67 of its tests, and that is not a
 * hypothetical here - it is what an unprepared machine measured in the
 * baseline run.
 *
 * `base` is measured rather than documented: the README's number is deck's
 * alone and does not mention the base package's suite at all.
 */
export const EXPECTED_TESTS = {
  deck: { passed: 1770, skipped: 11, files: 86 },
  base: { passed: 27, skipped: 0, files: 1 },
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
export const MUST_BE_ABSENT = ["node", "npm", "pnpm", "corepack", "yarn", "tmux", "git", "curl", "rg"];

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
