/**
 * activity.shared.ts - types + pure view-model helpers for the agent-activity
 * panel (TASK-691 step 1, the MC half).
 *
 * The producer is an external sweep script, a deterministic 60s
 * sweep that writes ONE file, `$ACTIVITY_ROOT/activity.json`. MC is a
 * READ-ONLY consumer of it (the query CLI is the other one). This module owns
 * the wire types and every pure decision made about them; activity.server.ts
 * owns the env + fs half.
 *
 * Why a .shared module and not just activity.server.ts: the panel component
 * needs the types and the pure label/tone helpers, and importing values from a
 * .server module into a client component is the exact thing FND-02 forbids
 * (same reasoning as projects.shared.ts, which exists for this).
 *
 * PARSING POSTURE - per-field tolerance, not all-or-nothing. The file is
 * written by a different program on a different release cycle, so every field
 * is coerced defensively and a bad one degrades to a null/empty rather than
 * rejecting the record. One agent with a malformed worktree object must not
 * blank the panel for the other eleven. The two things that DO reject the whole
 * document are a parse failure and an unrecognised `schema` version, because in
 * both cases nothing below can be trusted to mean what it says.
 *
 * ASCII only - no em-dashes (FND-05).
 */

// ---------------------------------------------------------------------------
// Wire types (pinned against the sweep's documented schema, v1)
// ---------------------------------------------------------------------------

/**
 * The status taxonomy (plan section 3, sweep schema field `status`).
 *
 * `waiting-on-machine` is RESERVED by the producer and never emitted today (no
 * honest deterministic signal for it exists yet); it is carried here so the day
 * it starts being emitted the panel renders it instead of falling to unknown.
 *
 * `unknown` is NOT a verdict. It is the sentinel for "no observation at all"
 * and is styled distinctly for that reason - it must never read as "fine".
 */
export const ACTIVITY_STATUSES = [
  "working",
  "stuck",
  "needs-you",
  "waiting-on-teammate",
  "waiting-on-machine",
  "done-for-now",
  "unknown",
] as const;

export type ActivityStatus = (typeof ACTIVITY_STATUSES)[number];

/**
 * Worktree confidence. high/medium/low/none come from the scorer's top-two
 * margin; "pinned" is the fourth value the sweep emits when a manual pin in
 * pins.json overrides the scorer (verified in the producer source, not just its
 * schema note - the schema prose lists only the first four).
 */
export const WORKTREE_CONFIDENCES = ["high", "medium", "low", "none", "pinned"] as const;

export type WorktreeConfidence = (typeof WORKTREE_CONFIDENCES)[number];

/** A runner-up worktree. NOT debug output: this is what makes a wrong guess cheap to correct by eye. */
export interface WorktreeAlternative {
  path: string;
  branch: string | null;
  score: number | null;
}

/** What the scorer would have said. Populated only when the agent is pinned. */
export interface WorktreeGuess {
  path: string | null;
  branch: string | null;
  confidence: WorktreeConfidence;
  score: number | null;
  reasons: string[];
  alternatives: WorktreeAlternative[];
}

export interface AgentWorktree {
  path: string | null;
  branch: string | null;
  confidence: WorktreeConfidence;
  score: number | null;
  reasons: string[];
  alternatives: WorktreeAlternative[];
  pinned: boolean;
  pinnedBy: string | null;
  pinnedAt: string | null;
  /** Non-null only when pinned - the scorer's answer, kept visible beside the pin. */
  guess: WorktreeGuess | null;
}

/** One entry in the rolling recent-completions log (plan section 10). */
export interface RecentCompletion {
  /** Dedup key: "commit:<sha>" or "inbox:<thread>:<ts>". */
  key: string;
  /** ISO-8601 UTC instant. */
  at: string;
  /** "commit" | "inbox" today; carried as a free string so a new kind renders. */
  kind: string;
  label: string;
  /** Source: "<worktree>@<sha>" or the thread file. */
  ref: string;
}

export interface AgentActivity {
  agent: string;
  status: ActivityStatus;
  /** Machine-readable name of what fired. */
  signal: string;
  /** The human sentence for the same thing - the inspectable half of the pill. */
  evidence: string;
  busy: boolean;
  idleMinutes: number | null;
  worktree: AgentWorktree | null;
  recent: RecentCompletion[];
  updated: string | null;
}

export interface ActivityDocument {
  schema: number;
  generator: string;
  /** ISO-8601 UTC instant the sweep finished. */
  swept: string;
  worktreeCandidates: number | null;
  worktreeRootsSource: string | null;
  notes: string[];
  /** Agents in the order the sweep wrote them (tmux window order). */
  agents: AgentActivity[];
}

/** The schema version this reader understands. */
export const SUPPORTED_ACTIVITY_SCHEMA = 1;

// ---------------------------------------------------------------------------
// The loader-facing view
// ---------------------------------------------------------------------------

/**
 * Why the panel has nothing trustworthy to show.
 *
 *   unconfigured - ACTIVITY_ROOT unset/relative (the gate should have caught
 *                  this first; carried so the seam is honest when called anyway)
 *   missing      - no activity.json at all (fresh install, sweep never ran)
 *   unreadable   - it exists but the read failed (permissions, it is a dir, ...)
 *   corrupt      - present but not parseable JSON (includes a torn read: the
 *                  producer replaces the file with `mv` from /tmp, which is not
 *                  guaranteed atomic across filesystems)
 *   unsupported  - parsed, but `schema` is a version this build does not know
 *   stale        - parsed and valid, but `swept` is older than the threshold,
 *                  i.e. the engine is offline and the pills are no longer
 *                  claims about now
 */
export type ActivityOfflineReason =
  | "unconfigured"
  | "missing"
  | "unreadable"
  | "corrupt"
  | "unsupported-schema"
  | "stale";

export interface ActivityLive {
  state: "live";
  /** ISO instant of the last sweep. */
  sweptAt: string;
  agents: AgentActivity[];
  /** Producer-side notes (e.g. "no candidate worktrees found"). */
  notes: string[];
  generator: string;
}

export interface ActivityOffline {
  state: "offline";
  reason: ActivityOfflineReason;
  /** Last sweep instant when we have one (stale case), else null. */
  sweptAt: string | null;
  /** The raw observation, not just the verdict - error text, versions, path. */
  detail: string;
  /**
   * The LAST-KNOWN agents, i.e. what the stale document still says. Empty for
   * every reason except `stale`: those are the states where nothing parseable
   * exists (missing/unreadable/corrupt) or where the shape cannot be trusted to
   * mean what it says (unsupported-schema), and inventing rows for them would
   * be exactly the confident-wrong-answer this feature exists to avoid.
   *
   * Carried (2026-07-31, Alex after seeing the offline state live) so the
   * panel can keep showing the last cards under the offline banner instead of
   * blanking. The count the banner used to be handed separately is
   * `agents.length` now: one array, no second field to drift out of step with
   * what is actually rendered below the sentence quoting it.
   */
  agents: AgentActivity[];
}

export type ActivityView = ActivityLive | ActivityOffline;

export type ParseActivityResult =
  | { ok: true; doc: ActivityDocument }
  | { ok: false; reason: "corrupt" | "unsupported-schema"; detail: string };

// ---------------------------------------------------------------------------
// Coercion helpers (defensive, per-field)
// ---------------------------------------------------------------------------

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

function strOr(v: unknown, fallback: string): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function bool(v: unknown): boolean {
  return v === true;
}

function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((e): e is string => typeof e === "string") : [];
}

function asStatus(v: unknown): ActivityStatus {
  return (ACTIVITY_STATUSES as readonly string[]).includes(v as string)
    ? (v as ActivityStatus)
    : "unknown";
}

function asConfidence(v: unknown): WorktreeConfidence {
  return (WORKTREE_CONFIDENCES as readonly string[]).includes(v as string)
    ? (v as WorktreeConfidence)
    : "none";
}

function asAlternatives(v: unknown): WorktreeAlternative[] {
  if (!Array.isArray(v)) return [];
  const out: WorktreeAlternative[] = [];
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    const p = str(entry["path"]);
    // A runner-up with no path says nothing a reader can act on.
    if (p === null || p === "") continue;
    out.push({ path: p, branch: str(entry["branch"]), score: num(entry["score"]) });
  }
  return out;
}

function asGuess(v: unknown): WorktreeGuess | null {
  if (!isRecord(v)) return null;
  return {
    path: str(v["path"]),
    branch: str(v["branch"]),
    confidence: asConfidence(v["confidence"]),
    score: num(v["score"]),
    reasons: strArray(v["reasons"]),
    alternatives: asAlternatives(v["alternatives"]),
  };
}

function asWorktree(v: unknown): AgentWorktree | null {
  if (!isRecord(v)) return null;
  return {
    path: str(v["path"]),
    branch: str(v["branch"]),
    confidence: asConfidence(v["confidence"]),
    score: num(v["score"]),
    reasons: strArray(v["reasons"]),
    alternatives: asAlternatives(v["alternatives"]),
    pinned: bool(v["pinned"]),
    pinnedBy: str(v["pinnedBy"]),
    pinnedAt: str(v["pinnedAt"]),
    guess: asGuess(v["guess"]),
  };
}

function asRecent(v: unknown): RecentCompletion[] {
  if (!Array.isArray(v)) return [];
  const out: RecentCompletion[] = [];
  for (const entry of v) {
    if (!isRecord(entry)) continue;
    const label = str(entry["label"]);
    if (label === null) continue; // nothing to show
    out.push({
      key: strOr(entry["key"], ""),
      at: strOr(entry["at"], ""),
      kind: strOr(entry["kind"], ""),
      label,
      ref: strOr(entry["ref"], ""),
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// parseActivityDocument
// ---------------------------------------------------------------------------

/**
 * Parse the raw file text into a document, or say why it could not be trusted.
 *
 * Pure (string in, result out) so the whole corrupt/version matrix is testable
 * without touching a filesystem.
 *
 * The two hard rejections:
 *   1. Not JSON, or not a JSON object. Includes the empty-file and torn-read
 *      cases, which are live possibilities rather than theory (see the note on
 *      ActivityOfflineReason).
 *   2. `schema` is not the version this build knows. The producer put a version
 *      in the file precisely so the first breaking change has somewhere to say
 *      so; rendering an unknown shape confidently is the failure this whole
 *      feature is meant to avoid. The detail names BOTH versions so the fix is
 *      obvious from the panel alone.
 *
 * A missing `swept` is also a rejection (corrupt): every honest state this
 * panel can render is anchored to that instant, and a document without one
 * cannot be judged fresh or stale, only guessed at.
 */
export function parseActivityDocument(text: string): ParseActivityResult {
  if (text.trim() === "") {
    return { ok: false, reason: "corrupt", detail: "the state file is empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return {
      ok: false,
      reason: "corrupt",
      detail: `not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!isRecord(parsed)) {
    return {
      ok: false,
      reason: "corrupt",
      detail: `expected a JSON object, got ${Array.isArray(parsed) ? "an array" : typeof parsed}`,
    };
  }

  const schema = num(parsed["schema"]);
  if (schema !== SUPPORTED_ACTIVITY_SCHEMA) {
    return {
      ok: false,
      reason: "unsupported-schema",
      detail:
        `state file schema is ${schema === null ? "absent" : String(schema)}, ` +
        `this build reads schema ${SUPPORTED_ACTIVITY_SCHEMA}`,
    };
  }

  const swept = str(parsed["swept"]);
  if (swept === null || swept.trim() === "") {
    return {
      ok: false,
      reason: "corrupt",
      detail: "no `swept` timestamp - freshness cannot be judged",
    };
  }

  const agentsRaw = parsed["agents"];
  const agents: AgentActivity[] = [];
  if (isRecord(agentsRaw)) {
    // Object key order is the sweep's write order (tmux window order).
    for (const [name, value] of Object.entries(agentsRaw)) {
      if (!isRecord(value)) continue;
      agents.push({
        agent: name,
        status: asStatus(value["status"]),
        signal: strOr(value["signal"], ""),
        evidence: strOr(value["evidence"], ""),
        busy: bool(value["busy"]),
        idleMinutes: num(value["idleMinutes"]),
        worktree: asWorktree(value["worktree"]),
        recent: asRecent(value["recent"]),
        updated: str(value["updated"]),
      });
    }
  }

  return {
    ok: true,
    doc: {
      schema,
      generator: strOr(parsed["generator"], "unknown"),
      swept,
      worktreeCandidates: num(parsed["worktreeCandidates"]),
      worktreeRootsSource: str(parsed["worktreeRootsSource"]),
      notes: strArray(parsed["notes"]),
      agents,
    },
  };
}

// ---------------------------------------------------------------------------
// Roster join
// ---------------------------------------------------------------------------

/** Signal used on rows MC synthesises for a live window the sweep did not cover. */
export const NOT_SWEPT_SIGNAL = "not-swept";

/**
 * Join the swept agents with the live tmux windows.
 *
 * The sweep does NOT necessarily cover every window: it enumerates
 * `tmux list-windows` at ITS tick and honours ACTIVITY_SKIP_AGENTS, which
 * defaults to skipping `nova`. So "a window with no record" is a real, everyday
 * state on this box, not a theoretical one, and it must render as `unknown`
 * ("no observation") rather than being silently dropped - a missing row would
 * read as "that agent does not exist".
 *
 * Order: swept agents first, in the file's own order (which is the sweep's tmux
 * window order), then any live window with no record. Keeping the file's order
 * primary means the panel stays stable and complete even when MC itself cannot
 * reach tmux (windows === []).
 */
export function activityRows(
  agents: AgentActivity[],
  windows: string[]
): AgentActivity[] {
  const seen = new Set(agents.map((a) => a.agent));
  const extra: AgentActivity[] = [];
  for (const w of windows) {
    if (seen.has(w)) continue;
    seen.add(w); // a duplicated window name must not produce two rows
    extra.push({
      agent: w,
      status: "unknown",
      signal: NOT_SWEPT_SIGNAL,
      evidence:
        "no record in the last sweep - the window may have opened since, or be " +
        "on the sweep's skip list",
      busy: false,
      idleMinutes: null,
      worktree: null,
      recent: [],
      updated: null,
    });
  }
  return [...agents, ...extra];
}

// ---------------------------------------------------------------------------
// Display helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Human label for a pill. `unknown` deliberately does NOT render as "unknown":
 * it renders as what it actually means, so it cannot be read as a verdict.
 */
export function statusLabel(status: ActivityStatus): string {
  switch (status) {
    case "working":
      return "working";
    case "stuck":
      return "stuck";
    case "needs-you":
      return "needs you";
    case "waiting-on-teammate":
      return "waiting on teammate";
    case "waiting-on-machine":
      return "waiting on machine";
    case "done-for-now":
      return "idle";
    case "unknown":
      return "no observation";
  }
}

/**
 * Confidence phrasing for the worktree chip. "none" is stated as the sweep
 * meaning it: no candidate scored, so nothing is claimed.
 */
export function confidenceLabel(confidence: WorktreeConfidence): string {
  switch (confidence) {
    case "pinned":
      return "pinned";
    case "none":
      return "no match";
    default:
      return `${confidence} confidence`;
  }
}

/** Last path segment, for a chip that has to fit ("inkie-briar3"). */
export function worktreeName(path: string): string {
  const parts = path.split("/").filter((p) => p !== "");
  return parts.length > 0 ? parts[parts.length - 1]! : path;
}

/** Count of each status present, in taxonomy order. Zero counts are omitted. */
export function countStatuses(
  agents: AgentActivity[]
): Array<{ status: ActivityStatus; count: number }> {
  const counts = new Map<ActivityStatus, number>();
  for (const a of agents) counts.set(a.status, (counts.get(a.status) ?? 0) + 1);
  return ACTIVITY_STATUSES.filter((s) => (counts.get(s) ?? 0) > 0).map((s) => ({
    status: s,
    count: counts.get(s)!,
  }));
}
