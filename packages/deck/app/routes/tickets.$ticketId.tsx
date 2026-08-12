/**
 * tickets.$ticketId.tsx - Ticket-thread lens route (TASK-445).
 *
 * Aggregates all message blocks tagged with a given ticket id from all
 * agent threads. Read-only by construction: this route exports a loader
 * ONLY. No action, no store writes, no raw write imports.
 *
 * Loader:
 *   - normaliseTicket(param) -> null -> throw 404 (invalid id shape).
 *   - Read all agents' blocks via makeStores -> inbox.listAgents + readBlocks.
 *   - Aggregate via aggregateTicketThread (pure, chronological, per-agent attr.).
 *   - Guarded listCards() -> first matching card (by normalised ticketId).
 *     On multiple matches, newest-updated wins (list is sorted updated-desc).
 *   - Returns serialisable loader data: ticketId, messages, card (optional).
 *
 * Render:
 *   - Pinned card header when a card matches: title, column Badge, blocked-on,
 *     links chips, "Open on board" -> /projects?card=<id>, Linear link-out via
 *     ticketUrl().
 *   - MessageBubble stream with "in <agent>" origin tags linking to /threads/<agent>.
 *   - EmptyState when valid id but nothing tagged and no card.
 *
 * SEAM RULE (FND-02): imports ONLY makeStores from ~/lib/stores.server.
 * No node:fs, no literal inbox path or env key references here.
 * Exception: listCards from projects.server (env-backed seam, same discipline).
 *
 * ASCII only - no em-dashes (FND-05).
 */
import type { Route } from "./+types/tickets.$ticketId";
import { RouteErrorPanel } from "~/components/RouteErrorPanel";
import { Link } from "react-router";
import { ExternalLink, FileText, LayoutDashboard, Ticket } from "lucide-react";
import { makeStores } from "~/lib/stores.server";
import { listCards } from "~/lib/projects.server";
import { normaliseTicket, ticketUrl } from "~/lib/ticket";
import { resolveNow } from "~/lib/time";
import { mcUser, filterCardsForInstance } from "~/lib/instance.server";
import { aggregateTicketThread } from "~/lib/ticket-thread";
import type { AgentBlockEntry } from "~/lib/ticket-thread";
import { MessageBubble } from "~/components/MessageBubble";
import { EmptyState } from "~/components/EmptyState";
import { Badge } from "~/components/ui/badge";
import type { ProjectCard } from "~/lib/projects.shared";

// Column -> Badge variant map (same as CardDetail).
const COLUMN_VARIANT: Record<
  string,
  "default" | "secondary" | "warning" | "destructive" | "outline"
> = {
  todo: "secondary",
  "in progress": "default",
  blocked: "warning",
  "in review": "outline",
  done: "secondary",
};

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader({ params }: Route.LoaderArgs) {
  // Normalise and validate the ticket id param.
  const raw = params.ticketId ?? "";
  const ticketId = normaliseTicket(raw);
  if (ticketId === null) {
    throw new Response(null, { status: 404 });
  }

  // Read all agents' blocks through the seam.
  const { inbox } = makeStores(process.env);
  // TASK-462: per-instance user.
  const user = mcUser(process.env);
  const agentNames = await inbox.listAgents();

  const entries: AgentBlockEntry[] = [];
  await Promise.all(
    agentNames.map(async (name) => {
      const blocks = await inbox.readBlocks(name, user);
      for (const block of blocks) {
        entries.push({ agentName: name, block });
      }
    })
  );

  // Aggregate tagged blocks for this ticket (chronological, with agent attribution).
  const messages = aggregateTicketThread(entries, ticketId);

  // Now timestamp for relative display.
  const nowIso = resolveNow(process.env["MC_NOW"]).toISOString();

  // Guarded listCards: find the card with matching normalised ticket id.
  // Degrade to null when projects root is unset or on any error.
  let matchedCard: ProjectCard | null = null;
  try {
    // TASK-462: scoped to this instance's agents (no-op on Alex's).
    const allCards = filterCardsForInstance(listCards(), process.env);
    // allCards is sorted updated-desc; first match is newest-updated.
    for (const c of allCards) {
      if (c.ticketId === ticketId) {
        matchedCard = c;
        break;
      }
    }
  } catch {
    // Projects root not configured - card absent.
  }

  return {
    ticketId,
    messages,
    card: matchedCard,
    nowIso,
    linearUrl: ticketUrl(ticketId),
    user,
  };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function TicketLens({ loaderData }: Route.ComponentProps) {
  const { ticketId, messages, card, nowIso, linearUrl, user } = loaderData;

  return (
    <div className="flex h-full flex-col">
      {/* Header */}
      <header className="flex shrink-0 items-center gap-3 border-b border-border bg-card/40 px-6 py-3 backdrop-blur-sm">
        <Ticket className="size-5 text-muted-foreground" aria-hidden="true" />
        <h1
          data-testid="ticket-lens-header"
          className="font-display text-lg font-black uppercase tracking-tight text-foreground"
        >
          {ticketId}
        </h1>
      </header>

      <div className="flex-1 overflow-y-auto px-6 pt-6 pb-10">
        <div className="mx-auto max-w-2xl">
          {/* Linear link-out: the MOST prominent affordance, first row,
              full-width (Atlas fold, TASK-445 plan s5b). The user whose
              intent was straight-to-Linear pays one hop either way;
              first-position makes it a glance, not a toll. */}
          <a
            href={linearUrl}
            target="_blank"
            rel="noopener noreferrer"
            data-testid="ticket-lens-linear-link"
            aria-label={`Open ${ticketId} on Linear`}
            className="mb-4 flex min-h-11 w-full items-center justify-between rounded-xl border border-border bg-card px-5 py-3 text-sm font-medium text-foreground hover:border-primary hover:text-primary transition-colors"
          >
            <span>Open {ticketId} on Linear</span>
            <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
          </a>

          {/* Pinned card header */}
          {card !== null ? (
            <PinnedCardHeader card={card} />
          ) : null}

          {/* Message stream */}
          {messages.length === 0 ? (
            <EmptyState
              icon={Ticket}
              title={`No activity for ${ticketId} yet`}
              body="Tag a message with this ticket id to see it here."
            />
          ) : (
            <div className="flex flex-col mt-4">
              {messages.map((msg, idx) => (
                <div key={idx} className="mb-2">
                  {/* Origin tag linking to the agent thread */}
                  <div className="mb-1 px-1 flex items-center gap-1">
                    <span className="label-mono text-[10px] text-muted-foreground">
                      in{" "}
                      <Link
                        to={`/threads/${msg.agentName}`}
                        prefetch="intent"
                        data-testid="ticket-lens-origin-tag"
                        className="text-primary hover:underline"
                      >
                        {msg.agentName}
                      </Link>
                    </span>
                  </div>
                  <MessageBubble
                    own={msg.block.header.from === user}
                    block={msg.block}
                    now={nowIso}
                    threadAgent={msg.agentName}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// PinnedCardHeader
// ---------------------------------------------------------------------------

function PinnedCardHeader({ card }: { card: ProjectCard }) {
  const colVariant = COLUMN_VARIANT[card.column] ?? "secondary";

  return (
    <div
      data-testid="ticket-lens-card"
      className="mb-4 rounded-xl border border-border bg-card px-5 py-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h2
          data-testid="ticket-lens-card-title"
          className="font-display text-base font-black uppercase tracking-tight text-foreground"
        >
          {card.title}
        </h2>
        <Badge variant={colVariant} className="text-xs" data-testid="ticket-lens-card-column">
          {card.column}
        </Badge>
      </div>
      {card.blockedOn ? (
        <p className="mt-1 text-xs text-accent">
          Blocked: {card.blockedOn}
        </p>
      ) : null}
      <div className="mt-3 flex flex-wrap items-center gap-2">
        {card.links && card.links.length > 0 ? (
          card.links.map((link) => {
            const filename = link.split("/").pop() ?? link;
            return (
              <span
                key={link}
                className="inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
                data-testid="ticket-lens-link-chip"
              >
                <FileText className="size-3 shrink-0 text-muted-foreground" />
                <span className="label-mono truncate max-w-[160px]">{filename}</span>
              </span>
            );
          })
        ) : null}
        <Link
          to={`/projects?card=${card.id}`}
          data-testid="ticket-lens-open-on-board"
          className="inline-flex items-center gap-1 text-xs text-primary hover:underline"
        >
          <LayoutDashboard className="size-3" aria-hidden="true" />
          Open on board
        </Link>
        {/* No card-level Linear link: the full-width first-row link-out
            directly above this card is the single Linear affordance
            (Atlas fold - one clear destination, no duplicate chrome). */}
      </div>
    </div>
  );
}

/**
 * Scoped error boundary (2026-06-11 lifeline hardening): a failure in this
 * route renders here, inside the shell - the sidebar and the rest of MC stay
 * usable. Real error text shown (tailnet-only internal tool).
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <RouteErrorPanel
      error={error}
      scope="this ticket lens"
      hint="The underlying threads are unaffected."
    />
  );
}
