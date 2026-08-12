import { defineConfig } from "vitest/config";

// This package is markdown and shell. The only thing in it with behaviour is
// bin/create-agent.sh, and the tests run it as a subprocess against temporary
// directories rather than importing anything, so there is nothing to transform
// and no environment to set up.
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
