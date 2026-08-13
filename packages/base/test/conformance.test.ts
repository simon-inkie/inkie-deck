/**
 * Runs the CLI half of the shared conformance corpus.
 *
 * The real work is in conformance/run_cli.py, which has to be Python because
 * the implementation it checks is Python. This wrapper exists so that the
 * corpus is covered by `pnpm test` like everything else, rather than being a
 * command someone has to remember. A conformance check nobody runs is not a
 * conformance check.
 *
 * The counterpart runner lives in packages/deck and drives the application
 * through the same corpus. Neither implementation is privileged: both are
 * checked against docs/protocol.md, not against each other.
 */
import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const PACKAGE_ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(PACKAGE_ROOT, "conformance", "run_cli.py");

describe("protocol conformance corpus (python CLI)", () => {
  it("every case is either conforming or a recorded deviation", () => {
    const result = spawnSync("python3", [RUNNER], {
      encoding: "utf8",
      cwd: PACKAGE_ROOT,
    });

    if (result.error) {
      // python3 missing is a real result, not a reason to pass quietly: the
      // CLI this package ships IS python, so a machine that cannot run the
      // runner cannot run the tool either. Say so rather than skipping.
      throw new Error(
        `could not run ${RUNNER}: ${result.error.message}. ` +
          "python3 is a prerequisite of this package: bin/inbox is a python3 script."
      );
    }

    // The runner prints a summary line ending in the counts, and the full
    // detail of any failure. Surface its stdout verbatim on failure, because
    // the diff it prints is the actual diagnostic.
    expect(
      result.status,
      `${result.stdout}\n${result.stderr}`
    ).toBe(0);

    // Guard against the check passing because it checked nothing: every
    // predicate is true of the empty set, so assert the denominator too.
    const match = /: (\d+)\/(\d+) conforming/.exec(result.stdout);
    expect(match, `could not read the case count from: ${result.stdout}`).not.toBeNull();
    expect(Number(match![2]), "the corpus reported zero cases").toBeGreaterThan(0);
  });
});
