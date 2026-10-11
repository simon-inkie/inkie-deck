/**
 * Runs the ported bash suites under vitest.
 *
 * WHY THIS WRAPPER EXISTS. Each of these suites came across with the tool it
 * covers, and they are the reason porting those tools was safe at all: several
 * are larger than the code they test. But `pnpm test` runs vitest, whose
 * `include` glob only ever collects `*.test.ts`, so as shell scripts they were
 * invisible to it and to CI. A suite nobody runs is not a safety net, it is a
 * bug preserved in the one place it can never go red, and it would have gone
 * stale silently while looking like coverage.
 *
 * Each script is spawned as a real subprocess and its output is surfaced
 * verbatim on failure, because the per-case output is the actual diagnostic.
 * They are slow relative to a unit test (they drive the real scripts as
 * subprocesses against temporary directories), hence the generous timeout.
 *
 * NONE of them needs a live tmux, and that is enforced rather than hoped for:
 * inbox-push.test.sh drives the whole flow through the PANE_OVERRIDE /
 * RUNTIME_OVERRIDE / PUSH_DRY_RUN seams, and the two sweep suites run in
 * fixture mode behind a stub `tmux` on PATH whose log they then assert against.
 * The sweep suites additionally need `jq`, which the sweep itself treats as a
 * hard dependency; both say so loudly rather than skipping if it is absent.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SUITES = [
  "inbox.test.sh",
  "inbox-push.test.sh",
  "pane-idle.test.sh",
  "activity-sweep.test.sh",
  "stuck-pane-sweep.test.sh",
  "boot-agents.test.sh",
  "claude-binary-check.test.sh",
] as const;

describe("ported shell suites", () => {
  for (const suite of SUITES) {
    it(
      suite,
      () => {
        const script = path.join(PACKAGE_ROOT, "test", suite);

        // Assert the file is there before running it. A renamed or deleted
        // suite would otherwise surface as a non-zero exit from bash with a
        // terse message, and "the suite is gone" and "the suite failed" are
        // different problems that deserve different words.
        expect(
          fs.existsSync(script),
          `${suite} is missing from ${path.dirname(script)}`
        ).toBe(true);

        const result = spawnSync("bash", [script], {
          encoding: "utf8",
          cwd: PACKAGE_ROOT,
          timeout: 240_000,
        });

        if (result.error) {
          throw new Error(`could not run ${suite}: ${result.error.message}`);
        }

        expect(
          result.status,
          `${result.stdout}\n${result.stderr}`
        ).toBe(0);

        // Guard the denominator: a suite that ran zero cases exits 0 and would
        // report as a pass. Both suites print a "N passed" tally.
        const tally = /(\d+)\s+passed/i.exec(result.stdout);
        expect(
          tally,
          `could not read a pass tally from ${suite}; did its output format change?\n${result.stdout}`
        ).not.toBeNull();
        expect(
          Number(tally![1]),
          `${suite} reported zero passing cases`
        ).toBeGreaterThan(0);
      },
      300_000
    );
  }
});
