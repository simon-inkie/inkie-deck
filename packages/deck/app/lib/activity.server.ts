/**
 * activity.server.ts - read-only data-access seam for the agent-activity state
 * file (TASK-691 step 1, plan section 4).
 *
 * ONE file, written by ONE external producer (a 60s sweep script), read
 * by TWO independent consumers: this seam and the `activity` query CLI. MC only
 * ever reads it. There is no write path in this module, deliberately: the pin
 * override the plan calls for (section 5) is the CLI's `activity pin`, and
 * adding a second writer to a file whose producer merges its own prior state
 * every tick is how a pin silently disappears.
 *
 * ACTIVITY_ROOT is a NEW env var, a sibling of INBOX_ROOT / PROJECTS_ROOT /
 * ATTACHMENTS_ROOT (plan decision Q2). It is deliberately NOT in
 * validateConfiguredRoots' required table: those roots are load-bearing for
 * every instance and boot fails loudly without them, whereas an instance with
 * no ACTIVITY_ROOT is simply an instance without this panel. That is the whole
 * gate (see activityEnabled in instance.server.ts) - Robin's instance gets the
 * panel the day her .env gains the variable, which is a config change, not a
 * rewrite (decision Q6).
 *
 * NO DEFAULT for the root, on purpose. The producer's own default is
 * ~/.the-vault/activity, and both daemons run as the same user on the same box,
 * so defaulting here would hand Robin's instance Alex's panel with no config
 * anywhere saying so. Absence of the variable IS the off switch.
 *
 * DEGRADE, NEVER THROW. readActivity returns an explicit "offline" shape for
 * every failure - missing file, unreadable file, corrupt JSON, unknown schema,
 * stale sweep - and the route renders that honestly. The sweep is not on cron
 * yet, so at the time of writing the missing-file path is the ONLY path that
 * ever runs in production; it is the primary case, not an edge case.
 *
 * SEAM RULE (FND-02): the .server suffix strips this from the client bundle;
 * routes call it with process.env and never touch fs or the path shape. Types
 * and pure helpers live in activity.shared.ts so the component can import them.
 *
 * ASCII only - no em-dashes (FND-05).
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  parseActivityDocument,
  type ActivityView,
  type ActivityOfflineReason,
  type AgentActivity,
} from "./activity.shared";

// ---------------------------------------------------------------------------
// Root + file resolution
// ---------------------------------------------------------------------------

/** The one file this seam reads, inside ACTIVITY_ROOT. */
export const ACTIVITY_FILENAME = "activity.json";

/**
 * Resolve ACTIVITY_ROOT, or undefined when this instance has no activity
 * surface configured.
 *
 * undefined (not a throw, not a default) is the answer for unset, blank, and
 * relative values: a relative root would resolve against whatever cwd the
 * daemon happened to start in, which is a silently wrong directory rather than
 * a configured one. A leading ~ is expanded, matching resolveAgentsRoot.
 */
export function resolveActivityRoot(env: NodeJS.ProcessEnv): string | undefined {
  const raw = env["ACTIVITY_ROOT"]?.trim();
  if (!raw) return undefined;
  if (raw === "~") return os.homedir();
  if (raw.startsWith("~/")) return path.join(os.homedir(), raw.slice(2));
  if (!path.isAbsolute(raw)) return undefined;
  return raw;
}

/** Absolute path of the state file, or undefined when unconfigured. */
export function activityFilePath(env: NodeJS.ProcessEnv): string | undefined {
  const root = resolveActivityRoot(env);
  return root === undefined ? undefined : path.join(root, ACTIVITY_FILENAME);
}

// ---------------------------------------------------------------------------
// Staleness
// ---------------------------------------------------------------------------

/**
 * How old a `swept` timestamp may be before the panel calls the engine offline.
 *
 * 10 minutes. The reasoning, since this is the one number here that is a
 * judgement call:
 *   - The intended live cadence is 60s (the plan's cost model assumes it), so
 *     10 minutes is ten consecutive missed ticks: never a hiccup, always a
 *     genuine outage.
 *   - The producer's own SPEC recommends a first shadow window at a five-minute
 *     cron cadence, i.e. one write per 5 minutes. A threshold at or under 5
 *     minutes would flap
 *     between "live" and "offline" for the entire shadow period and teach Alex
 *     to ignore the banner before the feature is even proven.
 *   - It is short enough that a wrong pill is visibly wrong quickly. A status
 *     pill is a claim about NOW; the longer this window, the longer a dead
 *     engine can keep making one.
 * Exported so the tests pin it rather than restating it.
 */
export const ACTIVITY_STALE_AFTER_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Top-bar escalation threshold
// ---------------------------------------------------------------------------

/**
 * Default duration (ms) an agent must sit `stuck`/`needs-you` before the
 * top-bar escalation alert fires (top-bar escalation SPEC).
 *
 * 30 minutes. NOT SPECIFIED by Alex ("a certain amount of time") - the
 * SPEC's own proposed default, flagged there as an assumption to correct
 * rather than a blocker: long enough that a normal working pause never
 * fires, short enough to have caught the incident that prompted the feature
 * (an agent wedged for most of a day) with hours to spare. Overridable
 * per-instance via ESCALATION_THRESHOLD_MS, same convention as
 * ACTIVITY_STALE_AFTER_MS's would-be override - a single constant either way.
 */
export const ESCALATION_THRESHOLD_MS = 30 * 60 * 1000;

/**
 * Resolve the escalation threshold from env, degrading to the default on any
 * unset/blank/unparseable/non-positive value rather than throwing or letting
 * a bad env var produce a threshold of 0 (which would escalate everything)
 * or NaN (which would escalate nothing, silently). Same posture as
 * resolveNow (time.ts): a bad override degrades, it never crashes the loader.
 */
export function resolveEscalationThresholdMs(env: NodeJS.ProcessEnv): number {
  const raw = env["ESCALATION_THRESHOLD_MS"]?.trim();
  if (!raw) return ESCALATION_THRESHOLD_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    console.warn(
      `[activity] ESCALATION_THRESHOLD_MS value "${raw}" is invalid - falling back to default ${ESCALATION_THRESHOLD_MS}ms`
    );
    return ESCALATION_THRESHOLD_MS;
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// readActivity
// ---------------------------------------------------------------------------

function offline(
  reason: ActivityOfflineReason,
  detail: string,
  sweptAt: string | null = null,
  agents: AgentActivity[] = []
): ActivityView {
  return { state: "offline", reason, sweptAt, detail, agents };
}

/**
 * Read the activity state file and return what the panel may honestly claim.
 *
 * @param env - process.env (ACTIVITY_ROOT is read from here).
 * @param now - injected instant (MC_NOW pattern, same as getLatestBrief) so the
 *   staleness boundary is deterministic under test and in e2e.
 * @param staleAfterMs - override for the staleness window; tests pin the
 *   default rather than restating it.
 *
 * NEVER THROWS. Every failure becomes an offline shape carrying the raw
 * observation (errno, versions, the path it looked at) in `detail`, not just a
 * verdict - a panel that says "offline" without saying what it saw makes the
 * next diagnosis start from scratch.
 *
 * A `swept` timestamp in the FUTURE is treated as fresh, not stale: negative
 * age means clock skew between the sweep host and MC (same box today, but the
 * failure mode of calling a live engine dead is worse than the reverse, and the
 * banner would be nonsense - "offline since" a time that has not happened).
 */
export function readActivity(
  env: NodeJS.ProcessEnv,
  now: Date,
  staleAfterMs: number = ACTIVITY_STALE_AFTER_MS
): ActivityView {
  const file = activityFilePath(env);
  if (file === undefined) {
    return offline(
      "unconfigured",
      "ACTIVITY_ROOT is not set to an absolute path on this instance"
    );
  }

  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return offline(
        "missing",
        `no state file at ${file} - the activity sweep has not run yet`
      );
    }
    return offline(
      "unreadable",
      `could not read ${file}: ${code ?? (err instanceof Error ? err.message : String(err))}`
    );
  }

  const parsed = parseActivityDocument(raw);
  if (!parsed.ok) {
    return offline(parsed.reason, `${parsed.detail} (${file})`);
  }

  const { doc } = parsed;
  const sweptMs = new Date(doc.swept).getTime();
  if (Number.isNaN(sweptMs)) {
    return offline(
      "corrupt",
      `unparseable \`swept\` timestamp "${doc.swept}" (${file})`
    );
  }

  const age = now.getTime() - sweptMs;
  if (age > staleAfterMs) {
    // The data is intact; what has expired is our right to present it as the
    // current state. The agents travel WITH the verdict (2026-07-31): the panel
    // shows them dimmed under an offline banner, because "the engine died and
    // summit was last seen working on task-599" is a more useful truth than a
    // blank panel, and the timestamp beside it is what stops it reading as now.
    // The row rendering is where that distinction is enforced, not here - this
    // seam's job is to hand over everything it legitimately knows.
    return offline(
      "stale",
      `last sweep was ${Math.round(age / 60000)} minutes ago (${file})`,
      doc.swept,
      doc.agents
    );
  }

  return {
    state: "live",
    sweptAt: doc.swept,
    agents: doc.agents,
    notes: doc.notes,
    generator: doc.generator,
  };
}
