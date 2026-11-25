/**
 * ui-actions.server.ts - Server-side UI orchestration seam for Deck Flows Slice 3.
 *
 * Isolates all filesystem, env-root (`FLOWS_PROJECT_ROOT` / `DATA_ROOT`),
 * SQLite planning/approval/execution, and validation calls from app/routes/*.tsx
 * and client components.
 *
 * ASCII only - no em-dashes.
 */

import type {
  FlowLaunchCatalog,
  FlowLaunchCatalogEntry,
  FlowLaunchDraftEntry,
} from "./card-stream.js";
import { computeUnifiedDiff } from "./diff.js";
import {
  FlowNotFoundError,
  FlowValidationError,
  listAvailableFlows,
  loadFlowDefinition,
  loadFlowDraft,
  saveFlowDraft,
  type FlowLibraryOptions,
} from "./library.server.js";
import { loadRunState } from "./load-run.server.js";
import { InvalidFlowQueryError, listFlowRuns } from "./reader.server.js";
import { approveRun, planRun, runFlow, submitHandoffReturn, type RunFlowResult } from "./runner.server.js";
import { FlowIdRegex } from "./types.js";
import { validateFlowYaml } from "./validator.js";

export class FlowNotApprovedError extends Error {
  constructor(
    public readonly runId: string,
    public readonly flowHash?: string,
  ) {
    super(`Flow run '${runId}' is not approved for execution.`);
    this.name = "FlowNotApprovedError";
  }
}

export class FlowRunNotFoundError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly runId: string,
  ) {
    super(`Flow run '${runId}' not found for project '${projectId}'.`);
    this.name = "FlowRunNotFoundError";
  }
}

export class FlowDuplicateRunError extends Error {
  constructor(
    public readonly projectId: string,
    public readonly runId: string,
  ) {
    super(`Flow run '${runId}' already exists in project '${projectId}'.`);
    this.name = "FlowDuplicateRunError";
  }
}

export class InvalidFlowUiActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidFlowUiActionError";
  }
}

export class FlowDecisionConflictError extends Error {}

export interface FlowLaunchCatalogOptions {
  projectRoot?: string;
  dataRoot?: string;
  builtinsDir?: string;
}

export interface PlanFlowFromUiParams {
  projectId: string;
  runId: string;
  flowRef?: string;
  draftYaml?: string;
  draftName?: string;
  baseTemplateRef?: string;
  projectRoot?: string;
  dataRoot?: string;
  builtinsDir?: string;
}

export interface PlanFlowFromUiResult {
  runId: string;
  flowRef: string;
  flowHash: string;
  status: "planned";
  expectedDecisions: string[];
  source: "project" | "library" | "builtin";
  diffFromTemplate?: string;
  warning?: string;
}

export interface ApproveFlowFromUiParams {
  projectId: string;
  runId: string;
  flowHash: string;
  actorId?: string;
  dataRoot?: string;
}

export interface ApproveFlowFromUiResult {
  runId: string;
  flowHash: string;
  actorId: string;
  status: "approved";
}

export interface StartFlowFromUiParams {
  projectId: string;
  runId: string;
  dataRoot?: string;
  stepTimeoutMs?: number;
  workspaceRepoRoot?: string;
  worktreeRoot?: string;
}

function resolveLibraryOpts(opts?: FlowLaunchCatalogOptions): FlowLibraryOptions {
  const rawProjectRoot = opts?.projectRoot ?? process.env["FLOWS_PROJECT_ROOT"];
  const projectRoot = rawProjectRoot?.trim() || undefined;
  return {
    ...(projectRoot ? { projectRoot } : {}),
    // Keep dataRoot undefined unless explicitly passed so library.server.ts
    // reads DATA_ROOT safely when available and tolerates dev worktree defaults.
    ...(opts?.dataRoot !== undefined ? { dataRoot: opts.dataRoot } : {}),
    ...(opts?.builtinsDir !== undefined ? { builtinsDir: opts.builtinsDir } : {}),
  };
}

function assertValidId(value: string | undefined, label: string): string {
  if (typeof value !== "string" || !FlowIdRegex.test(value)) {
    throw new InvalidFlowQueryError(`Invalid ${label}.`);
  }
  return value;
}

/**
 * List available flows (project, library, builtin) and project drafts,
 * returning YAML content without exposing host filesystem paths.
 */
export function listFlowLaunchCatalog(opts?: FlowLaunchCatalogOptions): FlowLaunchCatalog {
  const libOpts = resolveLibraryOpts(opts);
  const listing = listAvailableFlows(libOpts);

  const flows: FlowLaunchCatalogEntry[] = [];
  const flowsByRef = new Map<string, FlowLaunchCatalogEntry>();

  for (const item of listing.flows) {
    const loaded = loadFlowDefinition(item.flowRef, libOpts);
    const entry: FlowLaunchCatalogEntry = {
      flowRef: loaded.flowRef,
      source: loaded.source,
      ...(loaded.flow.title ? { title: loaded.flow.title } : {}),
      hash: loaded.hash,
      yaml: loaded.yaml,
      stepCount: loaded.flow.steps.length,
      hasWorkspace: Boolean(loaded.flow.workspace),
    };
    flows.push(entry);
    flowsByRef.set(entry.flowRef, entry);
  }

  const drafts: FlowLaunchDraftEntry[] = [];
  if (libOpts.projectRoot) {
    for (const draft of listing.drafts) {
      const loadedDraft = loadFlowDraft({
        projectRoot: libOpts.projectRoot,
        draftName: draft.draftName,
      });
      const base = flowsByRef.get(loadedDraft.flow.flow);
      const diffFromTemplate = base
        ? computeUnifiedDiff(
            base.yaml,
            loadedDraft.yaml,
            `${base.source}/${base.flowRef}.yaml`,
            `drafts/${loadedDraft.draftName}.yaml`,
          )
        : undefined;
      drafts.push({
        draftName: loadedDraft.draftName,
        flowRef: loadedDraft.flow.flow,
        source: "draft",
        ...(loadedDraft.flow.title ? { title: loadedDraft.flow.title } : {}),
        hash: loadedDraft.hash,
        yaml: loadedDraft.yaml,
        stepCount: loadedDraft.flow.steps.length,
        ...(diffFromTemplate ? { diffFromTemplate } : {}),
      });
    }
  }

  return { flows, drafts };
}

/**
 * Validate and plan a new run (without approving it).
 * Optionally saves a validated draft when draftYaml is provided.
 */
export function planFlowFromUi(params: PlanFlowFromUiParams): PlanFlowFromUiResult {
  const projectId = assertValidId(params.projectId, "flow project id");
  const runId = assertValidId(params.runId, "flow run id");

  if (params.flowRef !== undefined) {
    assertValidId(params.flowRef, "flowRef");
  }
  if (params.draftName !== undefined) {
    assertValidId(params.draftName, "draftName");
  }
  if (params.baseTemplateRef !== undefined) {
    assertValidId(params.baseTemplateRef, "baseTemplateRef");
  }

  const libOpts = resolveLibraryOpts({
    projectRoot: params.projectRoot,
    dataRoot: params.dataRoot,
    builtinsDir: params.builtinsDir,
  });

  let flowYaml: string;
  let source: "project" | "library" | "builtin";
  let diffFromTemplate: string | undefined;
  let draftToSave: Parameters<typeof saveFlowDraft>[0] | undefined;

  if (params.draftYaml !== undefined && params.draftYaml.trim().length > 0) {
    const validation = validateFlowYaml(params.draftYaml);
    if (!validation.valid) {
      throw new FlowValidationError(
        params.draftName ?? params.flowRef ?? "draft",
        validation.errors,
      );
    }

    const resolvedDraftName = params.draftName ?? validation.flow.flow;
    if (libOpts.projectRoot) {
      draftToSave = {
        projectRoot: libOpts.projectRoot,
        draftName: resolvedDraftName,
        yaml: params.draftYaml,
        overwrite: params.draftName !== undefined,
      };
    }
    if (params.baseTemplateRef) {
      const base = loadFlowDefinition(params.baseTemplateRef, libOpts);
      diffFromTemplate = computeUnifiedDiff(
        base.yaml,
        params.draftYaml,
        `${base.source}/${base.flowRef}.yaml`,
        `drafts/${resolvedDraftName}.yaml`,
      );
    }

    flowYaml = params.draftYaml;
    source = "project";
  } else if (params.draftName) {
    if (!libOpts.projectRoot) {
      throw new FlowNotFoundError(params.draftName);
    }
    const draft = loadFlowDraft({
      projectRoot: libOpts.projectRoot,
      draftName: params.draftName,
    });
    flowYaml = draft.yaml;
    source = "project";
    if (params.baseTemplateRef) {
      const base = loadFlowDefinition(params.baseTemplateRef, libOpts);
      diffFromTemplate = computeUnifiedDiff(
        base.yaml,
        draft.yaml,
        `${base.source}/${base.flowRef}.yaml`,
        `drafts/${draft.draftName}.yaml`,
      );
    }
  } else if (params.flowRef) {
    const loaded = loadFlowDefinition(params.flowRef, libOpts);
    flowYaml = loaded.yaml;
    source = loaded.source;
  } else {
    throw new InvalidFlowUiActionError("Select a flow or provide draft YAML.");
  }

  let planned: ReturnType<typeof planRun>;
  try {
    planned = planRun({
      projectId,
      runId,
      flowYaml,
      source,
      dataRoot: params.dataRoot,
    });
  } catch (err) {
    if (err instanceof Error) {
      const code = (err as { code?: string }).code;
      if (
        code === "SQLITE_CONSTRAINT_PRIMARYKEY" ||
        code === "SQLITE_CONSTRAINT" ||
        err.message.includes("UNIQUE constraint failed: flow_runs.run_id")
      ) {
        throw new FlowDuplicateRunError(projectId, runId);
      }
    }
    throw err;
  }

  let warning: string | undefined;
  if (draftToSave) {
    try {
      saveFlowDraft(draftToSave);
    } catch {
      warning = "Run planned, but the draft could not be saved.";
    }
  }

  return {
    runId: planned.runId,
    flowRef: planned.flow.flow,
    flowHash: planned.flowHash,
    status: "planned",
    expectedDecisions: planned.expectedDecisions,
    source,
    ...(diffFromTemplate !== undefined ? { diffFromTemplate } : {}),
    ...(warning ? { warning } : {}),
  };
}

/**
 * Approve a planned run for its exact pinned flow hash.
 */
export function approveFlowFromUi(params: ApproveFlowFromUiParams): ApproveFlowFromUiResult {
  const projectId = assertValidId(params.projectId, "flow project id");
  const runId = assertValidId(params.runId, "flow run id");

  if (typeof params.flowHash !== "string" || params.flowHash.trim().length === 0) {
    throw new InvalidFlowUiActionError("flowHash is required to approve a flow run.");
  }

  const actorId = params.actorId ?? "operator-1";
  assertValidId(actorId, "actorId");

  const runs = listFlowRuns(projectId, { dataRoot: params.dataRoot });
  if (!runs.some((r) => r.runId === runId)) {
    throw new FlowRunNotFoundError(projectId, runId);
  }

  try {
    const approved = approveRun({
      projectId,
      runId,
      flowHash: params.flowHash,
      actorId,
      dataRoot: params.dataRoot,
    });
    return {
      runId: approved.runId,
      flowHash: approved.flowHash,
      actorId: approved.actorId,
      status: "approved",
    };
  } catch (err) {
    if (err instanceof Error && /Flow run .* not found/i.test(err.message)) {
      throw new FlowRunNotFoundError(projectId, runId);
    }
    throw err;
  }
}

/**
 * Start or resume an approved run. Rejects unapproved ("planned") runs with FlowNotApprovedError.
 */
export async function startFlowFromUi(params: StartFlowFromUiParams): Promise<RunFlowResult> {
  const projectId = assertValidId(params.projectId, "flow project id");
  const runId = assertValidId(params.runId, "flow run id");

  const runs = listFlowRuns(projectId, { dataRoot: params.dataRoot });
  if (!runs.some((r) => r.runId === runId)) {
    throw new FlowRunNotFoundError(projectId, runId);
  }

  const loaded = loadRunState(projectId, runId, { dataRoot: params.dataRoot });
  const isApproved = loaded.events.some(
    (ev) => ev.type === "flow_approved" && ev.data.flowHash === loaded.run.flow_hash,
  );
  if (loaded.state.status === "planned" || !isApproved) {
    throw new FlowNotApprovedError(runId, loaded.run.flow_hash);
  }

  return await runFlow(projectId, runId, {
    ...(params.dataRoot !== undefined ? { dataRoot: params.dataRoot } : {}),
    ...(params.stepTimeoutMs !== undefined ? { stepTimeoutMs: params.stepTimeoutMs } : {}),
    ...(params.workspaceRepoRoot ? { workspaceRepoRoot: params.workspaceRepoRoot } : {}),
    ...(params.worktreeRoot ? { worktreeRoot: params.worktreeRoot } : {}),
  });
}

export async function decideFlowFromUi(
  params: StartFlowFromUiParams & { handoffId: string; choiceKey: string },
): Promise<RunFlowResult> {
  const projectId = assertValidId(params.projectId, "flow project id");
  const runId = assertValidId(params.runId, "flow run id");
  const handoffId = assertValidId(params.handoffId, "handoffId");
  const choiceKey = assertValidId(params.choiceKey, "choiceKey");
  if (!listFlowRuns(projectId, { dataRoot: params.dataRoot }).some((r) => r.runId === runId)) {
    throw new FlowRunNotFoundError(projectId, runId);
  }

  const result = submitHandoffReturn({
    projectId, runId, handoffId, choiceKey, dataRoot: params.dataRoot,
    actor: "human", actorId: "operator-1",
  });
  if (!result.accepted) {
    throw new FlowDecisionConflictError();
  }
  return startFlowFromUi(params);
}
