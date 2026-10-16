/**
 * AppShell.tsx - the two-pane chat frame: top bar + sidebar + centre Outlet.
 *
 * Top bar carries the Inkie Deck wordmark, a reserved (stubbed) Projects
 * tab, and the needs-you bell - a notifications dropdown listing the open
 * decisions to action now, each deep-linking to its message (a requirement
 * from the operator). The body is transparent so the cream + halftone
 * paper texture from app.css whispers through the centre pane.
 *
 * Responsive layout (RESPONSIVE-RETROFIT-PLAN):
 *   - Under md: sidebar hidden; horizontal agent strip appears below the top bar.
 *   - md+: sidebar visible as before; agent strip hidden.
 *
 * Presentational only - data arrives via props from the shell layout loader.
 * ASCII only - no em-dashes.
 */
import { useEffect, useState } from "react";
import { Outlet, Link, NavLink, useLocation, useParams } from "react-router";
import { Bell, CalendarClock, Gauge, KanbanSquare, MessageSquare, SquareStack, TerminalSquare, TriangleAlert, X } from "lucide-react";
import { Sidebar, type SidebarAgent } from "./Sidebar";
import {
  ResizablePanelGroup,
  ResizablePanel,
  ResizableHandle,
} from "./ui/resizable";
import { WorkStrip } from "./WorkStrip";
import { PushToggle } from "./PushToggle";
import { ModelSelector, type ModelSelectorData } from "./ModelSelector";
import { FilesPanelToggle } from "./FilesPanel";
import type { MiniCard } from "~/lib/projects.shared";
import { Avatar } from "./ui/avatar";
import { Badge } from "./ui/badge";
import { cn } from "~/lib/utils";
import { formatRelative, formatDurationHm } from "~/lib/time";
import { statusLabel, type EscalatedAgent } from "~/lib/activity.shared";
import { useLiveRevalidate } from "~/lib/use-live-revalidate";
import { useMessageChime } from "~/lib/message-chime";
import { CodexQuotaPanel, ProviderBadge } from "./CodexQuotaStatus";
import type { CodexQuotaDisplayData } from "~/lib/codex-quota-display";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

/**
 * One needs-you item (drives the bell dropdown). COUNT SEMANTICS: the bell badge and the home list
 * consume the SAME deriveNeedsYou output - the badge count IS the list length.
 * One source of truth; a badge of 2 over a list of 5 would read as the bug it would be.
 */
export interface NeedsItem {
  /** Stable id from deriveNeedsYou (React key). */
  id: string;
  kind: "decision" | "action" | "blocked";
  agent: string;
  subject: string;
  createdAt: string;
  overdue: boolean;
  /** Deep link: decisions/actions -> thread anchor; blocked -> /projects. */
  deepLink: string;
}

/**
 * Rebuild a search string with the view param set or removed, preserving
 * every other param (doc panel, debug, etc).
 */
function threadViewSearch(search: string, view: string | undefined): string {
  const params = new URLSearchParams(search);
  if (view === undefined) params.delete("view");
  else params.set("view", view);
  const s = params.toString();
  return s === "" ? "" : `?${s}`;
}

interface AppShellProps {
  agents: SidebarAgent[];
  needsItems: NeedsItem[];
  needsCount: number;
  /**
   * The active thread agent's live (non-done) cards. Empty on
   * non-thread routes. Drives the top-bar work-panel trigger + slide-out.
   */
  workCards: MiniCard[];
  /**
   * Whether this instance exposes the tmux surface (Team tab +
   * thread terminal toggle). A second user's instance runs with this off, because typing
   * into agent sessions stays the operator's consent surface. Default true.
   */
  tmuxOn?: boolean;
  /**
   * Whether the cron admin page is accessible on this instance.
   * Operator-instance-only for v1. Shows a nav link when true.
   */
  cronAdminOn?: boolean;
  /**
   * Workspace label chip next to the wordmark ("a second user's
   * workspace") so it is unmistakable whose instance this is. Absent on
   * the operator's instance.
   */
  instanceLabel?: string;
  /**
   * M5: the active thread agent's configured model + catalog options.
   * Present only on operator instances (modelSelectorEnabled) when a thread
   * is open and the agent's runtime has options - absence renders nothing,
   * so a second user's instance never sees the control.
   */
  modelSelector?: ModelSelectorData;
  /**
   * Whether this instance has an activity root configured. Gates a
   * nav link to /tmux (the activity-panel home, see tmux.tsx) - re-added
   * because the page had become unreachable without it.
   * Relabelled "Activity" since the page's job is now the overview panel,
   * not the old duplicate terminal-browsing surface that link used to open.
   */
  activityNavOn?: boolean;
  /** #66: a WORKSPACE_ROOT is configured, so the Drafts editor link is shown. */
  draftsNavOn?: boolean;
  /**
   * Top-bar escalation: agents `stuck`/`needs-you` for longer than the
   * escalation threshold (see escalatedAgents, activity.shared.ts).
   * Distinct top-bar element from the needs-you bell, deliberately - the two
   * concepts (the operator has something to action vs. an agent has been
   * silently wedged for a while) must not blur into one badge count.
   * Empty/absent renders nothing, same posture as workCards.
   */
  escalated?: EscalatedAgent[];
  /** Ticket 3: read-only Plus quota and explicit per-agent provider state. */
  codexQuota?: CodexQuotaDisplayData;
}

const UNKNOWN_CODEX_QUOTA: CodexQuotaDisplayData = {
  quota: {
    freshness: "missing",
    status: "UNKNOWN",
    available: false,
    blocked: false,
    warning: null,
    observedAt: null,
    windows: [],
  },
  providers: {},
};

export function AppShell({ agents, needsItems, needsCount, workCards, tmuxOn = true, instanceLabel, modelSelector, cronAdminOn = false, activityNavOn = false, draftsNavOn = false, escalated = [], codexQuota = UNKNOWN_CODEX_QUOTA }: AppShellProps) {
  const params = useParams();
  const active = params.agent;
  const location = useLocation();

  // Per-thread terminal mode is URL state (?view=tmux).
  const threadTmuxView =
    active !== undefined &&
    new URLSearchParams(location.search).get("view") === "tmux";

  // One polling mount makes every active loader live (shell, home,
  // thread, projects, lens). Paused on hidden tab; never overlaps itself.
  // Route-aware interval - terminal surfaces (Team tab or a thread
  // in tmux view) want a ~1s live feel; everything else stays at the 3s
  // default. Still exactly ONE timer.
  useLiveRevalidate(
    location.pathname.startsWith("/tmux") || threadTmuxView ? 1000 : undefined
  );
  // Soft in-app ping when a new unread message lands
  // (covers the open-tab case push notifications do not need to).
  useMessageChime(agents);
  // The active agent's avatar for the app-bar identity fold.
  const activeAgent = active ? agents.find((a) => a.name === active) : undefined;
  const activeAvatarUrl = activeAgent?.avatarUrl;
  const activeHasUnread = activeAgent?.hasUnread === true;

  // Slide-out work panel ("properties" column). Ephemeral UI state -
  // no URL param. Closes on any navigation (card rows navigate to /projects).
  const [workOpen, setWorkOpen] = useState(false);
  useEffect(() => {
    setWorkOpen(false);
  }, [location.pathname]);

  return (
    <div className="flex h-screen flex-col">
      {/* Top bar.

          WRAPPING, and why the header is not `h-14` any more.
          The escalation chip is ~176px of deliberately unshrinkable text
          (whitespace-nowrap, and truncating it would throw away the duration,
          which is the whole point of the chip). Added to the right-hand
          cluster that already carries the files toggle and the bell, it took
          the cluster from 132px to 264px, which on a phone left the LEFT group
          a box far narrower than its own contents. `min-w-0` lets that box
          shrink, but the avatar and the chat/terminal toggle inside it are
          `shrink-0`, so they did not shrink with it - they OVERFLOWED their
          box and were painted underneath the right-hand cluster. Measured in
          Chromium against the real stylesheet (see the e2e layout test): at
          375px the toggle overlapped the chip by 58px and the thread title was
          crushed to zero width; at 320px the whole toggle sat under the chip
          (78px, i.e. all of it) and was therefore unclickable, since the chip
          is later in DOM order and paints on top. That is strictly worse than
          the bare-icon bug the visible reason set out to fix, and it is the
          ONE surface the operator reads on a phone.

          So the header wraps: `flex-wrap` plus a `gap-x-2` (the gap is what
          makes a `w-full` item exceed the line and start a new one), and
          `min-h-14` instead of `h-14` so a second row makes the bar taller
          rather than spilling over the content below. `min-h-` and not a
          padded `h-`: measured, the height is byte-identical to the old fixed
          `h-14` at every width where nothing wraps, INCLUDING the 768-1023
          band where the left group is already 56px tall and a vertical
          padding would have pushed the bar to 65px for a case that has
          nothing to do with escalation.

          `flex-1` on this left group is the other half: with a content-sized
          basis it is the left group that decides where the line breaks, and a
          thread title alone is enough to push the bell onto its own row on a
          360px Android. At `basis-0` it never forces a break and simply takes
          whatever the line has left, which is also the SPEC's stated priority
          order (the thread title yields, the alert does not).

          `overflow-hidden` is the backstop for everything this class of bug
          can still throw at us: if the left group's contents ever outgrow its
          box again they are CLIPPED at its edge instead of being drawn over
          the controls to its right. A clipped glyph is visibly wrong; an
          invisible overlay that swallows taps is not. Safe against the two
          things inside it that escape their box on purpose - the Radix model
          dropdown renders through a Portal, and the unread dot is positioned
          inside its own link. */}
      <header className="flex min-h-14 shrink-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 border-b border-border bg-card/60 px-4 backdrop-blur-sm lg:flex-nowrap lg:gap-y-0">
        <div className="flex min-w-0 flex-1 items-center gap-4 overflow-hidden">
          <Link
            to="/"
            aria-label="Inkie Deck home"
            className="font-display text-lg font-black uppercase tracking-tight text-foreground hover:opacity-80 transition-opacity"
          >
            {/* Mobile UX: the full wordmark squeezed the
                thread identity + view toggle off-screen on phones. */}
            <span className="md:hidden">MC</span>
            <span className="hidden md:inline">Inkie Deck</span>
          </Link>
          {instanceLabel ? (
            <span
              data-testid="instance-label"
              className="label-mono rounded-full border-2 border-accent/40 bg-accent/10 px-3 py-1 text-xs text-foreground"
            >
              {instanceLabel}
            </span>
          ) : null}
          {/* Thread C: Decisions + Actions tab - always shown (unlike the
              cron-gated Nudges link). A second surface, added without touching
              the homepage or the bell count. The two lists have since been
              harmonised on every terminal state; see queue-derive.ts. */}
          <NavLink
            to="/cards"
            className={({ isActive }) =>
              isActive
                ? "label-mono min-h-[44px] hidden md:flex items-center text-foreground underline underline-offset-4"
                : "label-mono min-h-[44px] hidden md:flex items-center text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            Cards
          </NavLink>
          {/* Projects board NavLink. Mobile: lives in the agent
              strip instead (the top bar cannot fit nav + identity + toggle). */}
          <NavLink
            to="/projects"
            className={({ isActive }) =>
              isActive
                ? "label-mono min-h-[44px] hidden md:flex items-center text-foreground underline underline-offset-4"
                : "label-mono min-h-[44px] hidden md:flex items-center text-muted-foreground transition-colors hover:text-foreground"
            }
          >
            Projects
          </NavLink>
          {draftsNavOn ? (
            <NavLink
              to="/drafts"
              className={({ isActive }) =>
                isActive
                  ? "label-mono min-h-[44px] hidden md:flex items-center text-foreground underline underline-offset-4"
                  : "label-mono min-h-[44px] hidden md:flex items-center text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              Drafts
            </NavLink>
          ) : null}
          {/* Scheduler admin link - operator-only, shown only when cronAdminOn. */}
          {cronAdminOn ? (
            <NavLink
              to="/scheduler"
              className={({ isActive }) =>
                isActive
                  ? "label-mono min-h-[44px] hidden md:flex items-center text-foreground underline underline-offset-4"
                  : "label-mono min-h-[44px] hidden md:flex items-center text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              Nudges
            </NavLink>
          ) : null}
          {/* Team tab removed - the per-thread chat/terminal toggle superseded it.
              The /tmux route stayed functional for old bookmarks, just unlinked,
              until the activity panel landed there and had nothing
              pointing to it. Re-added later, relabelled "Activity" -
              gated on activityNavOn (this instance has an activity root
              configured) so an instance without one shows no dead link. */}
          {activityNavOn ? (
            <NavLink
              to="/tmux"
              className={({ isActive }) =>
                isActive
                  ? "label-mono min-h-[44px] hidden md:flex items-center text-foreground underline underline-offset-4"
                  : "label-mono min-h-[44px] hidden md:flex items-center text-muted-foreground transition-colors hover:text-foreground"
              }
            >
              Activity
            </NavLink>
          ) : null}
          {/* Active thread's identity folds into the app bar - the
              standalone thread header row is gone, messages start at the top.
              thread-header testid migrates WITH the element so the 12 e2e
              toContainText pins survive unedited. */}
          {active ? (
            <span className="flex min-w-0 items-center gap-2">
              <span aria-hidden="true" className="h-6 w-px shrink-0 bg-border" />
              <Avatar name={active} src={activeAvatarUrl} className="h-7 w-7 text-[10px]" />
              <h1
                data-testid="thread-header"
                className="font-display truncate text-lg font-black uppercase tracking-tight text-foreground"
              >
                {active}
              </h1>
              {/* Chat/terminal segmented toggle. The chat
                  half carries an unread dot while terminal mode holds back
                  read receipts, so the toggle carries the signal the honest
                  receipt creates. */}
              {tmuxOn ? (
              <span
                role="group"
                aria-label="Thread view"
                className="ml-1 inline-flex shrink-0 items-center rounded-md border border-border bg-card p-0.5"
              >
                <Link
                  to={`${location.pathname}${threadViewSearch(location.search, undefined)}`}
                  data-testid="thread-view-chat"
                  aria-label="Show messages"
                  aria-current={!threadTmuxView ? "true" : undefined}
                  className={cn(
                    "relative inline-flex min-h-9 min-w-9 items-center justify-center rounded transition-colors",
                    !threadTmuxView
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <MessageSquare className="size-4" />
                  {threadTmuxView && activeHasUnread ? (
                    <span
                      data-testid="thread-view-chat-unread"
                      className="absolute right-0.5 top-0.5 size-2 rounded-full bg-accent"
                      aria-label="Unread messages"
                    />
                  ) : null}
                </Link>
                <Link
                  to={`${location.pathname}${threadViewSearch(location.search, "tmux")}`}
                  data-testid="thread-view-tmux"
                  aria-label="Show live terminal"
                  aria-current={threadTmuxView ? "true" : undefined}
                  className={cn(
                    "inline-flex min-h-9 min-w-9 items-center justify-center rounded transition-colors",
                    threadTmuxView
                      ? "bg-primary/10 text-foreground"
                      : "text-muted-foreground hover:text-foreground"
                  )}
                >
                  <TerminalSquare className="size-4" />
                </Link>
              </span>
              ) : null}
              {/* M5: configured-model chip + dropdown. Operator-only by
                  construction - the shell loader passes the prop only when
                  modelSelectorEnabled, so a principal instance mounts
                  nothing here. */}
              {modelSelector !== undefined ? (
                <ModelSelector data={modelSelector} />
              ) : null}
              <ProviderBadge provider={codexQuota.providers[active] ?? "unknown"} />
            </span>
          ) : null}
        </div>

        {/* Right-hand control cluster. `w-full` below `lg` when - and only
            when - the single-agent escalation chip is in here is what buys the
            cluster its own row: a full-width flex item cannot share a line
            with anything (the header's gap-x pushes it over), so the chip
            lands on row two at its natural width and the reason text stays
            whole. It is the CLUSTER that drops, not the chip alone, because
            the chip lives inside here and moving it out to be a header-level
            sibling would either reorder the desktop bar or need an `order`
            override, which puts visual order and tab order out of step.

            Conditional on `escalated.length === 1` deliberately. With no
            escalation this cluster is 84px and with the multi-agent dropdown
            it is 132px - both fit inline at 320px with room to spare, so
            neither has any business costing a phone a second header row.
            `justify-end` keeps the controls hard right on the wrapped row, so
            the bar reads the same way it does when it is one line. */}
        <div
          className={cn(
            "flex items-center justify-end gap-1",
            escalated.length === 1 ? "w-full lg:w-auto" : undefined
          )}
        >
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                data-testid="codex-quota-trigger"
                aria-label={`Codex quota: ${codexQuota.quota.blocked ? "blocked" : codexQuota.quota.freshness}`}
                className={cn(
                  "relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  codexQuota.quota.blocked ? "text-destructive" : "text-muted-foreground"
                )}
              >
                <Gauge className="size-5" aria-hidden="true" />
                {codexQuota.quota.blocked ? (
                  <span className="absolute right-1 top-1 size-2 rounded-full bg-destructive" aria-hidden="true" />
                ) : null}
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-80">
              <DropdownMenuLabel>Codex usage</DropdownMenuLabel>
              <DropdownMenuSeparator />
              <CodexQuotaPanel quota={codexQuota.quota} />
            </DropdownMenuContent>
          </DropdownMenu>
          {/* File pinner: per-thread Files panel toggle. Chat view only (the
              manifest is built from chat messages, not the tmux pane). Pure
              URL-state (?files=1) - no shell prop needed. */}
          {active && !threadTmuxView ? <FilesPanelToggle /> : null}
          {/* Work-panel trigger - left of the bell, present only when
              the open thread's agent has live cards. Same badge grammar as
              the bell. */}
          {active && workCards.length > 0 ? (
            <button
              type="button"
              data-testid="work-strip-trigger"
              aria-label={`${active}'s cards (${workCards.length})`}
              aria-expanded={workOpen}
              onClick={() => setWorkOpen((open) => !open)}
              className={cn(
                "relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                workOpen ? "bg-muted text-foreground" : "text-muted-foreground"
              )}
            >
              <KanbanSquare className="size-5" />
              <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 font-mono text-[10px] font-bold leading-none text-primary-foreground">
                {workCards.length}
              </span>
            </button>
          ) : null}

          {/* Top-bar escalation alert: distinct icon (TriangleAlert,
              StatusPill's own `stuck` glyph) and destructive tint so this
              never blurs into the needs-you bell's count - it is a different
              claim ("an agent has been silently wedged") not an action queue.
              Single escalated agent -> direct click-through to its thread.
              Multiple -> a dropdown, same shape as the bell's. No dismiss/
              mute in v1 (SPEC): it is a live-computed present/absent state
              off current data, not a fired-once event.

              The single-agent branch spells the REASON out in
              visible text ("quill stuck for 45m") rather than leaving the
              glyph bare with the facts only in aria-label. That shape was hit
              live - red triangle, click, thread, no idea why it fired or
              whether it was worth the interruption. The duration is the
              number the interruption gets priced with, so it cannot live
              behind a screen reader (or a mouse-only title=, which never
              fires on touch); house rule, see StatusPill. The count badge
              goes with it: naming the agent makes a badge reading "1" pure
              noise. The dropdown branch below keeps its count - a count is
              the only summary available there - and is otherwise untouched.
              aria-label drops "has been" so the visible label is a contiguous
              substring of the accessible name (WCAG 2.5.3 Label in Name),
              which also spares screen readers "quill has been needs you for
              45m". */}
          {escalated.length === 1 ? (
            <Link
              to={`/threads/${escalated[0]!.agent}`}
              data-testid="escalation-alert"
              aria-label={`${escalated[0]!.agent} ${statusLabel(escalated[0]!.status)} for ${formatDurationHm(escalated[0]!.durationMs)} - go to thread`}
              className="inline-flex min-h-11 items-center gap-1.5 rounded-md px-2 text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <TriangleAlert className="size-5 shrink-0" aria-hidden="true" />
              {/* Plain text, not label-mono: the top bar's nav idiom
                  uppercases on 0.18em tracking, which is both shouty for an
                  agent's name and ~60% wider - width the header does not
                  have on a phone. The dropdown renders its own reason line
                  ("wedged 45m") as plain text for the same reason. */}
              <span
                data-testid="escalation-reason"
                className="whitespace-nowrap text-xs font-medium"
              >
                {escalated[0]!.agent} {statusLabel(escalated[0]!.status)} for{" "}
                {formatDurationHm(escalated[0]!.durationMs)}
              </span>
            </Link>
          ) : escalated.length > 1 ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <button
                  type="button"
                  data-testid="escalation-alert"
                  aria-label={`Wedged agents (${escalated.length})`}
                  className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-destructive transition-colors hover:bg-destructive/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TriangleAlert className="size-5" />
                  <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-destructive px-1 font-mono text-[10px] font-bold leading-none text-destructive-foreground">
                    {escalated.length}
                  </span>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-72">
                <DropdownMenuLabel>Wedged ({escalated.length})</DropdownMenuLabel>
                <DropdownMenuSeparator />
                {escalated.map((e) => (
                  <DropdownMenuItem key={e.agent} asChild>
                    <Link
                      to={`/threads/${e.agent}`}
                      data-testid={`escalation-item-${e.agent}`}
                      className="flex flex-col items-start gap-0.5"
                    >
                      <span className="flex w-full items-center gap-2">
                        <span className="font-display text-xs font-bold uppercase tracking-tight text-foreground">
                          {e.agent}
                        </span>
                        <span className="label-mono ml-auto text-[10px] text-muted-foreground">
                          {statusLabel(e.status)}
                        </span>
                      </span>
                      <span className="text-sm text-destructive">
                        wedged {formatDurationHm(e.durationMs)}
                      </span>
                    </Link>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            {/* Bell tap target: min 44px per tap-target sweep */}
            <button
              type="button"
              aria-label={`Needs you${needsCount > 0 ? ` (${needsCount})` : ""}`}
              className="relative inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Bell className="size-5" />
              {needsCount > 0 ? (
                <span className="absolute -right-0.5 -top-0.5 inline-flex h-4 min-w-4 items-center justify-center rounded-full bg-accent px-1 font-mono text-[10px] font-bold leading-none text-accent-foreground">
                  {needsCount}
                </span>
              ) : null}
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-80">
            <DropdownMenuLabel>
              Needs you{needsCount > 0 ? ` (${needsCount})` : ""}
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {needsItems.length === 0 ? (
              <div className="px-2 py-6 text-center text-sm text-muted-foreground">
                You are all caught up.
              </div>
            ) : (
              (() => {
                const decisions = needsItems.filter(i => i.kind === "decision");
                const todos = needsItems.filter(i => i.kind === "action");
                const blocked = needsItems.filter(i => i.kind === "blocked");
                const sections: Array<{ label: string; items: typeof needsItems }> = [
                  { label: "Decisions", items: decisions },
                  { label: "Todos", items: todos },
                  { label: "Blocked", items: blocked },
                ];
                return sections.flatMap(({ label, items }) => {
                  if (items.length === 0) return [];
                  return [
                    <DropdownMenuSeparator key={`sep-${label}`} />,
                    <DropdownMenuLabel key={`label-${label}`} className="label-mono text-[10px] text-muted-foreground px-2 py-1">
                      {label} ({items.length})
                    </DropdownMenuLabel>,
                    ...items.map((item) => (
                      <DropdownMenuItem key={item.id} asChild>
                        <Link
                          to={item.deepLink}
                          className="flex flex-col items-start gap-0.5"
                        >
                          <span className="flex w-full items-center gap-2">
                            <span className="font-display text-xs font-bold uppercase tracking-tight text-foreground">
                              {item.agent}
                            </span>
                            {item.overdue ? (
                              <Badge variant="destructive" className="ml-auto text-[10px]">
                                Overdue
                              </Badge>
                            ) : null}
                            <time
                              dateTime={item.createdAt}
                              title={item.createdAt}
                              className="label-mono text-[10px] text-muted-foreground ml-auto"
                            >
                              {formatRelative(item.createdAt)}
                            </time>
                          </span>
                          <span className="line-clamp-2 text-sm text-foreground/80">
                            {item.subject}
                          </span>
                        </Link>
                      </DropdownMenuItem>
                    )),
                  ];
                });
              })()
            )}
            {/* Per-device push enrolment lives where notifications
                live. The toggle renders nothing on unsupported browsers. */}
            <DropdownMenuSeparator />
            <PushToggle />
            {/* Build stamp: proves which CLIENT bundle this
                device is running - the no-404 deploy keeps old assets alive,
                so a long-lived phone tab can hold yesterday's JS. Reachable
                from any viewport via the bell. */}
            <DropdownMenuSeparator />
            <div
              data-testid="build-stamp"
              title="The build this device is running - if it differs from the latest deploy, force-refresh"
              className="label-mono px-2 py-1 text-right text-[10px] text-muted-foreground/60"
            >
              build {typeof __MC_BUILD_SHA__ === "string" ? __MC_BUILD_SHA__ : "unknown"}
            </div>
          </DropdownMenuContent>
        </DropdownMenu>
        </div>
      </header>

      {/*
        Mobile agent strip (visible only under md).
        One scrollable row of avatar buttons, each min 44px tall, snap scrolling.
        Reuses the same view-model (agents prop) as the sidebar.
      */}
      <div
        data-testid="agent-strip"
        className="flex shrink-0 overflow-x-auto border-b border-border bg-card/40 px-2 py-1 md:hidden"
        style={{ scrollSnapType: "x mandatory", WebkitOverflowScrolling: "touch" }}
      >
        {/* Thread C: Cards tab (mobile). Always shown. */}
        <Link
          to="/cards"
          data-testid="agent-strip-cards"
          aria-label="Cards"
          className="relative mx-0.5 flex min-h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted"
          style={{ scrollSnapAlign: "start" }}
        >
          <SquareStack className="size-5" />
          <span className="text-[8px] font-bold uppercase tracking-wider">Cards</span>
        </Link>
        {/* Mobile UX: Projects + Team moved here from the
            top bar so the bar fits the thread identity + view toggle. */}
        <Link
          to="/projects"
          data-testid="agent-strip-projects"
          aria-label="Projects board"
          className="relative mx-0.5 flex min-h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted"
          style={{ scrollSnapAlign: "start" }}
        >
          <KanbanSquare className="size-5" />
          <span className="text-[8px] font-bold uppercase tracking-wider">Board</span>
        </Link>
        {cronAdminOn ? (
          <Link
            to="/scheduler"
            data-testid="agent-strip-crons"
            aria-label="Nudges"
            className="relative mx-0.5 flex min-h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-muted"
            style={{ scrollSnapAlign: "start" }}
          >
            <CalendarClock className="size-5" />
            <span className="text-[8px] font-bold uppercase tracking-wider">Nudges</span>
          </Link>
        ) : null}
        <span aria-hidden="true" className="mx-1 h-8 w-px shrink-0 self-center bg-border" />
        {agents.map((a) => (
          <Link
            key={a.name}
            to={`/threads/${a.name}`}
            prefetch="intent"
            data-testid={`agent-strip-btn-${a.name}`}
            title={a.name}
            aria-label={a.name}
            className={cn(
              "relative mx-0.5 flex min-h-11 min-w-11 shrink-0 flex-col items-center justify-center rounded-lg p-1.5 transition-colors",
              active === a.name
                ? "ring-2 ring-primary ring-offset-1"
                : "hover:bg-muted"
            )}
            style={{ scrollSnapAlign: "start" }}
          >
            <Avatar name={a.name} src={a.avatarUrl} className="h-8 w-8 text-xs" />
            {/* Two dots: magenta = unread message, burnt-orange =
                open decision. Stacked top-right; both can show. */}
            <span className="absolute right-0.5 top-0.5 flex items-center gap-0.5">
              {a.hasUnread ? (
                <span
                  data-testid={`strip-dot-message-${a.name}`}
                  className="size-2 rounded-full bg-accent-message"
                  aria-hidden="true"
                />
              ) : null}
              {a.hasUnhandled ? (
                <span
                  data-testid={`strip-dot-decision-${a.name}`}
                  className="size-2 rounded-full bg-accent"
                  aria-hidden="true"
                />
              ) : null}
            </span>
          </Link>
        ))}
      </div>

      {/* Two-pane body: sidebar hidden under md, visible md+.
          Resizable split. The sidebar panel + handle are display:none
          under md, so they leave flex layout entirely and the main panel
          fills 100% - desktop-only by construction, no conditional render,
          no double Outlet. autoSaveId persists the split (localStorage). */}
      <div className="relative flex min-h-0 flex-1">
        <ResizablePanelGroup direction="horizontal" autoSaveId="mc-shell-split">
          <ResizablePanel
            defaultSize={22}
            minSize={14}
            maxSize={38}
            className="hidden md:flex"
          >
            <Sidebar agents={agents} />
          </ResizablePanel>
          <ResizableHandle withHandle className="hidden md:flex" />
          <ResizablePanel minSize={50}>
            <main className="h-full w-full min-w-0 overflow-y-auto">
              <Outlet />
            </main>
          </ResizablePanel>
        </ResizablePanelGroup>

        {/* Slide-out work panel - properties-style right column.
            Overlays below the top bar; closes on X or any navigation. */}
        {workOpen && active ? (
          <aside
            data-testid="work-strip-panel"
            aria-label={`${active}'s live cards`}
            className="absolute inset-y-0 right-0 z-20 flex w-80 max-w-[85vw] flex-col border-l border-border bg-card shadow-lg"
          >
            <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2">
              <span className="label-mono text-xs text-muted-foreground">
                {active}'s cards ({workCards.length})
              </span>
              <button
                type="button"
                aria-label="Close cards panel"
                onClick={() => setWorkOpen(false)}
                className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-3">
              <WorkStrip cards={workCards} onNavigate={() => setWorkOpen(false)} />
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
