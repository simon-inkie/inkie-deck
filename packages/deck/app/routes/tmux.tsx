/**
 * tmux.tsx - the Activity page, reachable from the "Activity" nav.
 *
 * HISTORY, because the route name no longer matches the job. This was the
 * Team tab: a window picker plus a live TmuxPane readout of whichever agent you
 * clicked. The agent-activity panel was then added above it, and the readout was
 * cut because the constant tmux output at the bottom of the window took too
 * much screen space. What is left is the activity panel, full height, with a
 * per-card jump to the agent's own live pane.
 *
 * TmuxPane is NOT dead: it is still the per-thread `?view=tmux` surface,
 * which stays the one place a pane is read and written.
 * That is where the jump buttons on the cards land. The route path stays
 * /tmux so old bookmarks and the nav link keep working.
 *
 * WHY THE LOADER STILL LISTS WINDOWS. One `tmux list-windows` fork per tick
 * (the capture fork, the expensive half, is gone with the pane). It feeds
 * activityRows, which synthesises an honest "no observation" row for a live
 * window the sweep never covered - a new window, or one on the sweep's skip
 * list. Dropping it would silently narrow the panel to whatever the last sweep
 * happened to see, and a missing row reads as "that agent does not exist".
 * Gated on tmuxEnabled so an instance with tmux off never forks it.
 *
 * SEAM RULE: imports ONLY from .server modules - the subprocess and
 * the fs read never appear in route code. activity.shared is a pure
 * types/view-model module (no fs, no env), same as projects.shared.
 *
 * ASCII only - no em-dashes.
 */
import { Link } from "react-router";
import type { Route } from "./+types/tmux";
import { RouteErrorPanel } from "~/components/RouteErrorPanel";
import { listTmuxWindows } from "~/lib/tmux.server";
import { avatarUrl } from "~/lib/avatars.server";
import { EmptyState } from "~/components/EmptyState";
import { ActivityPanel } from "~/components/ActivityPanel";
import { Activity as ActivityGlyph } from "lucide-react";
import { activityEnabled, tmuxEnabled } from "~/lib/instance.server";
import { readActivity } from "~/lib/activity.server";
import { activityRows, type ActivityView } from "~/lib/activity.shared";
import { resolveNow } from "~/lib/time";

/**
 * Read the activity view for this instance, or null when the gate is off.
 *
 * CADENCE: this piggybacks on the existing loader, which the AppShell poll
 * re-runs every 1s on this route. Deliberate, and the alternative was
 * considered: the sweep only rewrites the file every 60s, so most of those
 * reads return identical bytes. They stay anyway because (a) it is one small
 * JSON file (roughly 1KB per agent) read from page cache, next to nothing
 * beside the tmux window listing this same loader still does every tick, (b) a
 * second poll on its own cadence would mean a second data flow and a fetcher
 * for a panel that has no interactivity, and (c) piggybacking means the panel
 * can never be more stale than the file, so the staleness banner is about the
 * SWEEP only, with no Deck-side caching to reason about on top of it.
 * If the read ever shows up in a profile, an mtime+size memo (the
 * file-manifest-cache.server.ts idiom) drops in behind this function without
 * touching the route.
 */
function loadActivity(now: Date, windows: string[]): ActivityView | null {
  if (!activityEnabled(process.env)) return null;
  const view = readActivity(process.env, now);
  if (view.state !== "live") return view;
  // Join with the live windows so a window the sweep never covered (a new one,
  // or one on its skip list) shows an honest "no observation" row rather than
  // vanishing from the panel. LIVE ONLY: a synthesised row is a statement about
  // the windows open right now, which is precisely what an offline view has no
  // right to make - its cards render as last-known and nothing else joins them.
  return { ...view, agents: activityRows(view.agents, windows) };
}

export async function loader() {
  // MC_NOW pattern: one server-side instant, used for the staleness decision
  // AND the relative stamps the panel renders, so the two can never disagree.
  const now = resolveNow(process.env["MC_NOW"]);

  // A tmux-disabled instance lists no windows. Nothing
  // tmux-shaped renders on this page any more, so that is the whole difference
  // it makes here: the panel itself is gated INDEPENDENTLY (decision Q6, an
  // instance with tmux off but activity configured must get the panel).
  const windows = tmuxEnabled(process.env) ? listTmuxWindows(process.env) : [];

  const activity = loadActivity(now, windows);

  // Faces: the cards are the only avatar consumer left, so build the
  // map from the rows that will actually render rather than from the window
  // list (which is empty on a tmux-disabled instance, and would have left
  // a second user's panel on initials for agents Deck can name perfectly well).
  const avatars: Record<string, string> = {};
  if (activity !== null) {
    // Live and offline both carry rows now, so one loop covers both states.
    for (const a of activity.agents) {
      const u = avatarUrl(a.agent);
      if (u !== undefined) avatars[a.agent] = u;
    }
  }

  return {
    activity,
    avatars,
    now: now.toISOString(),
  };
}

export default function ActivityTab({ loaderData }: Route.ComponentProps) {
  const { activity, avatars, now } = loaderData;

  // The gate is off on this instance (no activity root configured for it). The
  // nav link is hidden in that case, so this is the bookmark/direct-URL path:
  // say so plainly rather than render an empty page.
  if (activity === null) {
    return (
      <div className="flex h-full flex-col px-6 py-4">
        <EmptyState
          icon={ActivityGlyph}
          title="Activity is not available on this instance"
          body="The agent-activity sweep is not configured here."
        />
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col px-6 py-4">
      <div className="mb-3 flex shrink-0 items-center gap-3">
        <h1 className="font-display text-lg font-black uppercase tracking-tight text-foreground">
          Activity
        </h1>
      </div>

      {/*
        THE ONE GROWING CHILD of this column, so the activity panel fills the full
        window height rather than half of it. The header above and the caption
        below are shrink-0 and keep their natural size; the panel takes everything else and scrolls its card grid internally,
        so this page never hands a scrollbar to the shell's <main>.

        The `flex-1` lives on the panel's own root rather than on a wrapper
        here, deliberately: it has to switch off when the panel is collapsed or
        has no cards, and a wrapper in this file cannot see either of those.
      */}
      <ActivityPanel activity={activity} now={now} avatars={avatars} />

      <p className="label-mono mt-2 shrink-0 text-[10px] text-muted-foreground">
        Read-only view of the activity sweep - refreshes automatically. The
        terminal glyph on a card opens that agent's live pane.{" "}
        <Link to="/" className="underline underline-offset-2 hover:text-foreground">
          Back to threads
        </Link>
      </p>
    </div>
  );
}

/**
 * Scoped error boundary: a failure in this
 * route renders here, inside the shell, so the sidebar and the rest of Deck
 * stay usable. The panel shows the actual error text.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <RouteErrorPanel
      error={error}
      scope="the activity view"
      hint="The activity sweep may be down - chat threads still work."
    />
  );
}
