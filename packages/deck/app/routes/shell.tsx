/**
 * shell.tsx - the layout route wrapping every page in the two-pane AppShell.
 *
 * Loader builds the sidebar view-model: one entry per agent (preview +
 * needs-you flag) plus a total needs-you count for the top-bar bell. Reads
 * through the seam (makeStores -> inbox.listAgents + readBlocks).
 *
 * SEAM RULE (FND-02): every read goes through a .server module (makeStores,
 * listCards, avatarUrl, readActivity). No direct fs imports here, no literal
 * inbox or activity path - the Sidebar and AppShell get a finished view-model.
 *
 * The nested index (home) and thread routes render into AppShell's <Outlet/>;
 * they keep their own loaders/actions untouched.
 * ASCII only - no em-dashes (FND-05).
 */
import type { Route } from "./+types/shell";
import { makeStores } from "~/lib/stores.server";
import { deriveNeedsYou, type InboxEntry } from "~/lib/queue-derive";
import { listCards } from "~/lib/projects.server";
import { toMiniCards, type MiniCard } from "~/lib/projects.shared";
import { avatarUrl } from "~/lib/avatars.server";
import { resolveNow } from "~/lib/time";
import { mcUser, tmuxEnabled, instanceLabel, filterCardsForInstance, modelSelectorEnabled, cronAdminEnabled, activityEnabled } from "~/lib/instance.server";
import { getAgentModelInfo } from "~/lib/agent-model.server";
import { readActivity, resolveEscalationThresholdMs } from "~/lib/activity.server";
import { escalatedAgents, type ActivityStatus, type EscalatedAgent } from "~/lib/activity.shared";
import { loadCodexQuotaDisplay } from "~/lib/codex-quota-display.server";
import { AppShell } from "~/components/AppShell";
import type { SidebarAgent } from "~/components/Sidebar";
import type { NeedsItem } from "~/components/AppShell";
import type { ModelSelectorData } from "~/components/ModelSelector";

/**
 * Per-agent activity status for the sidebar pills (TASK-691 follow-up 3).
 *
 * GATED, and LIVE-ONLY. Two separate refusals, both deliberate:
 *   - `activityEnabled` first, so an instance that was never given an activity
 *     root to read (Robin's) does no fs work at all here and renders a sidebar
 *     identical to the one it rendered before this feature existed. The route
 *     never learns the path shape - seam rule, same as every other root.
 *   - a non-live read returns nothing rather than a stale pill. The Activity
 *     panel can afford to show last-known state because it has a banner, a
 *     timestamp and a dimmed grid to say so; a lone pill in a 200px column has
 *     nowhere to carry "as of 40 minutes ago", and a status pill is a claim
 *     about now. No evidence, no pill.
 *
 * The read is the same small JSON file the Activity route reads, on the same
 * AppShell revalidation poll (3s off that route), and it is skipped entirely
 * when the gate is off. See loadActivity in routes/tmux.tsx for the cost note.
 *
 * ONE read serves BOTH the sidebar pills and the top-bar escalation alert
 * (top-bar escalation SPEC, "Loader wiring") - `escalated` is derived from
 * the same `readActivity` call below, not a second file read.
 */
function sidebarStatuses(now: Date): {
  statuses: Map<string, ActivityStatus>;
  escalated: EscalatedAgent[];
} {
  if (!activityEnabled(process.env)) return { statuses: new Map(), escalated: [] };
  const view = readActivity(process.env, now);
  if (view.state !== "live") return { statuses: new Map(), escalated: [] };
  return {
    statuses: new Map(view.agents.map((a) => [a.agent, a.status])),
    // Live-only, same posture as the statuses map above: the escalation alert
    // is a claim about NOW, so an offline engine (last-known state) escalates
    // nothing rather than firing off potentially-stale data.
    escalated: escalatedAgents(view.agents, now, resolveEscalationThresholdMs(process.env)),
  };
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const { inbox, queue } = makeStores(process.env);
  // resolveNow: a garbage MC_NOW degrades to wall clock instead of an Invalid
  // Date that throws downstream (2026-06-11 lifeline hardening).
  const now = resolveNow(process.env["MC_NOW"]);
  // TASK-462: per-instance user - which participant files this world reads.
  const user = mcUser(process.env);

  const agentNames = await inbox.listAgents();

  // COUNT SEMANTICS (peer review, Atlas TASK-438): the bell consumes the SAME
  // deriveNeedsYou output as the home list - the badge count IS the list
  // length. No independent counting path lives here any more.
  // Load the queue-store handled set BEFORE building the sidebar so the
  // per-agent unhandled-card dot can respect it (2026-06-12 stuck-dot fix):
  // a card swept via the bell's "handled" set must clear the sidebar dot
  // too, or the two surfaces disagree and the dot looks stuck.
  const [handledIds, deadlineMap] = await Promise.all([
    queue.getHandled(),
    queue.getDeadlines(),
  ]);

  // The active thread's view (chat | tmux) gates the unread-dot suppression
  // below: only chat view fires markRead, so only chat view clears the dot.
  const activeView = new URL(request.url).searchParams.get("view");

  // One read for the whole sidebar, joined per agent by name below - and for
  // the top-bar escalation alert (see sidebarStatuses' doc comment).
  const { statuses, escalated } = sidebarStatuses(now);

  const allEntries: InboxEntry[] = [];
  const agents: SidebarAgent[] = await Promise.all(
    agentNames.map(async (name) => {
      const blocks = await inbox.readBlocks(name, user);
      const last = blocks.length > 0 ? blocks[blocks.length - 1] : null;

      const rawPreview = last ? last.body.replace(/\n/g, " ").trim() : "";
      const preview =
        rawPreview.length > 64
          ? rawPreview.slice(0, 64) + "..."
          : rawPreview || "(no messages)";

      const lastTimestamp = last
        ? last.header.timestamp
        : now.toISOString();

      for (const block of blocks) {
        allEntries.push({ agentName: name, block });
      }

      // An unhandled card is an unanswered decision OR an un-done,
      // un-dismissed action that has NOT been swept into the queue-store
      // handled set. The id format mirrors deriveItemId so the sweep and
      // the dot agree (2026-06-12: previously the dot ignored handledIds,
      // so cards cleared from the bell kept the sidebar dot lit forever).
      const hasUnhandled = blocks.some((b) => {
        if (b.card !== undefined && b.card.answered === undefined) {
          return !handledIds.has(`${name}/${b.header.timestamp}/${b.card.decisionId}`);
        }
        if (
          b.actionCard !== undefined &&
          b.actionCard.done === undefined &&
          b.actionCard.dismissed === undefined
        ) {
          return !handledIds.has(`${name}/${b.header.timestamp}/${b.actionCard.actionId}`);
        }
        return false;
      });

      // TASK-437 amendment (Atlas complement): unread MESSAGES - drives the
      // dot on the chat half of the thread view toggle. The tmux-view
      // markRead skip keeps these honest, so the toggle carries the signal
      // the held-back receipt creates.
      // The active thread suppresses its unread dot ONLY in CHAT view: there
      // the thread loader's markRead is flipping its blocks to read in
      // parallel, so forcing it false kills the ~3s lag where the magenta dot
      // lingered after opening a thread (2026-06-12 Alex report).
      // In TMUX view markRead is deliberately held back (receipt honesty), so
      // the active thread MUST keep signalling unread - the chat-toggle dot is
      // exactly that signal (regression caught 2026-06-12).
      const isActiveChatThread =
        name === params.agent && activeView !== "tmux";
      const hasUnread =
        !isActiveChatThread &&
        blocks.some(
          (b) => b.header.from !== user && b.header.status === "sent"
        );

      // TASK-457: real avatar when the agent has one; initials fallback.
      // hasUnread -> magenta message dot; hasUnhandled -> burnt-orange
      // decision dot. Both can show at once (2026-06-12).
      // status -> the activity pill at the end of the row; undefined for an
      // agent the sweep
      // did not cover, and for every agent when the gate is off or the engine
      // is not live (see sidebarStatuses).
      return {
        name,
        preview,
        lastTimestamp,
        hasUnhandled,
        hasUnread,
        avatarUrl: avatarUrl(name),
        status: statuses.get(name),
      };
    })
  );

  // Blocked kanban cards join the bell exactly as they join home; projects
  // root may be unset - degrade gracefully (same guard as home.tsx).
  let blockedCards: Awaited<ReturnType<typeof listCards>> = [];
  try {
    // TASK-462: scoped to this instance's agents (no-op on Alex's).
    blockedCards = filterCardsForInstance(listCards(), process.env);
  } catch {
    // Projects root not configured - blocked kind contributes nothing.
  }

  // Read-only consumption: home.tsx owns persisting first-seen deadline
  // anchors; the bell never writes.
  const { items } = deriveNeedsYou(
    allEntries,
    blockedCards,
    handledIds,
    deadlineMap,
    now,
    user
  );

  const needsItems: NeedsItem[] = items.map((item) => ({
    id: item.id,
    kind: item.kind,
    agent: item.agentName,
    subject: item.title,
    createdAt: item.createdAt,
    overdue: item.overdue,
    deepLink: item.deepLink,
  }));

  // TASK-454: the active thread agent's live cards feed the top-bar work-panel
  // trigger + slide-out. As a layout route this loader receives child params,
  // so params.agent is set exactly when a thread is open. Reuses the SAME
  // guarded listCards() result the bell already consumes.
  const workCards: MiniCard[] =
    params.agent !== undefined
      ? toMiniCards(blockedCards, params.agent, now)
      : [];

  // M5: the active thread agent's configured model + catalog options for the
  // top-bar selector. OPERATOR-ONLY (modelSelectorEnabled - absent on
  // Robin's instance by construction) and only for agents whose runtime has
  // catalog options (codex/agy v1 have none, so no control renders). Reads
  // degrade to an empty option list - a broken AGENTS_ROOT means no chip,
  // never a 500.
  let modelSelector: ModelSelectorData | undefined;
  if (params.agent !== undefined && modelSelectorEnabled(process.env)) {
    const info = getAgentModelInfo(process.env, params.agent);
    if (info.options.length > 0) {
      modelSelector = {
        agent: params.agent,
        model: info.model,
        options: info.options,
      };
    }
  }

  // Ticket 3: one read-only quota view for the shared Plus account plus
  // explicit per-agent provider records. Provider is never inferred from the
  // quota snapshot. Missing or malformed provider records become `unknown`.
  const codexQuota = loadCodexQuotaDisplay(
    process.env,
    now.getTime(),
    agentNames
  );

  return { agents, needsItems, needsCount: needsItems.length, workCards, user, tmuxOn: tmuxEnabled(process.env), instanceLabel: instanceLabel(process.env), modelSelector, cronAdminOn: cronAdminEnabled(process.env), activityNavOn: activityEnabled(process.env), escalated, codexQuota };
}

export default function Shell({ loaderData }: Route.ComponentProps) {
  const { agents, needsItems, needsCount, workCards, tmuxOn, instanceLabel, modelSelector, cronAdminOn, activityNavOn, escalated, codexQuota } = loaderData;
  return (
    <AppShell
      agents={agents}
      needsItems={needsItems}
      needsCount={needsCount}
      workCards={workCards}
      tmuxOn={tmuxOn}
      instanceLabel={instanceLabel}
      modelSelector={modelSelector}
      cronAdminOn={cronAdminOn}
      activityNavOn={activityNavOn}
      escalated={escalated}
      codexQuota={codexQuota}
    />
  );
}
