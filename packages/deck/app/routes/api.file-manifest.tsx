/**
 * api.file-manifest.tsx - data + description seam for the thread Files panel.
 *
 * GET ?agent=<agent>
 *   Returns the thread's file manifest (distinct file refs, newest-first),
 *   the participant's pins for this thread, and any CACHED descriptions. No
 *   gemini call happens here - descriptions are generated lazily via POST so
 *   opening the panel never blocks on the model (SPEC Q3 "lazy + cache").
 *
 * POST { intent: "describe", agent, path }
 *   Generates (or returns the cached) gemini-3.5-flash-lite description for one
 *   file reference. One call per reference; cached + spend-logged in the server
 *   module. The client fires these one-per-uncached-row after the GET.
 *
 * SEAM RULE: imports makeStores + the .server description/manifest
 * modules only. No node:fs, no literal paths.
 *
 * ASCII only - no em-dashes.
 */

import type { Route } from "./+types/api.file-manifest";
import { makeStores } from "~/lib/stores.server";
import { mcUser } from "~/lib/instance.server";
import { makeFilePinsStore } from "~/lib/file-pins.server";
import type { FileReference } from "~/lib/file-manifest";
import { getManifestRefs } from "~/lib/file-manifest-cache.server";
import {
  generateDescription,
  getCachedDescription,
} from "~/lib/file-description.server";

/** Public row shape sent to the client (no surrounding-window leak). */
interface ManifestRow {
  path: string;
  name: string;
  ext: string;
  linkText: string;
  firstSeenTimestamp: string;
  lastSeenTimestamp: string;
  description: string | null;
}

function toRow(ref: FileReference, description: string | null): ManifestRow {
  return {
    path: ref.path,
    name: ref.name,
    ext: ref.ext,
    linkText: ref.linkText,
    firstSeenTimestamp: ref.firstSeenTimestamp,
    lastSeenTimestamp: ref.lastSeenTimestamp,
    description,
  };
}

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
  const url = new URL(request.url);
  const agent = url.searchParams.get("agent");
  if (!agent) return json({ ok: false, error: "agent param required" }, 400);

  const user = mcUser(process.env);
  const { inbox } = makeStores(process.env);

  // Route-layer cache: skips the whole-thread read+parse when the inbox file is
  // unchanged since the last panel open (see file-manifest-cache.server.ts).
  const refs: FileReference[] = await getManifestRefs(inbox, agent, user);

  // Cached descriptions only (no gemini call on GET).
  const rows: ManifestRow[] = refs.map((ref) =>
    toRow(ref, getCachedDescription(ref) ?? null)
  );

  const pins = makeFilePinsStore().getPins(agent, user);

  return json({ ok: true, agent, rows, pins });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  const agent = form.get("agent");
  const filePath = form.get("path");

  if (intent !== "describe") return json({ ok: false, error: "unknown intent" }, 400);
  if (typeof agent !== "string" || !agent) {
    return json({ ok: false, error: "agent required" }, 400);
  }
  if (typeof filePath !== "string" || !filePath) {
    return json({ ok: false, error: "path required" }, 400);
  }

  const user = mcUser(process.env);
  const { inbox } = makeStores(process.env);

  // Re-derive the manifest to get the surrounding-window for THIS file (the
  // window is server-only - never sent to the client - so the description gen
  // recomputes it here rather than trusting a client-supplied window). Served
  // from the same route-layer cache as the loader, so a describe storm across
  // visible rows no longer re-parses the whole thread per row.
  const refs: FileReference[] = await getManifestRefs(inbox, agent, user);
  const ref = refs.find((r) => r.path === filePath);
  if (!ref) {
    return json({ ok: false, error: "file not referenced in thread" }, 404);
  }

  const result = await generateDescription(ref, {
    threadAgent: agent,
    participant: user,
  });

  return json({
    ok: true,
    path: ref.path,
    description: result.description,
    generated: result.generated,
    cached: result.cached,
  });
}
