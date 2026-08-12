#!/usr/bin/env node
/**
 * e2e/setup.mjs - Pre-flight setup for E2E tests.
 *
 * Creates a fresh temp fixture dir, seeds it from fixtures/inbox, and writes
 * e2e/.e2e-env so the webServer command (start-server.sh) can source it.
 *
 * This runs BEFORE the Playwright test runner starts, so the env file is
 * guaranteed to exist before the webServer command tries to read it.
 * (Playwright starts webServer and globalSetup in parallel, which would
 * create a race condition if globalSetup were the only writer.)
 *
 * Also sets process.env so that if Playwright passes env to the subprocess
 * via process.env inheritance, those values are also available.
 *
 * The E2E_TEMP_ROOT path is printed to stdout so cleanup can find it.
 *
 * ASCII only - no em-dashes per FND-05.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Create a fresh temp directory.
const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), "mc-e2e-"));
const tmpRoot = fs.realpathSync(tmpBase);

// Seed the temp inbox from committed fixtures.
const fixturesInbox = path.join(repoRoot, "fixtures", "inbox");
const tmpInbox = path.join(tmpRoot, "inbox");
fs.cpSync(fixturesInbox, tmpInbox, { recursive: true });

// Provision a temp attachments root for E2E tests.
const tmpAttachments = path.join(tmpRoot, "attachments");
fs.mkdirSync(tmpAttachments, { recursive: true });

// Provision a temp review root for TASK-431 E2E tests.
// Also seed a .env file inside it to test the denial case.
const tmpReviewRoot = path.join(tmpRoot, "review-root");
fs.mkdirSync(tmpReviewRoot, { recursive: true });
// Copy the committed test-notes.md fixture into the review root.
const testNotesSrc = path.join(repoRoot, "e2e", "fixtures", "test-notes.md");
const testNotesDst = path.join(tmpReviewRoot, "test-notes.md");
fs.copyFileSync(testNotesSrc, testNotesDst);
// Copy the TASK-439 test-plan.md fixture into the review root.
const testPlanSrc = path.join(repoRoot, "e2e", "fixtures", "test-plan.md");
const testPlanDst = path.join(tmpReviewRoot, "test-plan.md");
fs.copyFileSync(testPlanSrc, testPlanDst);
// Place a .env file inside the allowed review root - used for the denial test.
const envFixturePath = path.join(tmpReviewRoot, ".env");
fs.writeFileSync(envFixturePath, "SECRET=supersecret\n");

// Provision a temp projects root for TASK-432 E2E tests.
// Seeded from committed fixtures/projects.
const tmpProjects = path.join(tmpRoot, "projects");
const fixturesProjects = path.join(repoRoot, "fixtures", "projects");
fs.cpSync(fixturesProjects, tmpProjects, { recursive: true });

// TASK-439: patch the seeded task-439-card-detail.md so its links: entry
// points at the actual (dynamic) tmpReviewRoot. The committed fixture uses
// the placeholder path /review-root-ref/test-plan.md; we rewrite it here.
const task439CardPath = path.join(tmpProjects, "task-439-card-detail.md");
if (fs.existsSync(task439CardPath)) {
  const cardContent = fs.readFileSync(task439CardPath, "utf8");
  const patchedContent = cardContent.replace(
    "/review-root-ref/test-plan.md",
    path.join(tmpReviewRoot, "test-plan.md")
  );
  fs.writeFileSync(task439CardPath, patchedContent, "utf8");
}

// Provision a temp agents root (M4-M6 model selector) seeded from
// fixtures/agents: .runtime markers + bin/model-catalog.json. The selector's
// POST writes .model files HERE - never near the real ~/agents.
const tmpAgents = path.join(tmpRoot, "agents");
const fixturesAgents = path.join(repoRoot, "fixtures", "agents");
fs.cpSync(fixturesAgents, tmpAgents, { recursive: true });

// QUEUE_STATE_PATH is alongside the inbox (NOT inside INBOX_ROOT).
// TASK-434: state writes are confined to DATA_ROOT, so the state file lives
// in a dedicated data dir under the temp root.
const tmpData = path.join(tmpRoot, "data");
fs.mkdirSync(tmpData, { recursive: true });
const queueStatePath = path.join(tmpData, "queue-state.json");

// Fixed clock instant (30h after fixture card = 6h overdue on 24h tier).
const mcNow = "2026-06-10T20:30:00Z";

// Write e2e/.e2e-env for start-server.sh to source.
const envFile = path.join(repoRoot, "e2e", ".e2e-env");
const envContent = [
  `INBOX_ROOT=${tmpInbox}`,
  `ATTACHMENTS_ROOT=${tmpAttachments}`,
  `REVIEW_ROOTS=${tmpReviewRoot}`,
  `REVIEW_ROOT_E2E=${tmpReviewRoot}`,
  `PROJECTS_ROOT=${tmpProjects}`,
  `DATA_ROOT=${tmpData}`,
  `AGENTS_ROOT=${tmpAgents}`,
  `QUEUE_STATE_PATH=${queueStatePath}`,
  `MC_SANDBOX_ONLY=1`,
  // TASK-437: point the Team tab at a guaranteed-missing tmux session so
  // e2e asserts the deterministic empty-state paths (never live panes).
  `MC_TMUX_SESSION=mc-e2e-missing`,
  `MC_NOW=${mcNow}`,
  `E2E_TEMP_ROOT=${tmpRoot}`,
].join("\n") + "\n";
fs.writeFileSync(envFile, envContent, "utf8");

// Also set process.env for Playwright's env inheritance.
process.env["INBOX_ROOT"] = tmpInbox;
process.env["ATTACHMENTS_ROOT"] = tmpAttachments;
process.env["REVIEW_ROOTS"] = tmpReviewRoot;
process.env["QUEUE_STATE_PATH"] = queueStatePath;
process.env["PROJECTS_ROOT"] = tmpProjects;
process.env["DATA_ROOT"] = tmpData;
process.env["AGENTS_ROOT"] = tmpAgents;
process.env["MC_SANDBOX_ONLY"] = "1";
process.env["MC_TMUX_SESSION"] = "mc-e2e-missing";
process.env["MC_NOW"] = mcNow;
process.env["E2E_TEMP_ROOT"] = tmpRoot;
process.env["REVIEW_ROOT_E2E"] = tmpReviewRoot;

// Print the temp root so the caller can pass it along or record it.
console.log(`E2E_TEMP_ROOT=${tmpRoot}`);
