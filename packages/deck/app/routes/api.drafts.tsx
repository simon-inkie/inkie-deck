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
import { resolveAllowedOrigins } from "../../server/voice-relay.mjs";
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
 * Refuse a browser-initiated write from an origin Deck does not expect. Deck
 * has no authentication, so a page on another origin that the person's browser
 * can use to reach this server could otherwise POST (even with force=1) and
 * overwrite a draft by name.
 *
 * The Origin header is checked against an ALLOWLIST (the same mechanism and
 * env var as the voice proxy: VOICE_ALLOWED_ORIGINS, default
 * http://localhost:$PORT plus the dev port), not against the Host header.
 * Comparing against Host is defeated by DNS rebinding, where the attacker
 * controls both. Browsers always send Origin on POSTs, so a browser request
 * with a missing-from-list or "null" Origin is refused; so is any
 * Sec-Fetch-Site other than same-origin or none. Requests with neither header
 * (an agent using curl) are not browser cross-site requests and pass.
 *
 * Reaching Deck by another name (a tailnet host, a Host-rewriting proxy)
 * requires listing that origin in VOICE_ALLOWED_ORIGINS, exactly as for voice.
 */
function crossOriginWrite(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin" && site !== "none") return true;
  const origin = request.headers.get("origin");
  if (origin === null) return false;
  return !resolveAllowedOrigins(process.env).includes(origin);
}

export async function action({ request }: Route.ActionArgs) {
  if (crossOriginWrite(request)) {
    return json({ ok: false, error: "Cross-origin writes are not allowed. If you reach Deck by another name, list that origin in VOICE_ALLOWED_ORIGINS." }, 403);
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
