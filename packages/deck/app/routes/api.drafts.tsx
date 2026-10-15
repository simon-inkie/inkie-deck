/**
 * api.drafts.tsx - JSON seam for the Deck draft editor (#66).
 *
 * GET                  -> { ok, drafts: [{ name, savedAt, writer }] }
 * GET ?name=<file>.md  -> { ok, draft: { name, content, version, savedAt, writer } }
 * POST intent=create|save, name, content, [baseVersion], [force=1]
 *   -> { ok: true, draft } or { ok: false, error, conflict?, current? } with a
 *      409 on a conflict (the file changed outside the editor).
 *
 * SEAM RULE: imports only drafts.server; no fs in the route.
 * ASCII only - no em-dashes.
 */
import type { Route } from "./+types/api.drafts";
import {
  draftsEnabled,
  listDrafts,
  readDraft,
  saveDraft,
} from "~/lib/drafts.server";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function loader({ request }: Route.LoaderArgs) {
  if (!draftsEnabled(process.env)) {
    return json({ ok: false, error: "Drafts are not configured." }, 404);
  }
  const name = new URL(request.url).searchParams.get("name");
  if (name === null) {
    try {
      return json({ ok: true, drafts: listDrafts() });
    } catch {
      return json({ ok: false, error: "Drafts folder is not available." }, 500);
    }
  }
  const res = readDraft(name);
  return res.ok ? json(res) : json(res, res.status);
}

/**
 * Refuse a browser-initiated cross-origin write. Deck has no authentication,
 * so a page on another origin that the person's browser can use to reach this
 * server could otherwise POST (even with force=1) and overwrite a draft by
 * name. Browsers always send Origin on cross-origin POSTs and Sec-Fetch-Site
 * on modern ones; requests with neither (an agent using curl) are not browser
 * cross-site requests and pass. Behind a proxy that rewrites Host, same-origin
 * saves would be refused: keep the Host header intact.
 */
function crossOriginWrite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (origin) {
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return true;
    }
    const host = request.headers.get("host") ?? new URL(request.url).host;
    if (originHost !== host) return true;
  }
  return false;
}

export async function action({ request }: Route.ActionArgs) {
  if (crossOriginWrite(request)) {
    return json({ ok: false, error: "Cross-origin writes are not allowed." }, 403);
  }
  if (!draftsEnabled(process.env)) {
    return json({ ok: false, error: "Drafts are not configured." }, 404);
  }
  const form = await request.formData();
  const intent = form.get("intent");
  const name = form.get("name");
  const content = form.get("content");
  if (intent !== "create" && intent !== "save") {
    return json({ ok: false, error: "unknown intent" }, 400);
  }
  if (typeof name !== "string" || typeof content !== "string") {
    return json({ ok: false, error: "name and content required" }, 400);
  }
  const base = form.get("baseVersion");
  const res = await saveDraft({
    name,
    content,
    create: intent === "create",
    baseVersion: typeof base === "string" && base ? base : null,
    force: form.get("force") === "1",
  });
  return res.ok ? json(res) : json(res, res.status);
}
