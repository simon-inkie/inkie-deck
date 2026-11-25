/**
 * api.flows.tsx - Read-only JSON seam for Deck Flows Slice 1b.
 *
 * GET /api/flows                  -> { ok: true, projects }
 * GET /api/flows?project=P        -> { ok: true, project: P, runs }
 * GET /api/flows?project=P&run=R  -> { ok: true, stream } or 404
 * Any non-GET/HEAD method / action -> 405 Allow: GET
 *
 * SEAM RULE: no fs imports, no env-root literals in the route.
 * ASCII only - no em-dashes.
 */

import type { Route } from "./+types/api.flows";
import {
  FlowIntegrityError,
  InvalidFlowQueryError,
  listFlowProjects,
  listFlowRuns,
  readFlowCardStream,
} from "~/lib/flows/reader.server";

function json(
  body: unknown,
  status = 200,
  extraHeaders?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "private, no-store",
      ...extraHeaders,
    },
  });
}

function methodNotAllowed(): Response {
  return json(
    { ok: false, error: "Flows Slice 1b stream is strictly read-only." },
    405,
    { Allow: "GET" },
  );
}

export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  const url = new URL(request.url);
  const project = url.searchParams.get("project");
  const run = url.searchParams.get("run");

  try {
    if (project === null && run === null) {
      const projects = listFlowProjects();
      return json({ ok: true, projects });
    }

    if (project === null) {
      return json({ ok: false, error: "Invalid flow project or run id." }, 400);
    }

    if (run === null) {
      const runs = listFlowRuns(project);
      return json({ ok: true, project, runs });
    }

    const stream = readFlowCardStream(project, run);
    if (!stream) {
      return json({ ok: false, error: "Flow run not found." }, 404);
    }
    return json({ ok: true, stream });
  } catch (err) {
    if (err instanceof InvalidFlowQueryError) {
      return json({ ok: false, error: "Invalid flow project or run id." }, 400);
    }
    if (err instanceof FlowIntegrityError) {
      return json(
        { ok: false, error: "Flow ledger failed integrity verification." },
        422,
      );
    }
    return json({ ok: false, error: "Could not read flow stream." }, 500);
  }
}

export async function action() {
  return methodNotAllowed();
}
