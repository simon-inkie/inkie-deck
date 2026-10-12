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
 * ASCII only - no em-dashes.
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

// Provision a temp review root for E2E tests.
// Also seed a .env file inside it to test the denial case.
const tmpReviewRoot = path.join(tmpRoot, "review-root");
fs.mkdirSync(tmpReviewRoot, { recursive: true });
// Copy the committed test-notes.md fixture into the review root.
const testNotesSrc = path.join(repoRoot, "e2e", "fixtures", "test-notes.md");
const testNotesDst = path.join(tmpReviewRoot, "test-notes.md");
fs.copyFileSync(testNotesSrc, testNotesDst);
// Copy the test-plan.md fixture into the review root.
const testPlanSrc = path.join(repoRoot, "e2e", "fixtures", "test-plan.md");
const testPlanDst = path.join(tmpReviewRoot, "test-plan.md");
fs.copyFileSync(testPlanSrc, testPlanDst);
// Place a .env file inside the allowed review root - used for the denial test.
const envFixturePath = path.join(tmpReviewRoot, ".env");
fs.writeFileSync(envFixturePath, "SECRET=supersecret\n");

// Provision a temp projects root for E2E tests.
// Seeded from committed fixtures/projects.
const tmpProjects = path.join(tmpRoot, "projects");
const fixturesProjects = path.join(repoRoot, "fixtures", "projects");
fs.cpSync(fixturesProjects, tmpProjects, { recursive: true });

// Patch the seeded task-439-card-detail.md so its links: entry
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
// State writes are confined to DATA_ROOT, so the state file lives
// in a dedicated data dir under the temp root.
const tmpData = path.join(tmpRoot, "data");
fs.mkdirSync(tmpData, { recursive: true });
const queueStatePath = path.join(tmpData, "queue-state.json");

// Fixed clock instant (30h after fixture card = 6h overdue on 24h tier).
const mcNow = "2026-06-10T20:30:00Z";

// ---------------------------------------------------------------------------
// Layout server roots (e2e/layout)
// ---------------------------------------------------------------------------
//
// A SECOND app server, on 3918, whose only difference from the main one is
// that it has an ACTIVITY_ROOT and therefore renders the top-bar escalation
// alert. It exists because that alert cannot be turned on per-test: the gate
// is activityEnabled(), which reads ACTIVITY_ROOT once at boot, and setting
// it on the main server would silently flip every other suite onto the
// activity-configured branch (tmux-tab.test.ts asserts the opposite branch by
// name, and the Activity nav link would appear in every header assertion).
// A second server is the only way to add this coverage without editing tests
// that have nothing to do with escalation.
//
// It gets its OWN inbox, data and activity dirs, so resetFixtureInbox() in
// the flows suites cannot pull the thread out from under a layout test, and
// vice versa.
const layoutRoot = path.join(tmpRoot, "layout");
const layoutInbox = path.join(layoutRoot, "inbox");
fs.cpSync(fixturesInbox, layoutInbox, { recursive: true });
const layoutData = path.join(layoutRoot, "data");
fs.mkdirSync(layoutData, { recursive: true });
const layoutAttachments = path.join(layoutRoot, "attachments");
fs.mkdirSync(layoutAttachments, { recursive: true });
const layoutProjects = path.join(layoutRoot, "projects");
fs.cpSync(fixturesProjects, layoutProjects, { recursive: true });
// The escalation state file. Committed at fixtures/activity/activity.json
// with instants pinned relative to MC_NOW above: swept 1 minute ago (well
// inside ACTIVITY_STALE_AFTER_MS, so the view is "live"), quill stuck since
// 45 minutes ago (past ESCALATION_THRESHOLD_MS), which renders the chip as
// exactly "quill stuck for 45m".
const layoutActivity = path.join(layoutRoot, "activity");
fs.cpSync(path.join(repoRoot, "fixtures", "activity"), layoutActivity, {
  recursive: true,
});

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
  // Point the Team tab at a guaranteed-missing tmux session so
  // e2e asserts the deterministic empty-state paths (never live panes).
  `MC_TMUX_SESSION=mc-e2e-missing`,
  `MC_NOW=${mcNow}`,
  `E2E_TEMP_ROOT=${tmpRoot}`,
  // Layout server (3918). LAYOUT_-prefixed so sourcing this file cannot
  // accidentally reconfigure the main server; start-layout-server.sh maps
  // them onto the real names for its own process only.
  `LAYOUT_INBOX_ROOT=${layoutInbox}`,
  `LAYOUT_ATTACHMENTS_ROOT=${layoutAttachments}`,
  `LAYOUT_PROJECTS_ROOT=${layoutProjects}`,
  `LAYOUT_DATA_ROOT=${layoutData}`,
  `LAYOUT_ACTIVITY_ROOT=${layoutActivity}`,
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
process.env["LAYOUT_INBOX_ROOT"] = layoutInbox;
process.env["LAYOUT_ATTACHMENTS_ROOT"] = layoutAttachments;
process.env["LAYOUT_PROJECTS_ROOT"] = layoutProjects;
process.env["LAYOUT_DATA_ROOT"] = layoutData;
process.env["LAYOUT_ACTIVITY_ROOT"] = layoutActivity;

// Print the temp root so the caller can pass it along or record it.
console.log(`E2E_TEMP_ROOT=${tmpRoot}`);
