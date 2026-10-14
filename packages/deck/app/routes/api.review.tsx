/**
 * api.review.tsx - JSON endpoint for the review side-panel.
 *
 * GET ?path=<absolute-or-tilde-path>
 *
 * Returns { ok: true, path, content, kind, lang } on success, or 404 on any
 * guard failure. kind: "markdown" | "code" tells the client which renderer to
 * use. lang is a highlight.js language id (code files only; "plaintext" fallback).
 * The server-side review.server module owns tilde-expansion and all security gates.
 *
 * SEAM RULE: imports ONLY from review.server. No node:fs, no env
 * strings directly in the route (all env handling is inside the server module).
 *
 * ASCII only - no em-dashes.
 */
import type { Route } from "./+types/api.review";
import { readReviewFile, expandTilde } from "~/lib/review.server";

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const rawPath = url.searchParams.get("path");

  if (!rawPath) {
    return new Response(JSON.stringify({ ok: false, error: "path param required" }), {
      status: 404,
      headers: { "Content-Type": "application/json" },
    });
  }

  // Expand "~/" server-side so the client never needs to know the home dir.
  const absPath = expandTilde(rawPath);

  try {
    const { path: resolvedPath, content, kind, lang } = readReviewFile(absPath);
    return new Response(
      JSON.stringify({ ok: true, path: resolvedPath, content, kind, lang }),
      {
        status: 200,
        headers: {
          "Content-Type": "application/json",
          "X-Content-Type-Options": "nosniff",
          "Cache-Control": "private, no-store",
        },
      }
    );
  } catch {
    return new Response(null, { status: 404 });
  }
}
