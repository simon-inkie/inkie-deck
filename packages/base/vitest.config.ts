import { defineConfig } from "vitest/config";

// This package is markdown, shell and one python3 CLI. Nothing here is
// imported by the tests: bin/create-agent.sh, bin/inbox and the two ported
// bash suites are all driven as subprocesses against temporary directories, so
// there is nothing to transform and no environment to set up.
//
// That is also why the timeout below is generous rather than tuned: a vitest
// case here is a wrapper around a process tree, not an in-process assertion.
//
// The timeout is generous on purpose: every case spawns the script, which in
// turn spawns node several times and, in the verification cases, a stub
// runtime. That is slower than an in-process unit test and the default 5s is
// close enough to the real duration to go flaky on a loaded machine.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
    testTimeout: 30_000,
  },
});
