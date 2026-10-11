/**
 * ActivityPanel.tsx - the agent-activity panel on the Team tab.
 *
 * One card per agent: a status pill, the evidence sentence behind it, the
 * resolved worktree with its confidence, and the newest completion. Everything
 * secondary (the scorer's reasons, the runner-up worktrees, the full recent
 * log) sits behind a per-card details toggle, the same collapse idiom
 * MorningBrief uses.
 *
 * THREE DESIGN RULES THIS FILE EXISTS TO HOLD:
 *
 *   1. NO PILL WITHOUT ITS EVIDENCE. The evidence line renders ALWAYS, next to
 *      the pill, never behind a click. The panel's whole value is that a wrong
 *      inference is cheap to spot; evidence you have to go looking for is
 *      evidence nobody reads. Only the corroborating detail is collapsed.
 *   2. `unknown` IS NOT A VERDICT. It renders as "no observation", with a
 *      dashed outline and a question glyph, never in the palette a real status
 *      uses. It means the sweep has nothing to say about this agent, which is
 *      a different thing from saying the agent is fine.
 *   3. OFFLINE SHOWS THE LAST STATE, NEVER AS THE CURRENT ONE. When the sweep
 *      has gone quiet the cards stay, dimmed and under the offline banner, with the
 *      status pills stripped of their verdict tint: worktrees and completions are
 *      facts that stay true, a pill is a claim about now and stops being one
 *      the moment the engine dies.
 *
 * The pill itself (tint + glyph per status) lives in StatusPill.tsx, shared
 * with the Sidebar so the two renderings cannot drift.
 *
 * Every pill carries a glyph as well as a tint (WCAG 1.4.1, the same
 * not-colour-alone rule WorkStrip's stale clock follows).
 *
 * Worktree alternatives are shown as first-class content, not debug output:
 * with ~180 mostly-stale worktrees on the box, the runner-up list is what makes
 * a wrong guess correctable by eye, which is the design goal for this feature
 * (plan section 5) rather than an implementation detail.
 *
 * No .server imports (types come from activity.shared).
 * ASCII only - no em-dashes.
 */
import { useState } from "react";
import { Link } from "react-router";
import {
  ChevronDown,
  ChevronUp,
  GitBranch,
  Pin,
  TerminalSquare,
} from "lucide-react";
import { Avatar } from "./ui/avatar";
import { StatusPill } from "./StatusPill";
import { cn } from "~/lib/utils";
import { formatClockTime, formatRelative } from "~/lib/time";
import {
  confidenceLabel,
  countStatuses,
  statusLabel,
  worktreeName,
  type ActivityView,
  type AgentActivity,
  type AgentWorktree,
  type RecentCompletion,
  type WorktreeConfidence,
} from "~/lib/activity.shared";

// ---------------------------------------------------------------------------
// Worktree chip
// ---------------------------------------------------------------------------

/**
 * Confidence tint. low/none read as "do not trust this yet", by design.
 *
 * Keyed by the union rather than by `string` for the same reason STATUS_STYLE
 * is: the day the producer grows a sixth confidence value, this map fails to
 * compile instead of silently tinting it muted. The runtime `??` below stays
 * anyway, because the value crosses a JSON boundary from another program.
 */
const CONFIDENCE_CLASS: Record<WorktreeConfidence, string> = {
  high: "text-primary",
  medium: "text-foreground",
  low: "text-accent",
  none: "text-muted-foreground",
  pinned: "text-primary",
};

function WorktreeChip({ agent, worktree }: { agent: string; worktree: AgentWorktree | null }) {
  if (worktree === null || worktree.path === null || worktree.path === "") {
    return (
      <div
        data-testid={`activity-worktree-${agent}`}
        data-confidence={worktree?.confidence ?? "none"}
        className="label-mono flex items-center gap-1 text-[11px] text-muted-foreground"
      >
        <GitBranch className="size-3 shrink-0" aria-hidden="true" />
        <span>no worktree resolved</span>
      </div>
    );
  }

  return (
    <div
      data-testid={`activity-worktree-${agent}`}
      data-confidence={worktree.confidence}
      title={worktree.path}
      className="label-mono flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11px]"
    >
      {worktree.pinned ? (
        <Pin className="size-3 shrink-0 text-primary" aria-hidden="true" />
      ) : (
        <GitBranch className="size-3 shrink-0 text-muted-foreground" aria-hidden="true" />
      )}
      <span className="text-foreground">{worktreeName(worktree.path)}</span>
      {worktree.branch !== null && worktree.branch !== "" ? (
        <span className="text-muted-foreground">{worktree.branch}</span>
      ) : null}
      <span
        data-testid={`activity-confidence-${agent}`}
        className={cn(CONFIDENCE_CLASS[worktree.confidence] ?? "text-muted-foreground")}
      >
        {confidenceLabel(worktree.confidence)}
        {worktree.score !== null ? ` ${worktree.score}` : ""}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Recent completions
// ---------------------------------------------------------------------------

function RecentLine({ entry, now }: { entry: RecentCompletion; now: Date }) {
  return (
    <li className="flex gap-1.5">
      <span className="label-mono shrink-0 text-[10px] text-muted-foreground">
        {entry.at === "" ? "" : formatClockTime(entry.at)}
      </span>
      <span className="min-w-0 flex-1 text-[11px] text-foreground" title={entry.ref}>
        {entry.label}
      </span>
      <span className="label-mono shrink-0 text-[10px] text-muted-foreground">
        {entry.at === "" ? "" : formatRelative(entry.at, now)}
      </span>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Agent card
// ---------------------------------------------------------------------------

function AgentCard({
  agent,
  avatarSrc,
  now,
  stale = false,
}: {
  agent: AgentActivity;
  avatarSrc?: string;
  now: Date;
  /** Last-known rather than current: see design rule 3 at the top of the file. */
  stale?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const wt = agent.worktree;
  const latest = agent.recent[0];
  /**
   * The scorer's guess is only ever RENDERED beside a pin: an unpinned guess is
   * not a disagreement, it is just the answer already in the chip. Derived ONCE
   * here so the toggle's condition and the block it reveals cannot drift apart.
   * They could: `asWorktree()` coerces `guess` and `pinned` independently, so a
   * malformed payload can carry a guess with `pinned` false, and counting that
   * toward "there is something to show" opens the panel onto nothing.
   */
  const pinGuess = wt !== null && wt.pinned ? wt.guess : null;
  /**
   * Derived ONCE, for the same reason pinGuess is: the render below tests both
   * the object and its task line, and reading them separately is how a card
   * ends up showing a stale marker with nothing above it to mark. An empty
   * string is treated as absent - a producer that writes "" is saying it has
   * nothing, and rendering a blank line plus a "last known" caption underneath
   * it would be worse than rendering neither.
   */
  const inference = agent.inference;
  const taskLine =
    inference !== null && inference.taskLine !== null && inference.taskLine !== ""
      ? inference.taskLine
      : null;
  const hasDetail =
    agent.recent.length > 0 ||
    pinGuess !== null ||
    (wt !== null && (wt.reasons.length > 0 || wt.alternatives.length > 0));

  return (
    <article
      data-testid={`activity-agent-${agent.agent}`}
      data-stale={stale ? "true" : undefined}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-background p-2.5"
    >
      <div className="flex items-center gap-2">
        <Avatar name={agent.agent} src={avatarSrc} className="h-5 w-5 text-[8px]" />
        <span className="label-mono min-w-0 flex-1 truncate text-xs text-foreground">
          {agent.agent}
        </span>
        <StatusPill
          status={agent.status}
          testId={`activity-status-${agent.agent}`}
          muted={stale}
        />
        {/*
          The PRIMARY action of the whole card, so it sits
          in the header row rather than inside the details toggle. Same URL
          shape AppShell's chat/terminal toggle produces, so it lands on the
          live pane rather than the chat half. Deliberately still offered on a
          stale card: a dead sweep is exactly when you want the real pane.
        */}
        <Link
          to={`/threads/${agent.agent}?view=tmux`}
          data-testid={`activity-jump-${agent.agent}`}
          aria-label={`Open ${agent.agent}'s live terminal`}
          title={`Open ${agent.agent}'s live terminal`}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <TerminalSquare className="size-4" aria-hidden="true" />
        </Link>
      </div>

      {/*
        The narration layer's sentence, above the evidence rather than instead
        of it: rule 1 is unconditional, so prose never displaces the observation
        it was written from.

        NOT RENDERED ON A STALE CARD, and that is a hard gate rather than a tint
        (design rule 3). A dead sweep freezes `current` at true and lets it age
        silently, so the record's own freshness flag stops meaning anything the
        moment the producer dies; the document-level staleness is the only thing
        that can catch it. Worktrees and completions stay because they are facts;
        a task line is a claim about now.
      */}
      {!stale && taskLine !== null ? (
        <div className="flex flex-col gap-0.5">
          <p
            data-testid={`activity-task-${agent.agent}`}
            title={taskLine}
            className="line-clamp-2 text-[11px] leading-snug text-foreground"
          >
            {taskLine}
          </p>
          {inference !== null && !inference.current ? (
            <p
              data-testid={`activity-task-stale-${agent.agent}`}
              data-reason={inference.staleReason ?? "stale"}
              className="label-mono text-[10px] text-accent"
            >
              {/*
                NEVER BARE. The reason AND the age together are what let a reader
                judge a retained sentence; a bare "(stale)" loses the half that
                matters, since a four-minute-old read and a four-hour-old one are
                not the same claim.
              */}
              last known: {inference.staleReason ?? "stale"}
              {inference.ageSeconds !== null
                ? `, read ${Math.floor(inference.ageSeconds / 60)}m ago`
                : ""}
            </p>
          ) : null}
          {inference !== null &&
          inference.progressNote !== null &&
          inference.progressNote !== "" ? (
            <p
              data-testid={`activity-progress-${agent.agent}`}
              className="line-clamp-2 text-[11px] leading-snug text-muted-foreground"
            >
              {inference.progressNote}
            </p>
          ) : null}
        </div>
      ) : null}

      {/* Rule 1: the evidence behind the pill, always visible. */}
      <p
        data-testid={`activity-evidence-${agent.agent}`}
        title={agent.evidence === "" ? agent.signal : agent.evidence}
        className="line-clamp-2 text-[11px] leading-snug text-muted-foreground"
      >
        {agent.evidence === ""
          ? `signal: ${agent.signal === "" ? "none recorded" : agent.signal}`
          : agent.evidence}
      </p>

      {/*
        Positive counts only. Absent (no live UI region to read) and zero (read
        it, nothing listed) are different facts to a consumer and the same
        silence to a reader: "0 sub-agents" would cost a line on every card to
        say nothing.
      */}
      {agent.subagentCount !== null && agent.subagentCount > 0 ? (
        <p
          data-testid={`activity-subagents-${agent.agent}`}
          className="label-mono text-[10px] text-muted-foreground"
        >
          {agent.subagentCount} sub-agent{agent.subagentCount === 1 ? "" : "s"} running
        </p>
      ) : null}

      <WorktreeChip agent={agent.agent} worktree={wt} />

      {latest !== undefined ? (
        <p
          data-testid={`activity-latest-${agent.agent}`}
          className="truncate text-[11px] text-foreground"
          title={latest.label}
        >
          <span className="label-mono text-[10px] text-muted-foreground">recently </span>
          {latest.label}
        </p>
      ) : null}

      {hasDetail ? (
        <>
          <button
            type="button"
            data-testid={`activity-details-toggle-${agent.agent}`}
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
            className="label-mono flex items-center gap-1 self-start text-[10px] text-muted-foreground hover:text-foreground"
          >
            {open ? (
              <ChevronUp className="size-3" aria-hidden="true" />
            ) : (
              <ChevronDown className="size-3" aria-hidden="true" />
            )}
            {open ? "less" : "detail"}
          </button>

          {open ? (
            <div
              data-testid={`activity-details-${agent.agent}`}
              className="flex flex-col gap-2 border-t border-border pt-1.5"
            >
              {wt !== null && wt.reasons.length > 0 ? (
                <div data-testid={`activity-reasons-${agent.agent}`}>
                  <span className="label-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    why this worktree
                  </span>
                  <p className="label-mono text-[10px] text-muted-foreground">
                    {wt.reasons.join(", ")}
                  </p>
                </div>
              ) : null}

              {pinGuess !== null ? (
                <div data-testid={`activity-pin-guess-${agent.agent}`}>
                  <span className="label-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    scorer would have said
                  </span>
                  <p className="label-mono text-[10px] text-muted-foreground">
                    {pinGuess.path ?? "nothing"}
                    {pinGuess.branch !== null && pinGuess.branch !== ""
                      ? ` (${pinGuess.branch})`
                      : ""}
                  </p>
                </div>
              ) : null}

              {wt !== null && wt.alternatives.length > 0 ? (
                <div data-testid={`activity-alternatives-${agent.agent}`}>
                  <span className="label-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    also considered
                  </span>
                  <ul className="flex flex-col gap-0.5">
                    {wt.alternatives.map((alt, i) => (
                      <li
                        // Path is the identity; the index disambiguates, since
                        // nothing upstream promises the scorer's runners-up are
                        // distinct paths (RecentLine's key does the same).
                        key={`${alt.path}#${i}`}
                        className="label-mono flex gap-1.5 text-[10px] text-muted-foreground"
                        title={alt.path}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {worktreeName(alt.path)}
                          {alt.branch !== null && alt.branch !== "" ? ` ${alt.branch}` : ""}
                        </span>
                        {alt.score !== null ? <span>{alt.score}</span> : null}
                      </li>
                    ))}
                  </ul>
                </div>
              ) : null}

              {agent.recent.length > 0 ? (
                <div data-testid={`activity-recent-${agent.agent}`}>
                  <span className="label-mono text-[10px] uppercase tracking-widest text-muted-foreground">
                    recently
                  </span>
                  <ul className="flex flex-col gap-0.5">
                    {agent.recent.map((entry, i) => (
                      <RecentLine key={entry.key === "" ? `${i}` : entry.key} entry={entry} now={now} />
                    ))}
                  </ul>
                </div>
              ) : null}
            </div>
          ) : null}
        </>
      ) : null}
    </article>
  );
}

// ---------------------------------------------------------------------------
// Offline note
// ---------------------------------------------------------------------------

/**
 * The honest-degrade surface, and for now the ONLY one that runs in production:
 * the sweep is not on cron yet, so a missing state file is the normal state of
 * the world, not an error state. It says what it looked for and what it found,
 * because "offline" with no observation attached makes the next diagnosis start
 * from nothing.
 *
 * It is now a BANNER over the last-known cards rather than a replacement for
 * them, so the stale line has to describe what is rendering below it:
 * "N agents in it, pills are not shown" was true of the old blank version
 * and would be a straight contradiction of the dimmed grid underneath.
 */
function OfflineNote({
  reason,
  sweptAt,
  detail,
  agentCount,
  now,
}: {
  reason: string;
  sweptAt: string | null;
  detail: string;
  /** How many last-known cards render below this note. Derived from the array. */
  agentCount: number;
  now: Date;
}) {
  const headline =
    reason === "stale" && sweptAt !== null
      ? `Activity engine offline since ${formatClockTime(sweptAt)}`
      : reason === "missing"
        ? "Activity engine has not run yet"
        : reason === "unconfigured"
          ? "Activity is not configured on this instance"
          : "Activity state could not be read";

  return (
    <div
      data-testid="activity-offline"
      data-reason={reason}
      className="shrink-0 px-3 py-3"
    >
      <p className="text-xs text-foreground">{headline}</p>
      <p className="label-mono mt-1 text-[10px] text-muted-foreground">{detail}</p>
      {reason === "stale" && sweptAt !== null ? (
        <p className="label-mono mt-1 text-[10px] text-muted-foreground">
          last sweep {formatRelative(sweptAt, now)}
          {agentCount > 0
            ? `, showing the ${agentCount} agents it last saw. Dimmed because these are last-known states, not claims about now.`
            : ""}
        </p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Card grid
// ---------------------------------------------------------------------------

/**
 * The one grid, rendered live OR stale. Shared rather than duplicated into the
 * offline branch so a card can never gain a field in one state and not the
 * other; `stale` is the only thing that differs, and it is carried as data
 * (data-stale) as well as tint so the difference is assertable, not just
 * visible.
 */
function AgentGrid({
  agents,
  avatars,
  now,
  stale = false,
}: {
  agents: AgentActivity[];
  avatars: Record<string, string>;
  now: Date;
  stale?: boolean;
}) {
  return (
    <div
      data-testid="activity-grid"
      data-stale={stale ? "true" : undefined}
      className={cn(
        // The ONE flexible element in the panel: it takes whatever height the
        // section has left and scrolls inside it, so the page itself never
        // does. `min-h-0` is what makes that true - a flex child defaults to
        // min-height:auto, which floors it at its content and pushes the
        // overflow onto the page instead of into this box. `content-start`
        // keeps the rows their natural height when there is spare room, rather
        // than stretching three cards to fill a tall panel.
        "grid min-h-0 flex-1 content-start gap-2 overflow-y-auto border-t border-border p-2 sm:grid-cols-2 xl:grid-cols-3",
        stale ? "opacity-60" : ""
      )}
    >
      {agents.map((a) => (
        <AgentCard
          key={a.agent}
          agent={a}
          avatarSrc={avatars[a.agent]}
          now={now}
          stale={stale}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Panel
// ---------------------------------------------------------------------------

export interface ActivityPanelProps {
  /** The seam's view. Offline states render the honest note, never an error. */
  activity: ActivityView;
  /** Loader-provided instant (MC_NOW aware) so relative stamps are deterministic. */
  now: string;
  /** Agent avatar URLs, keyed by name (built by the route loader per row). */
  avatars?: Record<string, string>;
}

export function ActivityPanel({ activity, now, avatars = {} }: ActivityPanelProps) {
  const [expanded, setExpanded] = useState(true);
  // A garbage `now` must not reach date-fns (it throws "Invalid time value").
  const parsedNow = new Date(now);
  const nowDate = Number.isNaN(parsedNow.getTime()) ? new Date() : parsedNow;

  const summary =
    activity.state === "live" ? countStatuses(activity.agents) : [];

  /**
   * Whether the panel claims the route's spare vertical height. The card grid is the only thing in here that can USE
   * that height, so the panel only takes it when there is a grid to put in it:
   * collapsed, or showing nothing but an offline note or the empty-state line, it goes back
   * to sizing to its content rather than leaving a card's worth of dead space
   * above the page's footer caption.
   *
   * The route (`tmux.tsx`) is a `flex h-full flex-col` column and this section
   * is a direct child of it, so `flex-1` here IS the claim on the remaining
   * height - no wrapper needed, and none wanted: a wrapper would have to be
   * unconditional, which is exactly the dead space this flag exists to avoid.
   */
  const fills = expanded && activity.agents.length > 0;

  return (
    <section
      data-testid="activity-panel"
      data-state={activity.state}
      className={cn(
        "mb-3 flex flex-col rounded-lg border border-border bg-card",
        fills ? "min-h-0 flex-1" : "shrink-0"
      )}
    >
      <div className="flex shrink-0 items-center gap-2 px-3 py-2">
        <span className="label-mono text-xs uppercase tracking-widest text-muted-foreground">
          Activity
        </span>

        {activity.state === "live" ? (
          <span
            data-testid="activity-summary"
            className="label-mono flex min-w-0 flex-1 flex-wrap gap-x-2 text-[10px] text-muted-foreground"
          >
            {summary.map((s) => (
              <span key={s.status}>
                {s.count} {statusLabel(s.status)}
              </span>
            ))}
          </span>
        ) : (
          <span className="label-mono min-w-0 flex-1 text-[10px] text-accent">
            engine offline
          </span>
        )}

        <span className="label-mono shrink-0 text-[10px] text-muted-foreground">
          {activity.state === "live"
            ? `swept ${formatClockTime(activity.sweptAt)}`
            : activity.sweptAt !== null
              ? `last ${formatClockTime(activity.sweptAt)}`
              : "no data"}
        </span>

        <button
          type="button"
          data-testid="activity-panel-toggle"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse activity panel" : "Expand activity panel"}
          onClick={() => setExpanded((v) => !v)}
          className="flex size-6 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          {expanded ? (
            <ChevronUp className="size-4" aria-hidden="true" />
          ) : (
            <ChevronDown className="size-4" aria-hidden="true" />
          )}
        </button>
      </div>

      {expanded ? (
        activity.state === "offline" ? (
          // The note is a BANNER, not a replacement: the last-known cards keep
          // rendering underneath it (dimmed) whenever the offline state still
          // holds a readable document, which is the `stale` reason and only
          // that one. missing/corrupt/unreadable/unsupported carry no agents by
          // construction, so this same branch renders note-only for them
          // without a second condition to keep in step.
          <div
            className={cn(
              "flex flex-col border-t border-border",
              // Same rule as the section: this wrapper only has to pass the
              // height down when it is wrapping a grid. With note-only reasons
              // (missing/corrupt/unreadable/unsupported) it sizes to the note.
              fills ? "min-h-0 flex-1" : ""
            )}
          >
            <OfflineNote
              reason={activity.reason}
              sweptAt={activity.sweptAt}
              detail={activity.detail}
              agentCount={activity.agents.length}
              now={nowDate}
            />
            {activity.agents.length > 0 ? (
              <AgentGrid agents={activity.agents} avatars={avatars} now={nowDate} stale />
            ) : null}
          </div>
        ) : activity.agents.length === 0 ? (
          <div
            data-testid="activity-empty"
            className="border-t border-border px-3 py-3 text-xs text-muted-foreground"
          >
            The last sweep covered no agents.
          </div>
        ) : (
          <AgentGrid agents={activity.agents} avatars={avatars} now={nowDate} />
        )
      ) : null}
    </section>
  );
}
