/**
 * avatars.$agent.tsx - Resource route serving agent avatar files.
 *
 * GET only (loader). Validates the agent param against the ROSTER name
 * convention BEFORE any fs call, then delegates to readAvatar() from the
 * server module (guard chain documented there). 404 on ANY failure - no
 * information leak about the reason (same discipline as attachments.$).
 *
 * Cache: long max-age + immutable is safe because loaders build the URL
 * with ?v=<mtimeMs> - a replaced file is a NEW URL (the convention's
 * mtime cache-bust).
 *
 * SEAM RULE: this file imports ONLY from the .server module.
 * ASCII only - no em-dashes.
 */
import type { Route } from "./+types/avatars.$agent";
import { readAvatar, AGENT_NAME_RE } from "~/lib/avatars.server";

export async function loader({ params }: Route.LoaderArgs) {
  const agent = params.agent ?? "";

  // Early rejection before any fs call - single lowercase segment only.
  if (!AGENT_NAME_RE.test(agent)) {
    return new Response(null, { status: 404 });
  }

  const bytes = readAvatar(agent);
  if (bytes === undefined) {
    return new Response(null, { status: 404 });
  }

  return new Response(new Uint8Array(bytes), {
    status: 200,
    headers: {
      "Content-Type": "image/png",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": "inline",
      "Cache-Control": "public, max-age=31536000, immutable",
    },
  });
}
