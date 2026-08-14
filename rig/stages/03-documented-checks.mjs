/**
 * Stage three: run the checks the README tells a stranger to run, and hold
 * them to the numbers the README publishes.
 *
 * "The suite exited 0" is not the assertion here, and deliberately so. On an
 * unprepared machine this suite has been observed to exit non-zero with 67
 * failures that have nothing to do with the code, and the fix for that class
 * of failure is environmental. The inverse is the dangerous one: a suite that
 * exits 0 having quietly run fewer tests than it has. So the count is the
 * instrument. The README publishes the whole-and-healthy figure and documents
 * the signatures of a missing ripgrep and a missing git repository, so a stage
 * that measures the count can name its own missing dependency instead of
 * reporting a colour.
 */
import { control, probe } from "../lib/harness.mjs";
import { runIn } from "../lib/docker.mjs";
import { stripAnsi, tail } from "../lib/exec.mjs";
import { DOCUMENTED_CHECKS, EXPECTED_TESTS } from "../expected.mjs";

/** Run a list of commands, each with its own exit code, in one container. */
function checkScript(commands) {
  return commands
    .map(({ id, command }) => `echo "###BEGIN ${id}"\n${command}\necho "###EXIT ${id} $?"`)
    .join("\n");
}

/** @param {string} output @returns {Record<string, number|null>} */
export function parseExitCodes(output) {
  const text = stripAnsi(output);
  /** @type {Record<string, number|null>} */
  const codes = {};
  for (const { id } of DOCUMENTED_CHECKS) codes[id] = null; // never ran, until proven otherwise
  for (const match of text.matchAll(/^###EXIT (\S+) (\d+)$/gm)) {
    codes[match[1]] = Number(match[2]);
  }
  return codes;
}

/**
 * Pull each workspace's vitest summary out of a combined run.
 *
 * Segmented by the package banner pnpm prints, because both suites print
 * summaries in the same format and a naive "last match wins" would report
 * deck's numbers under base's name, or vice versa, without ever looking
 * wrong.
 *
 * @param {string} output
 * @returns {Record<string, { passed: number, skipped: number, files: number }|null>}
 */
export function parseSuiteCounts(rawOutput) {
  // vitest colours the summary, so the counts are only visible once the
  // escape sequences are gone. See stripAnsi.
  const output = stripAnsi(rawOutput);
  const markers = [
    { name: "base", marker: "inkie-agents-base@" },
    { name: "deck", marker: "inkie-deck@" },
  ];
  const positions = markers
    .map(({ name, marker }) => ({ name, at: output.indexOf(marker) }))
    .filter((entry) => entry.at >= 0)
    .sort((a, b) => a.at - b.at);
  /** @type {Record<string, any>} */
  const counts = { base: null, deck: null };
  positions.forEach((entry, index) => {
    const segment = output.slice(entry.at, positions[index + 1]?.at ?? output.length);
    // The failed count is optional and comes FIRST when present. Matching
    // only "Tests  N passed" reads nothing at all off a run with failures,
    // which threw away the very number the README publishes as a diagnostic.
    const tests = /Tests\s+(?:(\d+) failed\s*\|\s*)?(\d+) passed(?:\s*\|\s*(\d+) skipped)?/.exec(segment);
    const files = /Test Files\s+(\d+) passed/.exec(segment);
    if (tests) {
      counts[entry.name] = {
        failed: tests[1] ? Number(tests[1]) : 0,
        passed: Number(tests[2]),
        skipped: tests[3] ? Number(tests[3]) : 0,
        files: files ? Number(files[1]) : null,
      };
    }
  });
  return counts;
}

/** Turn a count shortfall into the name of the dependency that causes it. */
function diagnoseCount(actual, expected) {
  if (actual === null) return "no suite summary was printed at all: the suite did not run";
  if (actual === expected) return `${actual}`;
  // The DELTAS are what this rig measured in its own containers: removing
  // ripgrep costs four tests and removing the git repository costs sixty-three
  // more. Written as offsets from the expected total rather than as two more
  // literals, so that adding a test to the suite cannot leave these two naming
  // numbers the tree can no longer produce (the whole-tree figure has been
  // stale twice already, in two different files, on two different days).
  const known = {
    [expected - 4]: "ripgrep is missing",
    [expected - 67]: "neither git nor ripgrep is present",
  };
  const named = known[actual] ? `, the README's signature for: ${known[actual]}` : "";
  return `${actual} against ${expected} (${actual - expected > 0 ? "+" : ""}${actual - expected})${named}`;
}

export default {
  id: "documented-checks",
  title: "the README's own check list, green, with the test count it publishes",
  async run(ctx) {
    const result = runIn(ctx.toolchainImage, `cd /src\n${checkScript(DOCUMENTED_CHECKS)}`);
    const codes = parseExitCodes(result.output);
    const counts = parseSuiteCounts(result.output);
    ctx.checkOutput = result.output;

    const probes = DOCUMENTED_CHECKS.map(({ id, command }) =>
      probe({
        id: `check-${id}`,
        title: `\`${command}\` exits 0`,
        // A null code means the marker never appeared, which is a stronger
        // failure than a non-zero one: the command did not finish.
        ok: codes[id] === 0,
        detail: codes[id] === null ? "no exit marker: the command never completed" : `exit ${codes[id]}`,
      }),
    );

    for (const [suite, expected] of Object.entries(EXPECTED_TESTS)) {
      const actual = counts[suite];
      probes.push(
        probe({
          id: `count-${suite}`,
          title: `${suite} suite reports ${expected.passed} passing`,
          ok: actual?.passed === expected.passed && actual?.skipped === expected.skipped && actual?.failed === 0,
          detail: `passed ${diagnoseCount(actual?.passed ?? null, expected.passed)}; skipped ${actual?.skipped ?? "none reported"} against ${expected.skipped}`,
        }),
        probe({
          id: `files-${suite}`,
          title: `${suite} suite runs ${expected.files} test files`,
          ok: actual?.files === expected.files,
          detail: `${actual?.files ?? "none reported"} against ${expected.files}`,
        }),
      );
    }

    // NEGATIVE CONTROL 1. Remove ripgrep and require the suite to go red
    // NAMING it. This is the control that proves the count probe above is
    // measuring anything: ripgrep's absence used to be scored as a pass by
    // two of the product's own assertions, so a suite that still exits 0
    // without rg would mean the rig is reading a number that cannot move.
    const noRipgrep = runIn(
      ctx.toolchainImage,
      `cd /src\nrm -f "$(command -v rg)"\npnpm install --frozen-lockfile >/dev/null 2>&1\npnpm test\necho "###EXIT test $?"`,
    );
    const noRipgrepCode = parseExitCodes(noRipgrep.output).test;
    // Matched against the product's own wording rather than the three letters
    // "rg", which appear in unrelated output often enough that a loose match
    // would let this control pass on a failure that had nothing to do with
    // ripgrep at all.
    const noRipgrepNamesIt = /requires? ripgrep|ripgrep \(rg\)/i.test(stripAnsi(noRipgrep.output));

    // NEGATIVE CONTROL 2. Remove the `.git` directory and require both the
    // suite and the leak gate to go red naming the repository. The tree is
    // otherwise identical, so anything else going wrong here would be the
    // control failing for the wrong reason, which is why the expectation is
    // the git message and not merely a non-zero exit.
    const noGit = runIn(
      ctx.toolchainImage,
      `cd /src\nrm -rf /src/.git\npnpm install --frozen-lockfile >/dev/null 2>&1\npnpm test\necho "###EXIT test $?"\npnpm check:leaks\necho "###EXIT leaks $?"`,
    );
    const noGitCodes = parseExitCodes(noGit.output);
    const noGitSaysSo = /not a git repository/i.test(stripAnsi(noGit.output));

    const controls = [
      control({
        id: "suite-red-without-ripgrep",
        title: "the documented suite, with ripgrep removed and nothing else changed",
        expectation: "non-zero exit, and output naming ripgrep or rg",
        satisfied: noRipgrepCode !== 0 && noRipgrepCode !== null && noRipgrepNamesIt,
        observed: `exit ${noRipgrepCode}; names ripgrep: ${noRipgrepNamesIt}; deck count ${JSON.stringify(parseSuiteCounts(noRipgrep.output).deck)}\n${tail(noRipgrep.output, 12)}`,
      }),
      control({
        id: "suite-red-without-git-repository",
        title: "the documented suite and leak gate, with .git removed",
        expectation: "both non-zero, and output containing `not a git repository`",
        satisfied: noGitCodes.test !== 0 && noGitCodes.test !== null && noGitCodes.leaks !== 0 && noGitSaysSo,
        observed: `test exit ${noGitCodes.test}, leaks exit ${noGitCodes.leaks}; says not-a-git-repository: ${noGitSaysSo}; deck count ${JSON.stringify(parseSuiteCounts(noGit.output).deck)}`,
      }),
    ];

    return {
      probes,
      controls,
      evidence: {
        exitCodes: codes,
        counts,
        withoutRipgrep: { exit: noRipgrepCode, counts: parseSuiteCounts(noRipgrep.output), output: tail(noRipgrep.output, 25) },
        withoutGit: { exits: noGitCodes, counts: parseSuiteCounts(noGit.output), output: tail(noGit.output, 25) },
      },
    };
  },
};
