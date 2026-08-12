/**
 * push-watcher.mjs - the TASK-470 trigger seam. Spawned by
 * start-production.mjs as a sibling of the voice proxy.
 *
 * POLLS the instance user's thread files (INBOX_ROOT/<agent>/inbox/<user>.md)
 * every PUSH_POLL_MS (default 4000ms) - polling, not fs.watch, because WSL
 * inotify is degraded (Quill, TASK-470 brief). On new blocks from a non-user
 * sender it web-pushes every stored subscription. That is the WHOLE rule:
 * push every inbound message; curation lives upstream in team discipline
 * (Alex's decided trigger, 2026-06-11).
 *
 * Reads (no TS imports - this is a plain node process):
 *   - DATA_ROOT/vapid-keys.json        (self-provisioned by the app on the
 *     first /api/push-subscribe hit; until it exists there are no
 *     subscriptions either, so the watcher just idles)
 *   - DATA_ROOT/push-subscriptions.json (shared shape with push.server.ts -
 *     keep the two in sync if it ever changes)
 *
 * Lifecycle rules:
 *   - Baseline at boot = current block counts. NO pushes for history.
 *   - File shrank -> re-baseline silently (rewrite/rotation, never spam).
 *   - 404/410 from the push service -> drop that subscription (expired).
 *   - EVERY cycle is wrapped: a watcher error logs and skips the cycle.
 *     This process must never take anything else down; if it dies, the
 *     launcher logs the exit and the daemon lives on (degrade, not drag).
 *
 * ASCII only - no em-dashes (FND-05).
 */
import fs from "node:fs";
import path from "node:path";
import webpush from "web-push";
import { parseBlocks, newBlockPayloads } from "./push-watch-core.mjs";

const INBOX_ROOT = process.env["INBOX_ROOT"];
const DATA_ROOT = process.env["DATA_ROOT"];
const USER = process.env["MC_USER"] || "alex";
const POLL_MS = Number(process.env["PUSH_POLL_MS"] || 4000);

if (!INBOX_ROOT || !DATA_ROOT) {
  console.error("[push-watcher] FATAL: INBOX_ROOT and DATA_ROOT are required.");
  process.exit(1);
}

console.log(
  `[push-watcher] watching ${INBOX_ROOT}/*/inbox/${USER}.md every ${POLL_MS}ms`
);

// --- Stores (read-only-ish; subscription removal is the one write) ---------

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function vapidKeys() {
  const parsed = readJson(path.join(DATA_ROOT, "vapid-keys.json"));
  if (parsed && typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
    return parsed;
  }
  return null;
}

function subscriptions() {
  const parsed = readJson(path.join(DATA_ROOT, "push-subscriptions.json"));
  if (parsed && parsed.version === 1 && Array.isArray(parsed.subscriptions)) {
    return parsed.subscriptions;
  }
  return [];
}

function dropSubscription(endpoint) {
  const file = path.join(DATA_ROOT, "push-subscriptions.json");
  const parsed = readJson(file);
  if (!parsed || !Array.isArray(parsed.subscriptions)) return;
  parsed.subscriptions = parsed.subscriptions.filter(
    (s) => s.endpoint !== endpoint
  );
  const tmp = `${file}.watcher-tmp`;
  fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + "\n");
  fs.renameSync(tmp, file);
  console.log(`[push-watcher] dropped expired subscription ${endpoint.slice(0, 60)}...`);
}

// --- Thread discovery + per-file state --------------------------------------

function threadFiles() {
  const files = [];
  let agents = [];
  try {
    agents = fs.readdirSync(INBOX_ROOT, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of agents) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
    const file = path.join(INBOX_ROOT, entry.name, "inbox", `${USER}.md`);
    if (fs.existsSync(file)) files.push({ agentName: entry.name, file });
  }
  return files;
}

/** file path -> { size, blockCount } */
const seen = new Map();

function baseline() {
  for (const { file } of threadFiles()) {
    try {
      const content = fs.readFileSync(file, "utf8");
      seen.set(file, {
        size: fs.statSync(file).size,
        blockCount: parseBlocks(content).length,
      });
    } catch {
      // Unreadable now - it gets picked up on a later cycle.
    }
  }
  console.log(`[push-watcher] baselined ${seen.size} thread files (no pushes for history)`);
}

// --- Delivery ----------------------------------------------------------------

async function deliver(payloads) {
  if (payloads.length === 0) return;
  const keys = vapidKeys();
  if (!keys) return; // No keypair yet -> nobody has ever subscribed.
  const subs = subscriptions();
  if (subs.length === 0) return;
  webpush.setVapidDetails("mailto:someone@example.com", keys.publicKey, keys.privateKey);
  for (const payload of payloads) {
    const body = JSON.stringify(payload);
    for (const sub of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: sub.keys },
          body
        );
      } catch (err) {
        const status = err && typeof err.statusCode === "number" ? err.statusCode : 0;
        if (status === 404 || status === 410) {
          dropSubscription(sub.endpoint);
        } else {
          console.error(
            `[push-watcher] send failed (${status || err?.message || "unknown"}) for ${sub.endpoint.slice(0, 60)}...`
          );
        }
      }
    }
    console.log(`[push-watcher] pushed: ${payload.title}: ${payload.body.slice(0, 60)}`);
  }
}

// --- The loop ------------------------------------------------------------------

async function cycle() {
  for (const { agentName, file } of threadFiles()) {
    let stat;
    try {
      stat = fs.statSync(file);
    } catch {
      continue;
    }
    const prev = seen.get(file);
    if (!prev) {
      // New thread appearing mid-run: baseline it WITHOUT pushing history.
      try {
        seen.set(file, {
          size: stat.size,
          blockCount: parseBlocks(fs.readFileSync(file, "utf8")).length,
        });
      } catch {
        // Pick it up next cycle.
      }
      continue;
    }
    if (stat.size === prev.size) continue; // No change - the cheap common case.

    let content;
    try {
      content = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const blocks = parseBlocks(content);
    const payloads = newBlockPayloads(blocks, prev.blockCount, USER, agentName);
    seen.set(file, { size: stat.size, blockCount: blocks.length });
    await deliver(payloads);
  }
}

baseline();
setInterval(() => {
  cycle().catch((err) => {
    console.error("[push-watcher] cycle error (skipping):", err?.message || err);
  });
}, POLL_MS);
