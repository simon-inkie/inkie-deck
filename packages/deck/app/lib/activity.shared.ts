/**
 * activity.shared.ts - types + pure view-model helpers for the agent-activity
 * panel.
 *
 * The producer is an external sweep script, a deterministic 60s
 * sweep that writes ONE file, `$ACTIVITY_ROOT/activity.json`. MC is a
 * READ-ONLY consumer of it (the query CLI is the other one). This module owns
 * the wire types and every pure decision made about them; activity.server.ts
 * owns the env + fs half.
 *
 * Why a .shared module and not just activity.server.ts: the panel component
 * needs the types and the pure label/tone helpers, and importing values from a
 * .server module into a client component is exactly what the server/client seam rule forbids
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
 * ASCII only - no em-dashes.
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

/**
 * The prose half, when a deployment runs a narration layer beside the sweep.
 *
 * PROSE ONLY, NO PILL AUTHORITY. The producer builds this object from an
 * allowlist rather than by spreading its sidecar record, precisely so a model's
 * own read of the STATUS can never reach this document. This type does the same
 * on the reading side: there is no field here for a status, so even a producer
 * that started emitting one could not get it in front of a reader through this
 * seam. Whether a model gets pill authority is a decision to be taken
 * explicitly, not one that arrives by a field appearing.
 *
 * `current: false` with a `taskLine` present is NOT a producer bug: past a
 * staleness verdict the sweep RETAINS the last known sentence and marks it,
 * dropping it to null itself once it passes an age ceiling. The danger was never
 * stale prose, it was UNMARKED stale prose, so a renderer MUST show the reason
 * and the age beside it rather than quietly presenting it as current.
 */
export interface AgentInference {
  /** One sentence: what this agent is working on. */
  taskLine: string | null;
  /** An optional second line: how far along it is. */
  progressNote: string | null;
  /** Whether the read still describes the signals as they are now. */
  current: boolean;
  /** Opaque diagnostic text, rendered verbatim. Never switched on. */
  staleReason: string | null;
  /**
   * The producer's signals digest changed since the read. Named for the pane
   * hash it was originally computed from; the key was deliberately NOT renamed
   * when the signal source changed, because a producer-side rename with no
   * coordinated reader release drops it to a default over here and silently
   * stops marking held reads.
   */
  paneMoved: boolean;
  /** How old the read is, in seconds. Null when the producer could not say. */
  ageSeconds: number | null;
  generatedAt: string | null;
  sourceSwept: string | null;
  outcome: string | null;
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
  /**
   * How many sub-agents this agent has running, counted off its pane's live UI
   * region. THREE-VALUED ON PURPOSE, and the third value is the point:
   *
   *   null - there was no live UI region to read. No evidence either way.
   *   0    - the region was read and listed nothing.
   *   n    - n sub-agents are running.
   *
   * A renderer must collapse null and 0 into the same silence ("0 sub-agents"
   * is a true line that tells a reader nothing), but a CONSUMER must not, since
   * only a positive count is evidence. The producer's own `waiting-on-machine`
   * branch turns on exactly this distinction.
   */
  subagentCount: number | null;
  /**
   * The narration layer's read, when one is configured and publishing. Null on
   * every deployment that runs the sweep alone, which is the default.
   */
  inference: AgentInference | null;
  /**
   * ISO-8601 instant the agent's CURRENT `status` was first observed (top-bar
   * escalation SPEC, Part A - a producer field, not written by every sweep).
   *
   * OPTIONAL, deliberately, unlike every other timestamp on this record: the
   * producer half of this feature is newer than the consumer half, so a
   * sweep that predates it writes documents with no `statusSince` at all.
   * Absence must degrade, never throw - see `escalatedAgents` below, which
   * SKIPS an agent entirely when this is absent, computing no duration at
   * all. (Caught in review: the first version fell back to `updated`,
   * reasoning it as "just started" - wrong the moment the sweep itself goes
   * stale, since `updated` then stops advancing and looks like a
   * long-running status instead of missing data.)
   */
  statusSince?: string;
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
   * Carried so the
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

/**
 * Coerce the narration object, or null.
 *
 * Every field degrades independently, same posture as the rest of this module:
 * a producer on a different release cycle may add fields, drop optional ones,
 * or write a null where a string was expected, and none of that may cost the
 * panel a row. `current` defaults to FALSE on anything non-boolean, which is
 * the safe direction: an unreadable freshness flag must make the renderer mark
 * the prose, never present it as current.
 *
 * Nothing here reads a status field, by construction. See AgentInference.
 */
function asInference(v: unknown): AgentInference | null {
  if (!isRecord(v)) return null;
  return {
    taskLine: str(v["taskLine"]),
    progressNote: str(v["progressNote"]),
    current: v["current"] === true,
    staleReason: str(v["staleReason"]),
    paneMoved: bool(v["paneMoved"]),
    ageSeconds: num(v["ageSeconds"]),
    generatedAt: str(v["generatedAt"]),
    sourceSwept: str(v["sourceSwept"]),
    outcome: str(v["outcome"]),
  };
}

/**
 * A non-negative integer count, or null.
 *
 * Stricter than `num` on purpose. This value drives a "2 running" line, and a
 * negative or fractional count is not a smaller version of that claim, it is a
 * producer that cannot be believed about this field. Null (no observation) is
 * the honest reading of a value that cannot be one.
 */
function count(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  return Number.isInteger(n) && n >= 0 ? n : null;
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
        subagentCount: count(value["subagentCount"]),
        inference: asInference(value["inference"]),
        // Coerced to undefined rather than left as a stored null, so a
        // document written by a sweep that does not emit this field yet
        // leaves the optional property genuinely ABSENT.
        statusSince: str(value["statusSince"]) ?? undefined,
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
 * `tmux list-windows` at ITS tick, honours ACTIVITY_SKIP_AGENTS (empty by
 * default, but a deployment may exclude a window running a runtime the sweep's
 * pane markers do not cover), and refuses whole ticks rather than publishing a
 * partial roster. So "a window with no record" is a real, everyday state, not a
 * theoretical one, and it must render as `unknown` ("no observation") rather
 * than being silently dropped - a missing row would read as "that agent does
 * not exist".
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
      subagentCount: null,
      inference: null,
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

// ---------------------------------------------------------------------------
// Top-bar escalation (the consumer half)
// ---------------------------------------------------------------------------

/** A status the top-bar escalation cares about - see `escalatedAgents`. */
export type EscalatableStatus = "stuck" | "needs-you";

/** One agent that has been stuck/needs-you for at least the threshold. */
export interface EscalatedAgent {
  agent: string;
  status: EscalatableStatus;
  /**
   * The instant `status` was entered, straight off the producer field.
   * Carried so the UI can show a "since" time without recomputing it from
   * `durationMs` and `now`.
   */
  statusSince: string;
  durationMs: number;
}

/**
 * Agents that have been `stuck` or `needs-you` for >= thresholdMs, i.e. the
 * top-bar escalation alert's contents (top-bar escalation SPEC, "Design"
 * section 1).
 *
 * Pure: `now` is injected, matching the MC_NOW convention used throughout
 * activity.test.ts - no clock read happens in here.
 *
 * DEGRADE ON MISSING `statusSince`: an agent whose record carries no such
 * timestamp is SKIPPED, computing no duration at all. There is deliberately
 * no fallback to `updated` (the sweep-tick write time). That fallback reads
 * as reasonable - `updated` is usually seconds old, so the gap stands in for
 * "just entered this status" - and it only holds while the sweep is healthy.
 * If the sweep itself stalls, which is exactly the failure this feature
 * exists to notice, `updated` stops advancing and the gap grows without
 * bound, firing a FALSE escalation off data staleness at the precise moment
 * the alert's own inputs became unreliable.
 *
 * `waiting-on-teammate`/`waiting-on-machine` are expected, unescalated states
 * (StatusPill.tsx's own tint table draws the same line) - an agent waiting on
 * a teammate is not the operator's problem by definition.
 */
export function escalatedAgents(
  agents: AgentActivity[],
  now: Date,
  thresholdMs: number
): EscalatedAgent[] {
  const out: EscalatedAgent[] = [];
  for (const a of agents) {
    if (a.status !== "stuck" && a.status !== "needs-you") continue;
    const since = a.statusSince;
    if (since === undefined) continue; // no statusSince - nothing to escalate on
    const sinceMs = new Date(since).getTime();
    if (Number.isNaN(sinceMs)) continue;
    const durationMs = now.getTime() - sinceMs;
    if (durationMs < thresholdMs) continue;
    out.push({ agent: a.agent, status: a.status, statusSince: since, durationMs });
  }
  return out;
}
