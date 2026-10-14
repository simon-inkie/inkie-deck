/**
 * api.review-asset.tsx - Binary image endpoint for relative images in reviewed
 * documents.
 *
 * GET ?path=<absolute-path>
 *
 * Returns image bytes with fixed mime-type, X-Content-Type-Options: nosniff,
 * and Content-Disposition: inline. 404 on any guard failure.
 *
 * Only images (png/jpg/jpeg/gif/webp) are served; .md/.txt files, SVG and
 * everything else are denied by the review.server asset gate.
 *
 * SEAM RULE: imports ONLY from review.server. No node:fs, no env
 * strings directly.
 *
 * ASCII only - no em-dashes.
 */
import type { Route } from "./+types/api.review-asset";
import { readReviewAsset, expandTilde } from "~/lib/review.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path");

  if (!rawPath) {
    return new Response(null, { status: 404 });
  }

  // Expand "~/" server-side.
  const absPath = expandTilde(rawPath);

  try {
    const { bytes, contentType } = readReviewAsset(absPath);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "X-Content-Type-Options": "nosniff",
        "Content-Disposition": "inline",
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch {
    return new Response(null, { status: 404 });
  }
}
