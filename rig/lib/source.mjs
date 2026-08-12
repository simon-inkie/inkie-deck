/**
 * Getting source into a container.
 *
 * The rule is `git archive` of a COMMITTED tree, never a bind mount of the
 * working copy. A bind mount carries `node_modules/`, `.runtime/` and the
 * dev build across, which are precisely the three things that make a
 * clean-install measurement meaningless: every machine that has ever run this
 * product already had them, which is why nobody noticed what the product
 * assumes.
 *
 * The pure functions here (the dirty-tree refusal and the contamination
 * predicate) are separated from the git calls so the self-test can exercise
 * the decisions without a repository.
 */
import * as path from "node:path";
import { must, exec, RigError } from "./exec.mjs";
import { ARCHIVE_CONTAMINATION_ALLOWLIST, ARCHIVE_CONTAMINATION_PATTERNS } from "../expected.mjs";

/**
 * Decide whether a working tree may be archived.
 *
 * @param {{ porcelain: string, allowDirty: boolean }} spec
 * @returns {{ dirty: boolean, refuse: boolean, entries: string[] }}
 */
export function dirtyTreeDecision({ porcelain, allowDirty }) {
  const entries = porcelain.split("\n").map((line) => line.trim()).filter(Boolean);
  const dirty = entries.length > 0;
  return { dirty, refuse: dirty && !allowDirty, entries };
}

/**
 * Which archive entries are developer state rather than source.
 *
 * @param {string[]} entries  archive member paths
 * @returns {string[]}
 */
export function contaminatedEntries(entries) {
  return entries.filter(
    (entry) =>
      ARCHIVE_CONTAMINATION_PATTERNS.some((pattern) => pattern.test(entry)) &&
      !ARCHIVE_CONTAMINATION_ALLOWLIST.some((allowed) => allowed.test(entry)),
  );
}

/** @param {string} repoRoot */
export function headSha(repoRoot) {
  return must("git", ["-C", repoRoot, "rev-parse", "HEAD"]).stdout.trim();
}

/** @param {string} repoRoot */
export function porcelainStatus(repoRoot) {
  return must("git", ["-C", repoRoot, "status", "--porcelain"]).stdout;
}

/**
 * Archive the committed tree at HEAD.
 *
 * @param {{ repoRoot: string, contextDir: string, sha: string }} spec
 * @returns {{ tarPath: string, entries: string[] }}
 */
export function archiveHead({ repoRoot, contextDir, sha }) {
  const tarPath = path.join(contextDir, "source.tar");
  must("git", ["-C", repoRoot, "archive", "--format=tar", "-o", tarPath, sha]);
  const listed = exec("tar", ["-tf", tarPath]);
  if (!listed.ok) {
    throw new RigError(`could not list the source archive: ${listed.output.trim()}`);
  }
  const entries = listed.stdout.split("\n").filter(Boolean);
  if (entries.length === 0) {
    throw new RigError("the source archive is empty");
  }
  return { tarPath, entries };
}
