/**
 * One-off read-only audit: derive the live needs-you list exactly as the
 * shell loader does, and report which items are older than 36h.
 * Usage: INBOX_ROOT=... DATA_ROOT=... PROJECTS_ROOT=... pnpm tsx scripts/list-stale-needs-you.ts
 */
import { makeStores } from "../app/lib/stores.server.js";
import { listCards } from "../app/lib/projects.server.js";
import { filterCardsForInstance, mcUser } from "../app/lib/instance.server.js";
import { deriveNeedsYou, type InboxEntry } from "../app/lib/queue-derive.js";

const now = new Date();
const user = mcUser(process.env);
const { inbox, queue } = makeStores(process.env);

const agentNames = await inbox.listAgents();
const allEntries: InboxEntry[] = [];
for (const name of agentNames) {
  const blocks = await inbox.readBlocks(name, user);
  for (const block of blocks) allEntries.push({ agentName: name, block });
}

let blockedCards: ReturnType<typeof listCards> = [];
try {
  blockedCards = filterCardsForInstance(listCards(), process.env);
} catch {
  // projects root unset - fine
}

const [handledIds, deadlineMap] = await Promise.all([
  queue.getHandled(),
  queue.getDeadlines(),
]);

const { items } = deriveNeedsYou(allEntries, blockedCards, handledIds, deadlineMap, now, user);

const STALE_MS = 36 * 60 * 60 * 1000;
console.log(`needs-you total: ${items.length} (now=${now.toISOString()}, user=${user})`);
for (const item of items) {
  const created = new Date(item.createdAt);
  const ageH = isNaN(created.getTime()) ? -1 : (now.getTime() - created.getTime()) / 3_600_000;
  const stale = ageH < 0 || ageH * 3_600_000 > STALE_MS;
  console.log(
    `${stale ? "STALE" : "fresh"}  ${ageH.toFixed(1)}h  [${item.kind}]  ${item.id}  "${item.title.slice(0, 60)}"`
  );
}
