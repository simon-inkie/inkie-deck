/**
 * One-off sweep (Alex, 2026-06-11 22:11): mark every needs-you item older
 * than 36h as handled in the queue store. Decisions were resolved out-of-band;
 * the bell was choking on them. Uses the same FileQueueStore the daemon uses
 * (atomic write; worst-case race = an item reappearing, by design).
 * Usage: INBOX_ROOT=... DATA_ROOT=... PROJECTS_ROOT=... pnpm tsx scripts/sweep-stale-needs-you.ts
 */
import { makeStores } from "../app/lib/stores.server.js";
import { listCards } from "../app/lib/projects.server.js";
import { filterCardsForInstance, mcUser } from "../app/lib/instance.server.js";
import { deriveNeedsYou, type InboxEntry } from "../app/lib/queue-derive.js";

const STALE_MS = 36 * 60 * 60 * 1000;
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

let swept = 0;
for (const item of items) {
  const created = new Date(item.createdAt);
  const stale =
    isNaN(created.getTime()) || now.getTime() - created.getTime() > STALE_MS;
  if (stale) {
    await queue.markHandled(item.id);
    swept += 1;
    console.log(`swept: ${item.id} ("${item.title.slice(0, 50)}")`);
  }
}
console.log(`done: swept ${swept} of ${items.length} items (cutoff 36h, now=${now.toISOString()})`);
