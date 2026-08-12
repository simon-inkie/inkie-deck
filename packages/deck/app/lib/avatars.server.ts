/**
 * avatars.server.ts - guarded reads of agent avatar files (TASK-457).
 *
 * Convention (Quill, 2026-06-07): a square avatar.png at the agent's silo root,
 * <INBOX_ROOT>/<agent>/avatar.png. Reads come off the SAME root the inbox
 * seam reads - no new root (the brief's constraint). This module is a NEW
 * reader that MIRRORS the safe-fs guard shapes by importing them; it does
 * not modify the guard libs (the platform layer's lane).
 *
 * Guard chain per read:
 *   1. agent name regex (ROSTER convention) - rejects traversal before any
 *      fs call; a single path segment by construction.
 *   2. resolved (realpath) root - never join against a non-resolved root
 *      (the briefs.server symlink lesson: a symlinked INBOX_ROOT must not
 *      silently break containment comparisons).
 *   3. confineToRootReal - parent realpath + basename, final-component
 *      realpath, sep-suffixed prefix assert (safe-fs canonical shape).
 *
 * All failures (missing file, bad name, escape attempt) surface as undefined
 * to callers - an absent avatar is NORMAL (initials fallback), and the
 * serving route turns undefined into a reasonless 404.
 *
 * ASCII only - no em-dashes (FND-05).
 */
import fs from "node:fs";
import path from "node:path";
import { resolveInboxRoot, confineToRootReal } from "./safe-fs.server.js";

/** ROSTER agent-name convention - also the route's early-reject gate. */
export const AGENT_NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Resolve and confine the avatar path for an agent. Returns undefined on
 * any failure (bad name, unset root, missing file, containment violation).
 */
function avatarPath(agent: string): string | undefined {
  if (!AGENT_NAME_RE.test(agent)) return undefined;
  let rootReal: string;
  try {
    rootReal = fs.realpathSync(resolveInboxRoot());
  } catch {
    return undefined;
  }
  const candidate = path.join(rootReal, agent, "avatar.png");
  try {
    return confineToRootReal(candidate, rootReal, {
      label: "avatars",
      forWrite: false,
    });
  } catch {
    // Atlas fold (457 review): a PRESENT-but-rejected file - typically an
    // avatar.png symlinked to somewhere outside the inbox root - would
    // otherwise fail as SILENT initials with no trail. Warn server-side;
    // the external response stays a reasonless 404.
    try {
      fs.lstatSync(candidate);
      console.warn(
        `[avatars] avatar present but rejected for "${agent}": it resolves ` +
          `outside the inbox root. Copy the file into the silo - do not ` +
          `symlink from outside (FND-03 containment).`
      );
    } catch {
      // Plain missing file - the normal initials-fallback case, no noise.
    }
    return undefined;
  }
}

/**
 * mtimeMs of the agent's avatar.png, or undefined when absent/unreadable.
 * Loaders use this to build the cache-busting ?v= URL - a new file IS a
 * new URL, so the route can serve immutable.
 */
export function avatarVersion(agent: string): number | undefined {
  const p = avatarPath(agent);
  if (p === undefined) return undefined;
  try {
    const stat = fs.statSync(p);
    return stat.isFile() ? Math.floor(stat.mtimeMs) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Convenience for loaders: the serving URL with cache-bust version, or
 * undefined when the agent has no avatar (callers fall back to initials).
 */
export function avatarUrl(agent: string): string | undefined {
  const v = avatarVersion(agent);
  return v === undefined ? undefined : `/avatars/${agent}?v=${v}`;
}

/**
 * Read the avatar bytes for the serving route. undefined on any failure -
 * the route responds 404 with no reason leak.
 */
export function readAvatar(agent: string): Buffer | undefined {
  const p = avatarPath(agent);
  if (p === undefined) return undefined;
  try {
    return fs.readFileSync(p);
  } catch {
    return undefined;
  }
}
