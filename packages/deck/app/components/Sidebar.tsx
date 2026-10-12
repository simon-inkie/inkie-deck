/**
 * Sidebar.tsx - left-hand agent list (the "people" column of the chat shell).
 *
 * One row per agent: initials avatar + name (display font) + the two pulse
 * dots (magenta unread, burnt-orange "needs you") immediately beside the name
 * + last-message preview + the activity status pill, held at the far right of
 * the row with its full text label.
 * The active agent (from the URL param) is highlighted.
 *
 * Presentational: all data arrives via props from the shell layout loader,
 * with no env or fs access. useParams is read-only routing state, not data access.
 * ASCII only - no em-dashes.
 */
import { Link, useParams } from "react-router";
import { Avatar } from "./ui/avatar";
import { StatusPill } from "./StatusPill";
import { cn } from "~/lib/utils";
import type { ActivityStatus } from "~/lib/activity.shared";

export interface SidebarAgent {
  name: string;
  preview: string;
  lastTimestamp: string;
  /**
   * A genuine open (un-swept) decision/action card from this agent. Drives
   * the BURNT-ORANGE decision dot.
   */
  hasUnhandled: boolean;
  /** /avatars/<name>?v=<mtime> when the agent has an avatar.png. */
  avatarUrl?: string;
  /**
   * Any unread (status sent) message from this agent.
   * Drives the MAGENTA new-message dot. Both dots can show at
   * once - a decision and a new message are different things.
   */
  hasUnread?: boolean;
  /**
   * The agent's activity status from the LAST LIVE
   * sweep, or absent when this instance has no activity root, the
   * engine is offline, or the sweep did not cover this agent.
   *
   * ABSENT MEANS ABSENT, not a status of its own: the shell loader ships this
   * key only for a live read, so a stale or unconfigured instance renders the
   * sidebar exactly as it did before this feature existed. `unknown` is dropped
   * by the row below for the same reason - see the pill.
   */
  status?: ActivityStatus;
}

export function Sidebar({ agents }: { agents: SidebarAgent[] }) {
  const params = useParams();
  const active = params.agent;

  return (
    // The ResizablePanel owns the width now - w-72 would fight the drag.
    <nav className="flex h-full w-full flex-col border-r border-border bg-card/40">
      <div className="px-4 py-3">
        <span className="label-mono text-muted-foreground">Agents</span>
      </div>

      <div className="flex-1 overflow-y-auto px-2 pb-3">
        {agents.length === 0 ? (
          <p className="px-2 py-6 text-sm text-muted-foreground">
            No agents yet. They appear here once they write to your inbox.
          </p>
        ) : (
          agents.map((a) => (
            <Link
              key={a.name}
              to={`/threads/${a.name}`}
              prefetch="intent"
              className={cn(
                "my-0.5 flex items-center gap-3 rounded-lg px-2.5 py-2.5 transition-colors",
                active === a.name
                  ? "bg-primary/10"
                  : "hover:bg-muted"
              )}
            >
              <Avatar name={a.name} src={a.avatarUrl} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  {/* Name + dots are ONE cluster. The two dots are a magenta one for an unread
                      message and a burnt-orange one for an open decision; both
                      can show at once, and both belong to the agent's name
                      rather than to the status pill they used to sit beside.
                      The layout contract for this row: `min-w-0` + `truncate`
                      let a long name give way, `shrink-0` keeps the dots and
                      the pill their own size whatever the name does. */}
                  <span className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate font-display text-sm font-bold uppercase tracking-tight text-foreground">
                      {a.name}
                    </span>
                    {a.hasUnread ? (
                      <span
                        data-testid={`sidebar-dot-message-${a.name}`}
                        className="size-2 shrink-0 animate-pulse rounded-full bg-accent-message"
                        title="Unread message"
                      />
                    ) : null}
                    {a.hasUnhandled ? (
                      <span
                        data-testid={`sidebar-dot-decision-${a.name}`}
                        className="size-2 shrink-0 animate-pulse rounded-full bg-accent"
                        title="Decision needs you"
                      />
                    ) : null}
                  </span>
                  {/* Far right of the row, with the full text label rather than
                      the glyph alone: the status is a word, not a puzzle.
                      StatusPill carries its own `shrink-0`, so a
                      long label ("waiting on teammate") never gets crushed by a
                      long name. `unknown` renders NOTHING: the panel can afford
                      to say "no observation" beside the evidence for it, a bare
                      pill here could only be a shrug. */}
                  {a.status !== undefined && a.status !== "unknown" ? (
                    <StatusPill status={a.status} testId={`sidebar-status-${a.name}`} />
                  ) : null}
                </div>
                <p className="truncate text-xs text-muted-foreground">
                  {a.preview}
                </p>
              </div>
            </Link>
          ))
        )}
      </div>
    </nav>
  );
}
