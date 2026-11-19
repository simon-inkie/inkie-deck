/**
 * dev-paths.mjs - where `pnpm dev` keeps its throwaway state, and the reseed
 * that runs on every start. Split out of dev.mjs so a test can run the same
 * code (test/drafts.test.ts: drafts survive a dev restart).
 *
 * `.runtime/` is deleted and reseeded on every start. The drafts workspace is
 * deliberately NOT under it: drafts are the person's work.
 *
 * ASCII only - no em-dashes.
 */
import { cpSync, rmSync, mkdirSync, existsSync } from "node:fs";
import path from "node:path";

/** @param {string} root the packages/deck directory */
export function devPaths(root) {
  const runtimeDir = path.join(root, ".runtime");
  return {
    runtimeDir,
    runtimeInbox: path.join(runtimeDir, "inbox"),
    runtimeAttachments: path.join(runtimeDir, "attachments"),
    runtimeProjects: path.join(runtimeDir, "projects"),
    runtimeData: path.join(runtimeDir, "data"),
    // Outside .runtime on purpose: see the header.
    runtimeWorkspace: path.join(root, ".workspace"),
  };
}

/**
 * Wipe and reseed `.runtime/`, and make sure the workspace exists without
 * touching what is already in it.
 *
 * @param {string} root the packages/deck directory
 * @returns {string} the fixture directory the inbox was seeded from
 */
export function resetRuntime(root) {
  const p = devPaths(root);
  const demoInbox = path.join(root, "fixtures", "demo-inbox");
  // Fall back to the minimal fixture set if the demo inbox is absent.
  const source = existsSync(demoInbox) ? demoInbox : path.join(root, "fixtures", "inbox");

  rmSync(p.runtimeDir, { recursive: true, force: true });
  mkdirSync(p.runtimeDir, { recursive: true });
  cpSync(source, p.runtimeInbox, { recursive: true });
  mkdirSync(p.runtimeAttachments, { recursive: true });
  // Demo attachments (the images and files the demo threads link to), when
  // present. Same <agent>/mc/<file> shape the attachments route serves.
  const demoAttachments = path.join(root, "fixtures", "demo-attachments");
  if (existsSync(demoAttachments)) {
    cpSync(demoAttachments, p.runtimeAttachments, { recursive: true });
  }
  // Seed the projects runtime dir from fixtures/demo-projects, falling back to
  // fixtures/projects. The demo board is separate because the e2e suite counts
  // the cards in fixtures/projects column by column.
  const demoProjects = path.join(root, "fixtures", "demo-projects");
  const projectsSource = existsSync(demoProjects)
    ? demoProjects
    : path.join(root, "fixtures", "projects");
  cpSync(projectsSource, p.runtimeProjects, { recursive: true });
  // DATA_ROOT for Deck state files (queue state) - must exist at boot.
  mkdirSync(p.runtimeData, { recursive: true });
  mkdirSync(p.runtimeWorkspace, { recursive: true });
  return source;
}
