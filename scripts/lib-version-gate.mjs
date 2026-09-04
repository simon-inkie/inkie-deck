#!/usr/bin/env node
/**
 * lib-version-gate: PANE_IDLE_LIB_VERSION must never mean two different things.
 *
 * WHY THIS EXISTS, because it is not obvious from the constant alone.
 *
 * `packages/base/bin/pane-idle` is a sourced library with three callers, and
 * they do not all need the same surface. `bin/activity-sweep.sh` uses
 * `check_idle` and asserts only that the library loaded. `bin/inbox-push` and
 * `bin/stuck-pane-sweep.sh` also use `find_composer_line` and `raw_line_for`,
 * which arrived at v2, and they assert `>= 2`.
 *
 * That assertion is the safety gate for a specific silent failure: against a
 * library that lacks those functions, bash reports "command not found", the
 * command substitution yields an empty string, and both callers read that as
 * "no composer text here". `inbox-push` would skip every push; the stuck sweep
 * would answer NOT STUCK for every pane. Neither would print anything. The
 * version comparison is what turns both of those into a loud refusal.
 *
 * It only works if the NUMBER means something. The failure this gate catches
 * was found by hand, on a real tree: a dormant branch had independently
 * claimed version 2 for a different set of functions, while a different
 * version 2 shipped on the mainline. Merge either one and `>= 2` silently
 * stops guaranteeing what its callers believe it guarantees. Nothing else in
 * the build has an opinion about that number, so it is checked here.
 *
 * WHAT IS CHECKED
 *
 *   1. The declared version appears in the SHIPPED manifest below, and the
 *      library's function surface matches that row EXACTLY. A version that
 *      gains or loses a function without a bump is the collision.
 *   2. A version not in the manifest is refused, and must be exactly one more
 *      than the highest shipped version. This forces the manifest to be
 *      updated in the same commit as the bump, which is what makes the
 *      manifest reviewable rather than decorative.
 *   3. Every caller's `-ge N` pin names a version that exists and is not
 *      higher than the library actually declares. A caller pinning a version
 *      that was never shipped is dead on arrival.
 *   4. When git history is available, every revision of the library reachable
 *      from HEAD is replayed against the manifest, so a manifest edited to
 *      paper over a collision fails here rather than passing by assertion. A
 *      shallow clone has no history to replay and says so instead of silently
 *      counting as a pass.
 *
 * USAGE
 *   node scripts/lib-version-gate.mjs              check the working tree
 *   node scripts/lib-version-gate.mjs --self-test  prove the gate catches a
 *                                                  collision, a missing row,
 *                                                  and an over-pinned caller,
 *                                                  using synthetic sources in
 *                                                  a temp dir
 */
import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LIB_REL = "packages/base/bin/pane-idle";

/**
 * The function surface of every version of the library that has ever shipped.
 *
 * ADD A ROW WHEN YOU BUMP, in the same commit. The row is the contract the
 * callers' `-ge N` assertions are written against: it says what a caller is
 * entitled to assume is defined when the library reports that version.
 *
 * Do not edit an existing row. If a shipped version's surface was recorded
 * wrongly, the honest fix is a new version, because installs already exist
 * that answer the old number.
 *
 * @type {Record<number, string[]>}
 */
const SHIPPED = {
  1: ["check_idle", "pane_ctx_pct"],
  2: ["check_idle", "pane_ctx_pct", "find_composer_line", "raw_line_for"],
  3: [
    "check_idle",
    "pane_has_codex_approval_dialog",
    "pane_ctx_pct",
    "find_composer_line",
    "raw_line_for",
  ],
};

/** Files that source the library and may pin a minimum version. */
const CALLERS = [
  "packages/base/bin/inbox-push",
  "packages/base/bin/activity-sweep.sh",
  "packages/base/bin/stuck-pane-sweep.sh",
];

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/**
 * The declared version, or null when the assignment is absent or not a plain
 * integer. Anchored at start of line so a mention inside a comment or a string
 * cannot be mistaken for the assignment.
 *
 * @param {string} src @returns {number | null}
 */
export function declaredVersion(src) {
  const m = /^PANE_IDLE_LIB_VERSION=(\d+)\s*$/m.exec(src);
  return m ? Number(m[1]) : null;
}

/**
 * Every top-level function the library defines, in source order. Anchored at
 * start of line, matching the shape these files actually use
 * (`name() {`), which is also the shape the shell suites grep for.
 *
 * @param {string} src @returns {string[]}
 */
export function definedFunctions(src) {
  const out = [];
  const re = /^([A-Za-z_][A-Za-z0-9_]*)\(\)\s*\{/gm;
  let m;
  while ((m = re.exec(src)) !== null) out.push(m[1]);
  return out;
}

/**
 * The minimum version a caller pins, or null when it only asserts presence.
 * Matches the digit-guarded comparison the callers use.
 *
 * @param {string} src @returns {number | null}
 */
export function pinnedMinimum(src) {
  const m = /PANE_IDLE_LIB_VERSION"\s+-ge\s+(\d+)/.exec(src);
  return m ? Number(m[1]) : null;
}

// ---------------------------------------------------------------------------
// The checks
// ---------------------------------------------------------------------------

/**
 * @param {number | null} version @param {string[]} functions
 * @param {string} where
 * @returns {string[]} findings, empty when the surface is consistent
 */
export function checkSurface(version, functions, where) {
  const findings = [];
  if (version === null) {
    findings.push(`${where}: no PANE_IDLE_LIB_VERSION assignment found`);
    return findings;
  }
  const expected = SHIPPED[version];
  if (expected === undefined) {
    const highest = Math.max(...Object.keys(SHIPPED).map(Number));
    findings.push(
      `${where}: version ${version} is not in the SHIPPED manifest. ` +
        `Add a row for it in scripts/lib-version-gate.mjs, in this commit. ` +
        (version === highest + 1
          ? `(It is the right NEXT number.)`
          : `It must be ${highest + 1}: the next number, not a reused or skipped one.`)
    );
    return findings;
  }
  const actual = functions.filter((f) => f !== "");
  const missing = expected.filter((f) => !actual.includes(f));
  const extra = actual.filter((f) => !expected.includes(f));
  if (missing.length > 0 || extra.length > 0) {
    findings.push(
      `${where}: version ${version} has already shipped with a DIFFERENT surface. ` +
        `A caller asserting ">= ${version}" is entitled to exactly [${expected.join(", ")}]` +
        (missing.length > 0 ? `; missing here: [${missing.join(", ")}]` : "") +
        (extra.length > 0 ? `; unexpected here: [${extra.join(", ")}]` : "") +
        `. Bump the constant and add a manifest row rather than re-using this number.`
    );
  }
  return findings;
}

/**
 * @param {number} libVersion
 * @param {(rel: string) => string | null} read
 * @returns {string[]}
 */
export function checkCallers(libVersion, read) {
  const findings = [];
  for (const rel of CALLERS) {
    const src = read(rel);
    if (src === null) continue; // not every caller has to exist in every tree
    const pin = pinnedMinimum(src);
    if (pin === null) continue; // presence-only assertion is a valid choice
    if (SHIPPED[pin] === undefined) {
      findings.push(`${rel}: pins ">= ${pin}", which is not a version that has ever shipped`);
    } else if (pin > libVersion) {
      findings.push(
        `${rel}: pins ">= ${pin}" but the library declares ${libVersion}, ` +
          `so this caller refuses every tick against its own library`
      );
    }
  }
  return findings;
}

// ---------------------------------------------------------------------------
// History replay
// ---------------------------------------------------------------------------

/** @returns {{ replayed: number, findings: string[], available: boolean }} */
function replayHistory() {
  /** @type {string[]} */
  const findings = [];
  let revs = [];
  try {
    const out = execFileSync("git", ["log", "--format=%H", "--", LIB_REL], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    revs = out.split("\n").filter((l) => l.trim() !== "");
  } catch {
    return { replayed: 0, findings, available: false };
  }
  if (revs.length === 0) return { replayed: 0, findings, available: false };

  let replayed = 0;
  for (const rev of revs) {
    let src;
    try {
      src = execFileSync("git", ["show", `${rev}:${LIB_REL}`], {
        cwd: REPO_ROOT,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      continue; // the file did not exist at that revision
    }
    replayed += 1;
    const version = declaredVersion(src);
    // A historical revision predating the manifest is not a finding: the
    // manifest is the record of what versions MEAN, and a revision whose
    // version is unknown here is one the manifest has to learn about. Only a
    // KNOWN version with a mismatched surface is a real collision, which is
    // exactly the shape the by-hand discovery had.
    if (version === null || SHIPPED[version] === undefined) continue;
    const surface = checkSurface(version, definedFunctions(src), `${rev.slice(0, 8)}:${LIB_REL}`);
    findings.push(...surface);
  }
  return { replayed, findings, available: true };
}

// ---------------------------------------------------------------------------
// Self-test
// ---------------------------------------------------------------------------

function selfTest() {
  const good = [
    "check_idle() {", "  :", "}",
    "pane_ctx_pct() {", "  :", "}",
    "find_composer_line() {", "  :", "}",
    "raw_line_for() {", "  :", "}",
    "PANE_IDLE_LIB_VERSION=2",
  ].join("\n");

  /** @type {{ name: string, src: string, expectFinding: boolean }[]} */
  const cases = [
    { name: "a correct v2 library passes", src: good, expectFinding: false },
    {
      name: "v2 with a function removed is caught (the collision shape)",
      src: good.replace("raw_line_for() {\n  :\n}\n", ""),
      expectFinding: true,
    },
    {
      name: "v2 with an extra function is caught (added without a bump)",
      src: good.replace("PANE_IDLE_LIB_VERSION=2", "brand_new_thing() {\n  :\n}\nPANE_IDLE_LIB_VERSION=2"),
      expectFinding: true,
    },
    {
      name: "the v1 surface claiming v2 is caught",
      src: ["check_idle() {", "  :", "}", "pane_ctx_pct() {", "  :", "}", "PANE_IDLE_LIB_VERSION=2"].join("\n"),
      expectFinding: true,
    },
    {
      name: "an unknown version is refused until the manifest learns it",
      src: good.replace("PANE_IDLE_LIB_VERSION=2", "PANE_IDLE_LIB_VERSION=3"),
      expectFinding: true,
    },
    {
      name: "a missing version assignment is refused",
      src: good.replace("PANE_IDLE_LIB_VERSION=2", ""),
      expectFinding: true,
    },
  ];

  let failed = 0;
  for (const c of cases) {
    const findings = checkSurface(declaredVersion(c.src), definedFunctions(c.src), "<self-test>");
    const ok = findings.length > 0 === c.expectFinding;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"}  ${c.name}`);
    if (!ok) console.log(`        findings: ${JSON.stringify(findings)}`);
  }

  // Caller pins, against a synthetic reader so nothing on disk is involved.
  /** @type {{ name: string, lib: number, srcs: Record<string, string>, expectFinding: boolean }[]} */
  const callerCases = [
    {
      name: "a caller pinning >= 2 against a v2 library passes",
      lib: 2,
      srcs: { "packages/base/bin/inbox-push": '[ "$PANE_IDLE_LIB_VERSION" -ge 2 ]' },
      expectFinding: false,
    },
    {
      name: "a caller pinning >= 2 against a v1 library is caught",
      lib: 1,
      srcs: { "packages/base/bin/inbox-push": '[ "$PANE_IDLE_LIB_VERSION" -ge 2 ]' },
      expectFinding: true,
    },
    {
      name: "a caller pinning a never-shipped version is caught",
      lib: 2,
      srcs: { "packages/base/bin/inbox-push": '[ "$PANE_IDLE_LIB_VERSION" -ge 9 ]' },
      expectFinding: true,
    },
    {
      name: "a presence-only caller is not a finding",
      lib: 2,
      srcs: { "packages/base/bin/inbox-push": 'if [ -z "${PANE_IDLE_LIB_VERSION:-}" ]; then' },
      expectFinding: false,
    },
  ];
  for (const c of callerCases) {
    const findings = checkCallers(c.lib, (rel) => c.srcs[rel] ?? null);
    const ok = findings.length > 0 === c.expectFinding;
    if (!ok) failed += 1;
    console.log(`${ok ? "ok  " : "FAIL"}  ${c.name}`);
    if (!ok) console.log(`        findings: ${JSON.stringify(findings)}`);
  }

  if (failed > 0) {
    console.error(`\nlib-version-gate self-test: ${failed} case(s) FAILED`);
    process.exit(1);
  }
  console.log(`\nlib-version-gate self-test: all ${cases.length + callerCases.length} cases pass`);
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

function main() {
  if (process.argv.includes("--self-test")) {
    selfTest();
    return;
  }

  const libPath = path.join(REPO_ROOT, LIB_REL);
  if (!fs.existsSync(libPath)) {
    console.error(`lib-version-gate: ${LIB_REL} is missing`);
    process.exit(1);
  }
  const src = fs.readFileSync(libPath, "utf8");
  const version = declaredVersion(src);

  /** @type {string[]} */
  const findings = [];
  findings.push(...checkSurface(version, definedFunctions(src), LIB_REL));
  if (version !== null && SHIPPED[version] !== undefined) {
    findings.push(
      ...checkCallers(version, (rel) => {
        const p = path.join(REPO_ROOT, rel);
        return fs.existsSync(p) ? fs.readFileSync(p, "utf8") : null;
      })
    );
  }

  const history = replayHistory();
  findings.push(...history.findings);

  if (findings.length > 0) {
    console.error("lib-version-gate: FAILED\n");
    for (const f of findings) console.error(`  - ${f}`);
    console.error(
      "\nThe number is the whole guarantee: callers assert a MINIMUM version to\n" +
        "avoid silently reading an absent function as an empty answer. Two\n" +
        "different surfaces answering the same number defeats that assertion."
    );
    process.exit(1);
  }

  console.log(
    `lib-version-gate: ${LIB_REL} declares v${version} ` +
      `[${SHIPPED[/** @type {number} */ (version)].join(", ")}]`
  );
  if (history.available) {
    console.log(`lib-version-gate: replayed ${history.replayed} historical revision(s), no collision`);
  } else {
    console.log(
      "lib-version-gate: no git history for this file (shallow clone or first commit); " +
        "the historical replay was SKIPPED, the working-tree checks above still ran"
    );
  }
}

main();
