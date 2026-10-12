/**
 * attachments.$.tsx - Resource route for serving stored attachment files.
 *
 * GET only (loader). Decodes the splat parameter, rejects any traversal-shaped
 * input early, then delegates to readAttachment() from the server module.
 * Returns the file bytes with the correct content-type, X-Content-Type-Options:
 * nosniff, and Content-Disposition based on the policy (inline for images,
 * attachment for everything else).
 *
 * 404 on ANY guard failure - no information leak about the reason.
 *
 * SEAM RULE: this file imports ONLY from the .server module.
 * It does NOT import node:fs, node:path, or any env var string directly.
 * The seam.test.ts ban-list covers this route (same discipline as the inbox seam).
 *
 * ASCII only - no em-dashes.
 */
import type { Route } from "./+types/attachments.$";
import { readAttachment } from "~/lib/attachments.server";

export async function loader({ params }: Route.LoaderArgs) {
  const splat: string = (params as Record<string, string>)["*"] ?? "";

  // Early rejection of traversal-shaped inputs before any fs call.
  // Reject: empty, absolute paths, ../ sequences, encoded variants.
  if (
    !splat ||
    splat.startsWith("/") ||
    splat.includes("..") ||
    splat.includes("%2e") ||
    splat.includes("%2E") ||
    splat.includes("%2f") ||
    splat.includes("%2F") ||
    splat.includes("%5c") ||
    splat.includes("%5C") ||
    splat.includes("\0")
  ) {
    return new Response(null, { status: 404 });
  }

  // Constrain served paths to the
  // documented convention shape <agent>/mc/<filename> (single agent segment,
  // fixed mc segment, single filename segment). The route's authority matches
  // the convention, not the whole root tree.
  if (!/^[a-z0-9][a-z0-9-]*\/mc\/[^/]+$/.test(splat)) {
    return new Response(null, { status: 404 });
  }

  try {
    const { bytes, contentType, disposition } = readAttachment(splat);
    const headers = new Headers({
      "Content-Type": contentType,
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition":
        disposition === "inline"
          ? "inline"
          : // Strip quotes/control chars from the filename so a hostile stored
            // name cannot inject header content.
            `attachment; filename="${(splat.split("/").pop() ?? "file").replace(/["\\\x00-\x1f]/g, "")}"`,
      "Cache-Control": "private, max-age=3600",
    });
    // Convert Buffer to Uint8Array for Response compatibility.
    return new Response(new Uint8Array(bytes), { status: 200, headers });
  } catch {
    return new Response(null, { status: 404 });
  }
}
