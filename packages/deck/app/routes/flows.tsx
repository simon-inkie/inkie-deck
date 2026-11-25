/**
 * flows.tsx - Card stream & launch/approval view for Deck structured task flows.
 *
 * SEAM RULE: no fs imports, no env-root literals in the route.
 * ASCII only - no em-dashes.
 */

import { data, Link } from "react-router";
import { AlertTriangle, Workflow } from "lucide-react";
import type { Route } from "./+types/flows";
import { EmptyState } from "~/components/EmptyState";
import { FlowCardStream } from "~/components/FlowCardStream";
import { FlowLaunchPanel, FlowRunApprovalBar } from "~/components/FlowLaunchPanel";
import { RouteErrorPanel } from "~/components/RouteErrorPanel";
import { Badge } from "~/components/ui/badge";
import type {
  FlowCardStreamView,
  FlowLaunchCatalog,
  FlowRunSummary,
} from "~/lib/flows/card-stream";
import {
  FlowIntegrityError,
  InvalidFlowQueryError,
  listFlowProjects,
  listFlowRuns,
  readFlowCardStream,
} from "~/lib/flows/reader.server";
import { FlowIdRegex } from "~/lib/flows/types";
import { listFlowLaunchCatalog } from "~/lib/flows/ui-actions.server";
import { cn } from "~/lib/utils";

const EMPTY_CATALOG: FlowLaunchCatalog = { flows: [], drafts: [] };

export function meta({}: Route.MetaArgs) {
  return [
    { title: "Flows - Inkie Deck" },
    { name: "description", content: "Structured task flow launcher and card stream" },
  ];
}

interface FlowsLoaderData {
  projects: string[];
  selectedProject: string | null;
  runs: FlowRunSummary[];
  selectedRunId: string | null;
  stream: FlowCardStreamView | null;
  catalog: FlowLaunchCatalog;
  error: string | null;
}

function loadCatalogSafely(): FlowLaunchCatalog {
  try {
    return listFlowLaunchCatalog();
  } catch {
    return EMPTY_CATALOG;
  }
}

export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const requestedProject = url.searchParams.get("project");
  const requestedRun = url.searchParams.get("run");

  let projects: string[] = [];
  try {
    projects = listFlowProjects();
  } catch (err) {
    if (err instanceof FlowIntegrityError) {
      return data<FlowsLoaderData>(
        {
          projects: [],
          selectedProject: null,
          runs: [],
          selectedRunId: null,
          stream: null,
          catalog: EMPTY_CATALOG,
          error: "Flow ledger failed integrity verification.",
        },
        { status: 422 },
      );
    }
    return data<FlowsLoaderData>(
      {
        projects: [],
        selectedProject: null,
        runs: [],
        selectedRunId: null,
        stream: null,
        catalog: EMPTY_CATALOG,
        error: "Could not list flow projects.",
      },
      { status: 500 },
    );
  }

  const catalog = loadCatalogSafely();

  if (requestedProject !== null && !FlowIdRegex.test(requestedProject)) {
    return data<FlowsLoaderData>(
      {
        projects,
        selectedProject: null,
        runs: [],
        selectedRunId: null,
        stream: null,
        catalog,
        error: "Invalid flow project id.",
      },
      { status: 400 },
    );
  }

  const selectedProject = requestedProject ?? projects[0] ?? null;

  if (requestedRun !== null && !FlowIdRegex.test(requestedRun)) {
    return data<FlowsLoaderData>(
      {
        projects,
        selectedProject,
        runs: [],
        selectedRunId: null,
        stream: null,
        catalog,
        error: "Invalid flow run id.",
      },
      { status: 400 },
    );
  }

  if (!selectedProject) {
    return {
      projects,
      selectedProject: null,
      runs: [],
      selectedRunId: null,
      stream: null,
      catalog,
      error: null,
    } satisfies FlowsLoaderData;
  }

  let runs: FlowRunSummary[] = [];
  try {
    runs = listFlowRuns(selectedProject);
  } catch (err) {
    if (err instanceof InvalidFlowQueryError) {
      return data<FlowsLoaderData>(
        {
          projects,
          selectedProject,
          runs: [],
          selectedRunId: null,
          stream: null,
          catalog,
          error: "Invalid flow project id.",
        },
        { status: 400 },
      );
    }
    if (err instanceof FlowIntegrityError) {
      return data<FlowsLoaderData>(
        {
          projects,
          selectedProject,
          runs: [],
          selectedRunId: null,
          stream: null,
          catalog,
          error: "Flow ledger failed integrity verification.",
        },
        { status: 422 },
      );
    }
    return data<FlowsLoaderData>(
      {
        projects,
        selectedProject,
        runs: [],
        selectedRunId: null,
        stream: null,
        catalog,
        error: "Could not read flow runs.",
      },
      { status: 500 },
    );
  }

  const selectedRunId = requestedRun ?? runs[0]?.runId ?? null;
  if (!selectedRunId) {
    return {
      projects,
      selectedProject,
      runs,
      selectedRunId: null,
      stream: null,
      catalog,
      error: null,
    } satisfies FlowsLoaderData;
  }

  try {
    const stream = readFlowCardStream(selectedProject, selectedRunId);
    if (!stream) {
      if (requestedRun !== null) {
        return data<FlowsLoaderData>(
          {
            projects,
            selectedProject,
            runs,
            selectedRunId,
            stream: null,
            catalog,
            error: "Flow run not found.",
          },
          { status: 404 },
        );
      }
      return {
        projects,
        selectedProject,
        runs,
        selectedRunId: null,
        stream: null,
        catalog,
        error: null,
      } satisfies FlowsLoaderData;
    }

    return {
      projects,
      selectedProject,
      runs,
      selectedRunId,
      stream,
      catalog,
      error: null,
    } satisfies FlowsLoaderData;
  } catch (err) {
    if (err instanceof InvalidFlowQueryError) {
      return data<FlowsLoaderData>(
        {
          projects,
          selectedProject,
          runs,
          selectedRunId,
          stream: null,
          catalog,
          error: "Invalid flow project or run id.",
        },
        { status: 400 },
      );
    }
    if (err instanceof FlowIntegrityError) {
      return data<FlowsLoaderData>(
        {
          projects,
          selectedProject,
          runs,
          selectedRunId,
          stream: null,
          catalog,
          error: "Flow ledger failed integrity verification.",
        },
        { status: 422 },
      );
    }
    return data<FlowsLoaderData>(
      {
        projects,
        selectedProject,
        runs,
        selectedRunId,
        stream: null,
        catalog,
        error: "Could not read flow stream.",
      },
      { status: 500 },
    );
  }
}

export default function FlowsRoute({ loaderData }: Route.ComponentProps) {
  const { projects, selectedProject, runs, selectedRunId, stream, error } =
    loaderData;
  const catalog = loaderData.catalog ?? EMPTY_CATALOG;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <div className="mb-6 flex flex-col gap-4 border-b border-border pb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h2 className="font-display text-lg font-bold uppercase tracking-tight text-foreground">
              Structured Flows
            </h2>
            <p className="text-xs text-muted-foreground">
              Choose, draft, approve, and inspect structured flows backed by project SQLite ledgers.
            </p>
          </div>
        </div>

        {projects.length > 0 ? (
          <nav
            aria-label="Flow projects"
            data-testid="flows-project-selector"
            className="flex flex-wrap items-center gap-2"
          >
            <span className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Project:
            </span>
            {projects.map((projectId) => {
              const active = projectId === selectedProject;
              return (
                <Link
                  key={projectId}
                  to={`/flows?project=${encodeURIComponent(projectId)}`}
                  data-testid={`flows-project-${projectId}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/10 font-semibold text-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  {projectId}
                </Link>
              );
            })}
          </nav>
        ) : null}

        {selectedProject && runs.length > 0 ? (
          <nav
            aria-label="Flow runs"
            data-testid="flows-run-selector"
            className="flex flex-wrap items-center gap-2"
          >
            <span className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
              Run:
            </span>
            {runs.map((run) => {
              const active = run.runId === selectedRunId;
              return (
                <Link
                  key={run.runId}
                  to={`/flows?project=${encodeURIComponent(selectedProject)}&run=${encodeURIComponent(run.runId)}`}
                  data-testid={`flows-run-${run.runId}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1 font-mono text-xs transition-colors",
                    active
                      ? "border-primary bg-primary/10 font-semibold text-foreground"
                      : "border-border bg-card text-muted-foreground hover:text-foreground",
                  )}
                >
                  <span>{run.runId}</span>
                  <Badge variant="outline" className="text-[10px]">
                    {run.status}
                  </Badge>
                  {run.waitingOn ? (
                    <Badge
                      data-testid={`flows-run-waiting-${run.runId}`}
                      variant="warning"
                      className="text-[10px]"
                    >
                      waiting: {run.waitingOn}
                    </Badge>
                  ) : null}
                </Link>
              );
            })}
          </nav>
        ) : null}
      </div>

      <FlowLaunchPanel catalog={catalog} selectedProject={selectedProject} />

      {error ? (
        <div
          data-testid="flows-error"
          role="alert"
          className="flex items-start gap-3 rounded-lg border-2 border-destructive/40 bg-destructive/10 p-4 text-sm text-foreground"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-destructive" aria-hidden="true" />
          <div>
            <div className="font-semibold">Unable to display flow stream</div>
            <p className="mt-1 font-mono text-xs text-muted-foreground">{error}</p>
          </div>
        </div>
      ) : stream ? (
        <>
          <FlowRunApprovalBar stream={stream} catalog={catalog} />
          <FlowCardStream stream={stream} />
        </>
      ) : (
        <div data-testid="flows-empty">
          <EmptyState
            icon={Workflow}
            title="No flow runs found"
            body="Plan and approve a structured flow run above to inspect its verified card stream here."
          />
        </div>
      )}
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <RouteErrorPanel
      error={error}
      scope="the flows stream"
      hint="The project flow ledger may be unreadable or failed integrity verification."
    />
  );
}
