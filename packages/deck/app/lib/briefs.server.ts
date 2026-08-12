/**
 * briefs.server.ts
 *
 * Data-access seam for the coordinator agent's daily morning brief files (TASK-442).
 *
 * Exports:
 *   getLatestBrief(env, now) - reads <INBOX_ROOT>/quill/briefs/ and returns the
 *     most recent brief that is today or yesterday relative to the injected
 *     now, or null if the dir is absent, empty, or no file is fresh enough.
 *
 * Security:
 *   - Only filenames matching ^\d{4}-\d{2}-\d{2}\.md$ are accepted.
 *   - Resolved-path prefix assert (realpath + sep-suffixed startsWith) before
 *     any read - same idiom as review.server.ts / attachments.server.ts.
 *   - No user-controlled path component anywhere.
 *
 * SEAM RULE (FND-02): env access via resolveInboxRoot (same seam as inbox.server.ts).
 * The .server suffix strips this module from the client bundle.
 * ASCII only - no em-dashes (FND-05).
 */

import fs from "node:fs";
import path from "node:path";
import { resolveInboxRoot } from "./safe-fs.server.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BriefResult {
  /** ISO date string YYYY-MM-DD parsed from the filename. */
  date: string;
  /** Raw markdown content of the brief. */
  markdown: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Strict filename regex: YYYY-MM-DD.md only. Nothing else enters. */
const BRIEF_FILENAME_RE = /^\d{4}-\d{2}-\d{2}\.md$/;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract the date string YYYY-MM-DD from a matching brief filename.
 * Callers must only pass filenames that already passed BRIEF_FILENAME_RE.
 */
function dateFromFilename(filename: string): string {
  return filename.slice(0, 10);
}

/**
 * Compare two ISO date strings YYYY-MM-DD.
 * Returns negative, zero, or positive (lexicographic on ISO dates is total).
 */
function compareDates(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Format a Date as a YYYY-MM-DD string in LOCAL time terms, consistent with
 * how MC_NOW is consumed elsewhere (the MC_NOW pattern treats the ISO string
 * as a wall-clock instant; date comparisons are done against the date portion
 * of that instant in UTC, since the briefs are stamped UTC-midnight by Quill's
 * cron).
 *
 * We use UTC date extraction so that a brief dated 2026-06-10 (UTC) is
 * considered "today" when MC_NOW is 2026-06-10T20:30:00Z, regardless of the
 * server's local timezone. This is consistent with Quill's cron writing the brief
 * at ~07:50 UTC.
 */
function toUtcDateString(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

// ---------------------------------------------------------------------------
// getLatestBrief
// ---------------------------------------------------------------------------

/**
 * Read the most recent morning brief that is today or yesterday relative
 * to the injected now.
 *
 * @param env - Process environment (INBOX_ROOT is resolved from here).
 * @param now - The current instant (use MC_NOW if set, else real clock).
 *   Injected so tests can freeze time without touching process.env.
 * @returns BriefResult or null.
 *
 * Error behaviour:
 *   - INBOX_ROOT unset: follows the same pattern as stores.server.ts /
 *     FileInboxRepository - resolveInboxRoot() throws; this propagates to
 *     the caller (loader wraps in try/catch -> null).
 *   - Dir missing / empty / no fresh file: returns null (never throws).
 *   - Unexpected fs errors (e.g. permission denied): caught -> null.
 */
export async function getLatestBrief(
  env: NodeJS.ProcessEnv,
  now: Date
): Promise<BriefResult | null> {
  // Resolve INBOX_ROOT - may throw if unset; let that propagate (same behaviour
  // as FileInboxRepository.getRoot() / makeStores). The home.tsx loader wraps
  // getLatestBrief in try/catch -> null.
  const inboxRoot = env["INBOX_ROOT"]?.trim()
    ? env["INBOX_ROOT"]
    : resolveInboxRoot();

  // ------------------------------------------------------------------
  // Prefix assert: verify briefsDir is inside INBOX_ROOT.
  // Manager-review fix: build briefsDir from the RESOLVED root so a
  // symlinked INBOX_ROOT (e.g. a mirror dir) cannot fail the containment
  // check and silently kill the feature. Containment is then true by
  // construction; the assert below stays as the house-idiom tripwire.
  // ------------------------------------------------------------------
  let briefsDirReal: string;
  try {
    const inboxRootReal = fs.realpathSync(inboxRoot);
    const briefsDir = path.join(inboxRootReal, "quill", "briefs");
    // Both the sep-suffixed and exact forms are valid (same as review.server.ts).
    const isContained =
      briefsDir === inboxRootReal ||
      briefsDir.startsWith(inboxRootReal + path.sep);

    if (!isContained) {
      // Should never happen - briefsDir is built from inboxRootReal.
      throw new Error(
        `briefs dir "${briefsDir}" is outside INBOX_ROOT "${inboxRootReal}".`
      );
    }

    // Now try to resolve the actual dir (may not exist - ENOENT -> null).
    briefsDirReal = fs.realpathSync(briefsDir);
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      // Dir does not exist - feature degrades gracefully.
      return null;
    }
    // Any other fs error (permission, etc): degrade.
    return null;
  }

  // ------------------------------------------------------------------
  // Read directory, filter to strict-matching filenames.
  // ------------------------------------------------------------------
  let entries: string[];
  try {
    entries = await fs.promises.readdir(briefsDirReal);
  } catch {
    return null;
  }

  const dateFiles = entries.filter((e) => BRIEF_FILENAME_RE.test(e));
  if (dateFiles.length === 0) return null;

  // Lexicographic max of ISO-date filenames = newest.
  const newest = dateFiles.reduce((best, cur) =>
    compareDates(cur, best) > 0 ? cur : best
  );

  const briefDate = dateFromFilename(newest);

  // ------------------------------------------------------------------
  // Freshness check: today or yesterday (UTC, consistent with MC_NOW).
  // ------------------------------------------------------------------
  const todayStr = toUtcDateString(now);
  const yesterdayDate = new Date(now);
  yesterdayDate.setUTCDate(yesterdayDate.getUTCDate() - 1);
  const yesterdayStr = toUtcDateString(yesterdayDate);

  if (briefDate !== todayStr && briefDate !== yesterdayStr) {
    return null;
  }

  // ------------------------------------------------------------------
  // Read the file. Prefix assert on the fully resolved file path.
  // ------------------------------------------------------------------
  const filePath = path.join(briefsDirReal, newest);
  let fileReal: string;
  try {
    fileReal = fs.realpathSync(filePath);
  } catch {
    return null;
  }

  // Containment: fileReal must be inside briefsDirReal.
  const contained =
    fileReal === briefsDirReal ||
    fileReal.startsWith(briefsDirReal + path.sep);
  if (!contained) {
    return null;
  }

  let markdown: string;
  try {
    markdown = await fs.promises.readFile(fileReal, "utf8");
  } catch {
    return null;
  }

  return { date: briefDate, markdown };
}
