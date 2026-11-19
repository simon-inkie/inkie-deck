/**
 * home.tsx - Inkie Deck index: "Needs you" overview (three kinds).
 *
 * Loader reads all agents and their blocks through the seam (makeStores ->
 * inbox.listAgents + inbox.readBlocks per agent). Also reads project cards via
 * listCards() (server-side). Calls deriveNeedsYou to build the ranked
 * needs-you view-model, persisting first-seen deadline anchors to the
 * FileQueueStore. Returns plain serializable rows.
 *
 * Three item kinds on one ranked list (in place, no tabs/rails/filters):
 *   1. Unanswered decision cards - with inline answer buttons
 *   2. Un-done action cards - with inline Done tick
 *   3. Blocked kanban cards - link-only
 *
 * Action dispatches:
 *   - markHandled (decisions/plain): marks item handled in queue store
 *   - done (actions): forwards to inbox.markActionDone
 *
 * SEAM RULE: imports ONLY makeStores from ~/lib/stores.server.
 * No direct fs imports; no literal inbox path or env key references here.
 * Exception: listCards from projects.server (same seam discipline - env-backed).
 * Exception: getLatestBrief from briefs.server (same seam discipline - env-backed).
 *
 * Thread list: one row per agent with preview, absolute + relative time,
 * unhandled affordance. Empty state: no-agents message plus queue panel (empty
 * or ranked list).
 *
 * The "Inkie Deck" string is preserved here (as h1 heading and meta title)
 * so test/skeleton.test.ts Leg 1 assertion stays green after this rework.
 *
 * Includes the MorningBrief panel + ReviewPanel (same ?doc= wiring as projects.tsx).
 *
 * ASCII only - no em-dashes.
 */
import { z } from "zod";
import type { Route } from "./+types/home";
import { RouteErrorPanel } from "~/components/RouteErrorPanel";
import { useFetcher, Link, useSearchParams } from "react-router";
import { useCallback } from "react";
import { makeStores } from "~/lib/stores.server";
import { requireSameOriginWrite } from "~/lib/request-origin.server";
import { resolveNow } from "~/lib/time";
import { mcUser, filterCardsForInstance } from "~/lib/instance.server";
import { listCards } from "~/lib/projects.server";
import { getLatestBrief } from "~/lib/briefs.server";
import { deriveNeedsYou } from "~/lib/queue-derive";
import type { NeedsYouItem } from "~/lib/queue-derive";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { CheckCircle2, Check, ExternalLink, TriangleAlert, X } from "lucide-react";
import { EmptyState } from "~/components/EmptyState";
import { Timestamp } from "~/components/Timestamp";
import { MorningBrief } from "~/components/MorningBrief";
import { ReviewPanel, DOC_PARAM } from "~/components/ReviewPanel";
import { cn } from "~/lib/utils";
import { useState } from "react";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Inkie Deck" },
    { name: "description", content: "Inkie Deck - remote inbox management" },
  ];
}

// ---------------------------------------------------------------------------
// Action schema
// ---------------------------------------------------------------------------

const homeActionSchema = z.discriminatedUnion("intent", [
  z.object({
    intent: z.literal("markHandled"),
    itemId: z.string().min(1, "itemId is required"),
  }),
  z.object({
    intent: z.literal("done"),
    actionId: z.string().min(1, "actionId is required"),
    agent: z.string().min(1, "agent is required"),
  }),
  z.object({
    intent: z.literal("dismiss"),
    actionId: z.string().min(1, "actionId is required"),
    agent: z.string().min(1, "agent is required"),
    reason: z.string().optional(),
  }),
  z.object({
    intent: z.literal("doneNote"),
    actionId: z.string().min(1, "actionId is required"),
    agent: z.string().min(1, "agent is required"),
    note: z.string().min(1, "note is required"),
  }),
]);

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

export async function action({ request, context }: Route.ActionArgs) {
  requireSameOriginWrite(request, context);
  const formData = await request.formData();
  const raw = Object.fromEntries(formData);
  const parsed = homeActionSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.flatten() };
  }

  const { queue, inbox } = makeStores(process.env);

  if (parsed.data.intent === "markHandled") {
    await queue.markHandled(parsed.data.itemId);
    return { ok: true };
  }

  if (parsed.data.intent === "done") {
    // intent === "done": forward to inbox.markActionDone
    const result = await inbox.markActionDone(
      parsed.data.agent,
      mcUser(process.env),
      parsed.data.actionId
    );
    const alreadyDone = "alreadyDone" in result;
    return { ok: true, alreadyDone };
  }

  if (parsed.data.intent === "dismiss") {
    const result = await inbox.markActionDismissed(
      parsed.data.agent,
      mcUser(process.env),
      parsed.data.actionId,
      parsed.data.reason
    );
    const alreadyDismissed = "alreadyDismissed" in result;
    const alreadyDone = "alreadyDone" in result;
    return { ok: true, alreadyDismissed, alreadyDone };
  }

  // intent === "doneNote"
  const result = await inbox.addActionNote(
    parsed.data.agent,
    mcUser(process.env),
    parsed.data.actionId,
    parsed.data.note
  );
  const alreadyNoted = "alreadyNoted" in result;
  const notDone = "notDone" in result;
  return { ok: true, alreadyNoted, notDone };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader() {
  const { inbox, queue } = makeStores(process.env);
  const agents = await inbox.listAgents();
  const now = resolveNow(process.env["MC_NOW"]);
  // Per-instance user.
  const user = mcUser(process.env);

  // Collect all blocks across all agents for queue derivation.
  const allEntries = (
    await Promise.all(
      agents.map(async (agent) => {
        const blocks = await inbox.readBlocks(agent, user);
        return blocks.map((block) => ({ agentName: agent, block }));
      })
    )
  ).flat();

  // Read project cards for the blocked-column kind.
  // listCards() may throw if projects root is unset; degrade gracefully.
  let allProjectCards: Awaited<ReturnType<typeof listCards>> = [];
  try {
    // Scoped to this instance's agents.
    allProjectCards = filterCardsForInstance(listCards(), process.env);
  } catch {
    // Projects root not set or unreadable - blocked kind shows empty
  }

  const [handledIds, deadlineMap] = await Promise.all([
    queue.getHandled(),
    queue.getDeadlines(),
  ]);

  const { items: needsYouItems, newDeadlines } = deriveNeedsYou(
    allEntries,
    allProjectCards,
    handledIds,
    deadlineMap,
    now,
    user
  );

  // Persist first-seen deadline anchors so order is stable across reloads.
  for (const [id, deadline] of newDeadlines) {
    await queue.setDeadline(id, deadline);
  }

  // Morning brief - degrade gracefully (same guard as listCards above).
  let brief: Awaited<ReturnType<typeof getLatestBrief>> = null;
  try {
    brief = await getLatestBrief(process.env, now);
  } catch {
    // inbox root unset or fs error - brief absent is the correct fallback
  }

  // Compute isToday server-side so MorningBrief can set initial state without
  // reading localStorage during SSR (avoids hydration mismatch).
  const todayStr = [
    String(now.getUTCFullYear()),
    String(now.getUTCMonth() + 1).padStart(2, "0"),
    String(now.getUTCDate()).padStart(2, "0"),
  ].join("-");
  const briefIsToday = brief !== null && brief.date === todayStr;

  return { needsYouItems, now: now.toISOString(), brief, briefIsToday };
}

// ---------------------------------------------------------------------------
// Kind badge helper
// ---------------------------------------------------------------------------

function KindBadge({ kind }: { kind: NeedsYouItem["kind"] }) {
  if (kind === "decision") {
    return <Badge variant="default" className="text-xs shrink-0">Decide</Badge>;
  }
  if (kind === "action") {
    return <Badge className="text-xs shrink-0 bg-accent text-accent-foreground hover:bg-accent/90">Do</Badge>;
  }
  return <Badge variant="secondary" className="text-xs shrink-0">Blocked</Badge>;
}

// ---------------------------------------------------------------------------
// NeedsYouRow
// ---------------------------------------------------------------------------

function NeedsYouRow({ item, now }: { item: NeedsYouItem; now: string }) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";
  const [showDismissForm, setShowDismissForm] = useState(false);
  const [showNoteForm, setShowNoteForm] = useState(false);
  const [dismissReason, setDismissReason] = useState("");
  const [noteText, setNoteText] = useState("");

  // Optimistic state from fetcher submissions
  const lastSubmit = fetcher.formData?.get("intent");
  const optimisticDone =
    item.kind === "action" &&
    (lastSubmit === "done" || lastSubmit === "dismiss");

  return (
    <div
      data-testid="needs-you-item"
      className={cn(
        "mb-2 rounded-lg border bg-card p-3 transition-colors",
        item.overdue
          ? "border-destructive/40 bg-destructive/5"
          : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        {/* Left: link area */}
        <Link
          to={item.deepLink}
          className="flex min-w-0 flex-1 items-start gap-3 group"
        >
          <Avatar name={item.agentName} className="h-8 w-8 text-xs" />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 mb-0.5">
              <KindBadge kind={item.kind} />
              <p className="font-display text-xs font-bold uppercase tracking-tight text-foreground truncate">
                {item.agentName}
              </p>
              {/* createdAt: relative time + ISO in dateTime attr (Item 3) */}
              <span className="ml-auto shrink-0">
                <Timestamp iso={item.createdAt} now={now} />
              </span>
            </div>
            <p className="truncate text-sm text-foreground/80 group-hover:text-foreground">
              {item.title}
            </p>
            {/* Blocked context: summary + blocked-on (Item 4) */}
            {item.kind === "blocked" && item.summary ? (
              <p className="mt-0.5 truncate text-xs text-muted-foreground">
                {item.summary}
              </p>
            ) : null}
            {item.kind === "blocked" && item.blockedOn ? (
              <p className="mt-0.5 flex items-center gap-1 text-xs text-accent">
                <TriangleAlert className="h-3 w-3 shrink-0" aria-hidden="true" />
                Blocked on: {item.blockedOn}
              </p>
            ) : null}
            <div className="mt-1.5 flex items-center gap-2 flex-wrap">
              <p
                className={cn(
                  "font-mono text-xs",
                  item.overdue
                    ? "font-medium text-destructive"
                    : "text-muted-foreground"
                )}
              >
                {item.overdue ? "Overdue: " : ""}
                {item.ageDisplay}
              </p>
              {item.priority ? (
                <Badge
                  variant={item.priority.toLowerCase() === "high" ? "destructive" : "secondary"}
                  className="text-xs"
                >
                  {item.priority}
                </Badge>
              ) : null}
              {item.ticket ? (
                <a
                  href={item.ticket}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(e) => e.stopPropagation()}
                  className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
                >
                  Ticket
                  <ExternalLink className="h-3 w-3" aria-hidden="true" />
                </a>
              ) : null}
            </div>
          </div>
        </Link>

        {/* Right: action affordance */}
        <div className="flex shrink-0 items-center gap-2">
          {item.kind === "decision" && item.decisionId ? (
            <fetcher.Form method="post">
              <input type="hidden" name="intent" value="markHandled" />
              <input type="hidden" name="itemId" value={item.id} />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                disabled={busy}
              >
                {busy ? "..." : "Handled"}
              </Button>
            </fetcher.Form>
          ) : item.kind === "action" && item.actionId ? (
            <div className="flex items-center gap-1">
              {/* Done tick */}
              <fetcher.Form method="post">
                <input type="hidden" name="intent" value="done" />
                <input type="hidden" name="actionId" value={item.actionId} />
                <input type="hidden" name="agent" value={item.agentName} />
                <Button
                  type="submit"
                  variant="outline"
                  size="icon"
                  disabled={busy || optimisticDone}
                  aria-label="Mark as done"
                  data-testid="home-action-done-btn"
                  className={cn(
                    "h-11 w-11 rounded-full border-2 border-accent/50",
                    "hover:border-accent hover:bg-accent hover:text-accent-foreground",
                    "transition-colors"
                  )}
                >
                  <Check className="h-5 w-5" aria-hidden="true" />
                </Button>
              </fetcher.Form>
              {/* Dismiss X button (Item 5) */}
              <Button
                type="button"
                variant="outline"
                size="icon"
                disabled={busy || optimisticDone}
                aria-label="Dismiss action"
                data-testid="home-action-dismiss-btn"
                onClick={() => setShowDismissForm((v) => !v)}
                className={cn(
                  "h-11 w-11 rounded-full border-2 border-muted",
                  "hover:border-destructive hover:bg-destructive/10 hover:text-destructive",
                  "transition-colors"
                )}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </Button>
            </div>
          ) : null}
          {/* Blocked: link-only, no inline mutation */}
        </div>
      </div>

      {/* Inline dismiss form (revealed by X click) */}
      {showDismissForm && item.kind === "action" && item.actionId ? (
        <fetcher.Form
          method="post"
          className="mt-2 flex items-center gap-2"
          onSubmit={() => setShowDismissForm(false)}
        >
          <input type="hidden" name="intent" value="dismiss" />
          <input type="hidden" name="actionId" value={item.actionId} />
          <input type="hidden" name="agent" value={item.agentName} />
          <input
            type="text"
            name="reason"
            value={dismissReason}
            onChange={(e) => setDismissReason(e.target.value)}
            placeholder={`Why not? (optional - travels back to ${item.agentName})`}
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="home-dismiss-reason-input"
          />
          <Button
            type="submit"
            variant="destructive"
            size="sm"
            disabled={busy}
            data-testid="home-dismiss-confirm-btn"
          >
            Dismiss
          </Button>
        </fetcher.Form>
      ) : null}

      {/* Done note affordance (revealed after done) */}
      {showNoteForm && item.kind === "action" && item.actionId ? (
        <fetcher.Form
          method="post"
          className="mt-2 flex items-center gap-2"
          onSubmit={() => setShowNoteForm(false)}
        >
          <input type="hidden" name="intent" value="doneNote" />
          <input type="hidden" name="actionId" value={item.actionId} />
          <input type="hidden" name="agent" value={item.agentName} />
          <input
            type="text"
            name="note"
            value={noteText}
            onChange={(e) => setNoteText(e.target.value)}
            placeholder="Add a note..."
            className="min-w-0 flex-1 rounded border border-border bg-background px-2 py-1 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            data-testid="home-done-note-input"
          />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy || noteText.trim().length === 0}
            data-testid="home-done-note-submit-btn"
          >
            Save note
          </Button>
        </fetcher.Form>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// SectionHeader
// ---------------------------------------------------------------------------

function SectionHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="mb-2 mt-4 flex items-center gap-2 first:mt-0">
      <span className="label-mono text-xs text-muted-foreground uppercase tracking-widest">
        {label}
      </span>
      <span className="inline-flex h-5 min-w-5 items-center justify-center rounded-full bg-muted px-1.5 font-mono text-[10px] font-bold text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Home({ loaderData }: Route.ComponentProps) {
  const { needsYouItems, now, brief, briefIsToday } = loaderData;
  const [, setSearchParams] = useSearchParams();

  const decisions = needsYouItems.filter((i) => i.kind === "decision");
  const todos = needsYouItems.filter((i) => i.kind === "action");
  const blocked = needsYouItems.filter((i) => i.kind === "blocked");

  const sections: Array<{ label: string; items: typeof needsYouItems }> = [
    { label: "Decisions", items: decisions },
    { label: "Todos", items: todos },
    { label: "Blocked", items: blocked },
  ];

  const hasAny = needsYouItems.length > 0;

  // Open a doc in the ReviewPanel via ?doc= (same pattern as projects.tsx).
  const handleOpenDoc = useCallback(
    (doc: string) => {
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.set(DOC_PARAM, doc);
        return next;
      });
    },
    [setSearchParams]
  );

  return (
    // Outer flex row: content column + optional review panel (55/45 idiom).
    <div className="flex h-full">
      {/* min-w-0: a flex item defaults to min-width:auto and refuses to shrink
          below its content's intrinsic width - the max-w-2xl inner block then
          forces this column to 672px and overflows a narrow (mobile) viewport,
          clipping card text. min-w-0 lets w-full resolve to the real viewport
          width. */}
      <div className="flex min-h-full min-w-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-2xl px-6 py-8">
          <header className="mb-6">
            <h1 className="font-display text-2xl font-black uppercase tracking-tight text-foreground">
              Needs you
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Decisions and actions waiting on you, most urgent first.
            </p>
          </header>

          {/* Morning brief - between header and needs-you sections. */}
          {brief !== null && brief !== undefined ? (
            <MorningBrief
              date={brief.date}
              markdown={brief.markdown}
              isToday={briefIsToday}
              onOpenDoc={handleOpenDoc}
            />
          ) : null}

          {!hasAny ? (
            <div data-testid="queue-empty-state">
              <EmptyState
                icon={CheckCircle2}
                title="Nothing needs you"
                body="Items that need a decision or action will collect here."
              />
            </div>
          ) : (
            <div>
              {sections.map(({ label, items }) => {
                if (items.length === 0) return null;
                return (
                  <div key={label} data-testid={`section-${label.toLowerCase()}`}>
                    <SectionHeader label={label} count={items.length} />
                    {items.map((item) => (
                      <NeedsYouRow key={item.id} item={item} now={now} />
                    ))}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* ReviewPanel for links inside the morning brief. */}
      <ReviewPanel />
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
      scope="the home queue"
      hint="Inbox or queue state may contain a malformed block - check the latest writes to the agent inbox files."
    />
  );
}
