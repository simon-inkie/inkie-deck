/**
 * e2e/global-teardown.ts - Clean up temp fixtures and env file after E2E run.
 *
 * Removes:
 *   - The per-run temp dir (E2E_TEMP_ROOT from process.env)
 *   - The e2e/.e2e-env file written by setup.mjs
 *
 * Safe to call if setup failed (existence checks + force flag).
 *
 * ASCII only - no em-dashes per FND-05.
 */
import fs from "node:fs";
import path from "node:path";

async function globalTeardown() {
  // Remove the per-run temp dir (inbox + queue state).
  const tmpRoot = process.env["E2E_TEMP_ROOT"];
  if (tmpRoot) {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }

  // Remove the env file.
  const envFile = path.resolve("e2e/.e2e-env");
  if (fs.existsSync(envFile)) {
    fs.rmSync(envFile);
  }
}

export default globalTeardown;
