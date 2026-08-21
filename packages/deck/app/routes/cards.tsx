/**
 * cards.tsx - Dedicated Decisions + Actions tab (Thread C).
 *
 * A second surface, additive when it landed: the homepage (home.tsx), its merged
 * deriveNeedsYou ranked list, and the sidebar bell count were all left exactly
 * as they were (Option 1). This tab is a focused list of the LIVE (unresolved)
 * decision + action cards across every agent, reusing the existing DecisionCard
 * / ActionCard components so a card can be answered / done / dismissed /
 * superseded in place.
 *
 * deriveCardsTab checks EVERY terminal state (answered/dismissed/superseded for
 * decisions, done/dismissed/superseded for actions), so a card closed here
 * leaves this tab immediately. deriveNeedsYou now agrees on all of them except a
 * DISMISSED DECISION, which is the surviving half of the Option-1 freeze; the
 * superseded half was lifted when the activity sweep began publishing its own
 * open-card count from the same files. Blocked kanban cards are NOT shown here -
 * this tab is decisions + actions only.
 *
 * Card mutation forms POST to the owning agent's thread action
 * (/threads/<agent>) via the postAction prop, so this route needs no action of
 * its own - the thread action already handles every intent. RR7 revalidates
 * this loader after each such fetcher submit, refreshing the list.
 *
 * SEAM RULE (FND-02): imports ONLY makeStores from ~/lib/stores.server.
 * ASCII only - no em-dashes (FND-05).
 */
import type { Route } from "./+types/cards";
import { useCallback } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { RouteErrorPanel } from "~/components/RouteErrorPanel";
import { makeStores } from "~/lib/stores.server";
import { resolveNow } from "~/lib/time";
import { mcUser } from "~/lib/instance.server";
import { deriveCardsTab } from "~/lib/queue-derive";
import { buildCardReplyHref } from "~/lib/card-reply-link";
import { DecisionCard } from "~/components/DecisionCard";
import { ActionCard } from "~/components/ActionCard";
import { EmptyState } from "~/components/EmptyState";
import { ReviewPanel, DOC_PARAM } from "~/components/ReviewPanel";
import { CheckCircle2 } from "lucide-react";

// ---------------------------------------------------------------------------
// Meta
// ---------------------------------------------------------------------------

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Cards - Inkie Deck" },
    { name: "description", content: "Decisions and actions waiting on you" },
  ];
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export async function loader() {
  const { inbox } = makeStores(process.env);
  const agents = await inbox.listAgents();
  const now = resolveNow(process.env["MC_NOW"]);
  const user = mcUser(process.env);

  // Same block scan the homepage loader does (listAgents + readBlocks per
  // agent). Kept local rather than shared with home.tsx so home stays a
  // zero-edit file under Option 1.
  const allEntries = (
    await Promise.all(
      agents.map(async (agent) => {
        const blocks = await inbox.readBlocks(agent, user);
        return blocks.map((block) => ({ agentName: agent, block }));
      })
    )
  ).flat();

  const items = deriveCardsTab(allEntries, user);

  return { items, now: now.toISOString() };
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function Cards({ loaderData }: Route.ComponentProps) {
  const { items, now } = loaderData;
  const navigate = useNavigate();
  const [, setSearchParams] = useSearchParams();

  const decisions = items.filter((i) => i.kind === "decision");
  const actions = items.filter((i) => i.kind === "action");

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
    <div className="flex h-full">
      <div className="flex min-h-full min-w-0 flex-1 flex-col">
        <div className="mx-auto w-full max-w-2xl px-6 py-8">
          <header className="mb-6">
            <h1 className="font-display text-2xl font-black uppercase tracking-tight text-foreground">
              Cards
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Open decisions and actions across every agent. Answer, tick,
              dismiss or supersede in place, no round-trip needed.
            </p>
          </header>

          {items.length === 0 ? (
            <div data-testid="cards-empty-state">
              <EmptyState
                icon={CheckCircle2}
                title="No open cards"
                body="Decisions and actions waiting on you will collect here."
              />
            </div>
          ) : (
            <div>
              {decisions.length > 0 ? (
                <section data-testid="cards-section-decisions" className="mb-6">
                  <h2 className="label-mono mb-2 text-xs uppercase tracking-widest text-muted-foreground">
                    Decisions
                  </h2>
                  {decisions.map((item) => (
                    <DecisionCard
                      key={`${item.agentName}/${item.block.card?.decisionId}`}
                      block={item.block}
                      now={now}
                      postAction={`/threads/${item.agentName}`}
                      onOpenDoc={handleOpenDoc}
                      // Unlike a card rendered inline in its own thread, this
                      // one has to hand the reply context ACROSS a route
                      // boundary: the thread page mounts fresh, so ?reply=
                      // is what tells it which card the user is answering.
                      // Href shape owned by card-reply-link so the producer
                      // here and the consumer in threads.$agent cannot drift.
                      onWriteOwn={(decisionId) =>
                        navigate(buildCardReplyHref(item.agentName, decisionId))
                      }
                    />
                  ))}
                </section>
              ) : null}

              {actions.length > 0 ? (
                <section data-testid="cards-section-actions">
                  <h2 className="label-mono mb-2 text-xs uppercase tracking-widest text-muted-foreground">
                    Actions
                  </h2>
                  {actions.map((item) => (
                    <ActionCard
                      key={`${item.agentName}/${item.block.actionCard?.actionId}`}
                      block={item.block}
                      now={now}
                      postAction={`/threads/${item.agentName}`}
                      onOpenDoc={handleOpenDoc}
                    />
                  ))}
                </section>
              ) : null}
            </div>
          )}
        </div>
      </div>

      <ReviewPanel />
    </div>
  );
}

/**
 * Scoped error boundary (lifeline hardening): a failure here renders inside the
 * shell so the sidebar and the rest of MC stay usable.
 */
export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <RouteErrorPanel
      error={error}
      scope="the cards tab"
      hint="An agent inbox file may contain a malformed block - check the latest writes."
    />
  );
}
