/**
 * e2e/global-setup.ts - Playwright global setup.
 *
 * By the time this runs, node e2e/setup.mjs has already:
 *   - Created the temp fixture dir
 *   - Written e2e/.e2e-env with INBOX_ROOT, QUEUE_STATE_PATH, MC_NOW, etc.
 *
 * This function reads e2e/.e2e-env and applies the vars to process.env so
 * that Playwright tests can access them (e.g. process.env["INBOX_ROOT"] in
 * test helpers). It also writes E2E_TEMP_ROOT to process.env for cleanup.
 *
 * The webServer already has the correct env vars from start-server.sh sourcing
 * e2e/.e2e-env before exec pnpm start.
 *
 * ASCII only - no em-dashes.
 */
import fs from "node:fs";
import path from "node:path";

async function globalSetup() {
  const envFile = path.resolve("e2e/.e2e-env");

  if (!fs.existsSync(envFile)) {
    throw new Error(
      "e2e/.e2e-env not found. Run: node e2e/setup.mjs before playwright test. " +
        "The pnpm e2e script does this automatically."
    );
  }

  // Read and apply all vars to process.env so test helpers can access them.
  const content = fs.readFileSync(envFile, "utf8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx);
    const value = trimmed.slice(eqIdx + 1);
    process.env[key] = value;
  }
}

export default globalSetup;
