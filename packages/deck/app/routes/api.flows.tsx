/**
 * api.flows.tsx - JSON & write-action seam for Deck Flows.
 *
 * GET /api/flows                  -> { ok: true, projects }
 * GET /api/flows?view=library     -> { ok: true, catalog }
 * GET /api/flows?project=P        -> { ok: true, project: P, runs }
 * GET /api/flows?project=P&run=R  -> { ok: true, stream } or 404
 * POST /api/flows                 -> same-origin guarded plan, approve, start, decide, project or import
 * Non-GET/HEAD in loader or non-POST in action -> 405 Allow: GET, POST
 *
 * SEAM RULE: no fs imports, no env-root literals in the route.
 * ASCII only - no em-dashes.
 */

import type { Route } from "./+types/api.flows";
import { FlowNotFoundError, FlowValidationError } from "~/lib/flows/library.server";
import {
  FlowPinMismatchError,
  PathConfinementError,
  SymlinkNotAllowedError,
} from "~/lib/flows/load-run.server";
import { RunnerLockBusyError } from "~/lib/flows/owner.server";
import {
  FlowIntegrityError,
  InvalidFlowQueryError,
  listFlowProjects,
  listFlowRuns,
  readFlowCardStream,
} from "~/lib/flows/reader.server";
import {
  ArtifactVerificationError,
  FlowProjectionError,
  HashChainCorruptionError,
  IllegalFlowTransitionError,
  ImportedFlowReadOnlyError,
  StorePragmaError,
} from "~/lib/flows/store.server";
import {
  approveFlowFromUi,
  decideFlowFromUi,
  FlowDecisionConflictError,
  FlowDuplicateRunError,
  FlowNotApprovedError,
  FlowRunNotFoundError,
  InvalidFlowUiActionError,
  listFlowLaunchCatalog,
  planFlowFromUi,
  startFlowFromUi,
  transferFlowProgress,
} from "~/lib/flows/ui-actions.server";
import { requireSameOriginWrite } from "~/lib/request-origin.server";

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
    { ok: false, error: "Method not allowed." },
    405,
    { Allow: "GET, POST" },
  );
}

function mapErrorResponse(err: unknown, fallbackMessage: string): Response {
  if (err instanceof FlowProjectionError) {
    return json({ ok: false, error: err.message, rejectedLines: err.rejectedLines }, 422);
  }
  if (err instanceof ImportedFlowReadOnlyError) {
    return json({ ok: false, error: err.message }, 409);
  }
  if (err instanceof InvalidFlowQueryError) {
    return json({ ok: false, error: "Invalid flow project or run id." }, 400);
  }
  if (err instanceof InvalidFlowUiActionError) {
    return json({ ok: false, error: err.message }, 400);
  }
  if (err instanceof FlowValidationError) {
    return json(
      {
        ok: false,
        error: "Flow YAML validation failed.",
        details: err.errors.map((e) => ({
          path: e.path,
          code: e.code,
          message: e.message,
        })),
      },
      400,
    );
  }
  if (err instanceof FlowNotApprovedError) {
    return json(
      { ok: false, error: "Flow run must be approved before starting." },
      409,
    );
  }
  if (err instanceof FlowDuplicateRunError) {
    return json({ ok: false, error: "Flow run already exists." }, 409);
  }
  if (err instanceof FlowDecisionConflictError) {
    return json({ ok: false, error: "The decision is no longer open or the choice is invalid." }, 409);
  }
  if (err instanceof RunnerLockBusyError) {
    return json(
      { ok: false, error: "Project flow execution is currently locked by another runner." },
      409,
    );
  }
  if (err instanceof IllegalFlowTransitionError) {
    let error = "Flow transition conflict.";
    if (err.message.includes("already approved")) {
      error = "Flow run is already approved.";
    } else if (err.message.includes("does not match pinned flow_hash")) {
      error = "Flow hash does not match the planned run.";
    } else if (err.message.includes("must be in 'planned' status")) {
      error = "Flow run is not in planned status.";
    }
    return json({ ok: false, error }, 409);
  }
  if (err instanceof FlowRunNotFoundError) {
    return json({ ok: false, error: "Flow run not found." }, 404);
  }
  if (err instanceof FlowNotFoundError) {
    return json({ ok: false, error: "Flow definition not found." }, 404);
  }
  if (
    err instanceof FlowIntegrityError ||
    err instanceof HashChainCorruptionError ||
    err instanceof FlowPinMismatchError ||
    err instanceof StorePragmaError ||
    err instanceof SymlinkNotAllowedError ||
    err instanceof PathConfinementError ||
    err instanceof ArtifactVerificationError
  ) {
    return json(
      { ok: false, error: "Flow ledger failed integrity verification." },
      422,
    );
  }
  return json({ ok: false, error: fallbackMessage }, 500);
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function optionalRawString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return value.trim().length > 0 ? value : undefined;
}

async function readActionBody(request: Request): Promise<Record<string, unknown> | null> {
  const contentType = request.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("application/json")) {
    const parsed = await request.json().catch(() => null);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    return parsed as Record<string, unknown>;
  }
  if (
    contentType.includes("multipart/form-data") ||
    contentType.includes("application/x-www-form-urlencoded")
  ) {
    const form = await request.formData().catch(() => null);
    if (!form) return null;
    const out: Record<string, unknown> = {};
    for (const [k, v] of form.entries()) {
      if (typeof v === "string") {
        out[k] = v;
      }
    }
    return out;
  }

  const rawText = await request.text().catch(() => "");
  if (!rawText.trim()) return {};
  try {
    const parsed = JSON.parse(rawText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return null;
  } catch {
    const params = new URLSearchParams(rawText);
    const out: Record<string, unknown> = {};
    for (const [k, v] of params.entries()) {
      out[k] = v;
    }
    return Object.keys(out).length > 0 ? out : null;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  if (request.method !== "GET" && request.method !== "HEAD") {
    return methodNotAllowed();
  }

  const url = new URL(request.url);
  const view = url.searchParams.get("view");
  const project = url.searchParams.get("project");
  const run = url.searchParams.get("run");

  try {
    if (view !== null) {
      if (view !== "library") {
        return json({ ok: false, error: "Invalid flow view parameter." }, 400);
      }
      const catalog = listFlowLaunchCatalog();
      return json({ ok: true, catalog });
    }

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
    return mapErrorResponse(err, "Could not read flow stream.");
  }
}

export async function action({ request, context }: Route.ActionArgs) {
  if (request.method !== "POST") {
    return methodNotAllowed();
  }

  requireSameOriginWrite(request, context);

  const body = await readActionBody(request);
  if (!body) {
    return json({ ok: false, error: "Invalid flow action payload." }, 400);
  }

  const intent = optionalString(body["intent"]);
  if (intent !== "plan" && intent !== "approve" && intent !== "start" && intent !== "decide" &&
      intent !== "project" && intent !== "import") {
    return json(
      { ok: false, error: "Unsupported flow action intent." },
      400,
    );
  }

  const projectId = optionalString(body["projectId"]);
  const runId = optionalString(body["runId"]);
  if (!projectId || !runId) {
    return json({ ok: false, error: "projectId and runId are required." }, 400);
  }

  try {
    if (intent === "project" || intent === "import") {
      return json({ ok: true, ...transferFlowProgress(intent, projectId, runId) });
    }
    if (intent === "plan") {
      const result = planFlowFromUi({
        projectId,
        runId,
        flowRef: optionalString(body["flowRef"]),
        draftYaml: optionalRawString(body["draftYaml"]),
        draftName: optionalString(body["draftName"]),
        baseTemplateRef: optionalString(body["baseTemplateRef"]),
      });
      return json({ ok: true, ...result });
    }

    if (intent === "approve") {
      const flowHash = optionalString(body["flowHash"]) ?? "";
      const actorId = optionalString(body["actorId"]);
      const result = approveFlowFromUi({
        projectId,
        runId,
        flowHash,
        ...(actorId ? { actorId } : {}),
      });
      return json({ ok: true, ...result });
    }

    if (intent === "decide") {
      const handoffId = optionalString(body["handoffId"]);
      const choiceKey = optionalString(body["choiceKey"]);
      if (!handoffId || !choiceKey) {
        return json({ ok: false, error: "handoffId and choiceKey are required." }, 400);
      }
      const result = await decideFlowFromUi({ projectId, runId, handoffId, choiceKey });
      return json({ ok: true, ...result, stream: readFlowCardStream(projectId, runId) });
    }

    const result = await startFlowFromUi({ projectId, runId });
    return json({ ok: true, ...result });
  } catch (err) {
    return mapErrorResponse(err, "Could not process flow action.");
  }
}
