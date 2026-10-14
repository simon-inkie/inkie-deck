/**
 * api.file-pins.tsx - pin/unpin seam for the thread Files panel (SPEC 2 + D).
 *
 * POST { intent: "toggle", agent, path }
 *   Toggles a pin for (agent thread, instance user). Returns the resulting
 *   ordered pin list + whether the file is now pinned. Persisted per thread
 *   via the FilePinsStore seam, author-agnostic (each instance has its own
 *   user + its own state directory).
 *
 * SEAM RULE: imports the .server pins store + instance only.
 *
 * ASCII only - no em-dashes.
 */

import type { Route } from "./+types/api.file-pins";
import { mcUser } from "~/lib/instance.server";
import { makeFilePinsStore } from "~/lib/file-pins.server";

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
    },
  });
}

export async function action({ request }: Route.ActionArgs) {
  const form = await request.formData();
  const intent = form.get("intent");
  const agent = form.get("agent");
  const filePath = form.get("path");

  if (intent !== "toggle") return json({ ok: false, error: "unknown intent" }, 400);
  if (typeof agent !== "string" || !agent) {
    return json({ ok: false, error: "agent required" }, 400);
  }
  if (typeof filePath !== "string" || !filePath) {
    return json({ ok: false, error: "path required" }, 400);
  }

  const user = mcUser(process.env);
  const { pins, pinned } = makeFilePinsStore().togglePin(agent, user, filePath);

  return json({ ok: true, agent, path: filePath, pinned, pins });
}
