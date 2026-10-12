/**
 * api.thread-window.tsx - JSON endpoint for the thread view's load-older
 * pagination.
 *
 * GET ?agent=<name>&before=<absolute-index>[&limit=<n>]
 *
 * Returns { ok: true, blocks, startIndex, totalCount, avatarUrls } - the
 * chunk of blocks ending just before the cursor, plus avatar URLs for the
 * senders appearing in the chunk (the thread loader only sees the live
 * window's senders now, so each chunk carries its own avatar map).
 *
 * Called via plain fetch() from ThreadView - deliberately NOT a useFetcher
 * load, which would participate in the 3s revalidation cycle and re-run the
 * chunk query on every poll.
 *
 * No markRead here: pagination is a read, not a thread-open receipt. The
 * whole-file sent->read flip stays in the threads.$agent loader.
 *
 * Security: `agent` arrives as a QUERY param (the path-param route shape
 * cannot carry separators; a query string can), so it is validated against
 * the ROSTER name convention before any read. The participant is ALWAYS
 * mcUser(env) - the client never picks whose file is read.
 *
 * SEAM RULE: imports makeStores + server modules only. No node:fs,
 * no literal inbox paths.
 *
 * ASCII only - no em-dashes.
 */
import type { Route } from "./+types/api.thread-window";
import { makeStores } from "~/lib/stores.server";
import { mcUser } from "~/lib/instance.server";
import { avatarUrl, AGENT_NAME_RE } from "~/lib/avatars.server";
import { DEFAULT_WINDOW_LIMIT } from "~/lib/inbox.server";
import { linkifyBlockBodies } from "~/lib/review.server";

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  const beforeRaw = url.searchParams.get("before");
  const limitRaw = url.searchParams.get("limit");

  if (!agent || !AGENT_NAME_RE.test(agent)) {
    return json({ ok: false, error: "valid agent param required" }, 400);
  }

  const before = beforeRaw === null ? NaN : Number(beforeRaw);
  if (!Number.isInteger(before) || before < 0) {
    return json({ ok: false, error: "before param must be a non-negative integer" }, 400);
  }

  const limit = limitRaw === null ? DEFAULT_WINDOW_LIMIT : Number(limitRaw);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
    return json({ ok: false, error: "limit param must be an integer in 1..200" }, 400);
  }

  const { inbox } = makeStores(process.env);
  const user = mcUser(process.env);

  const window = await inbox.readBlocksWindow(agent, user, { before, limit });

  // Same render-time auto-linkify as the thread loader, applied to the
  // lazily loaded older chunk (this is what makes the fix retroactive for
  // history scrolled far back beyond the initial window). Never throws.
  const blocks = linkifyBlockBodies(window.blocks);

  // Avatar URLs for distinct senders in THIS chunk (same shape as the thread
  // loader's map; the client merges).
  const avatarUrls: Record<string, string> = {};
  for (const b of blocks) {
    const from = b.header.from;
    if (from === user || from in avatarUrls) continue;
    const u = avatarUrl(from);
    if (u !== undefined) avatarUrls[from] = u;
  }

  return json(
    {
      ok: true,
      agent,
      blocks,
      startIndex: window.startIndex,
      totalCount: window.totalCount,
      avatarUrls,
    },
    200
  );
}
