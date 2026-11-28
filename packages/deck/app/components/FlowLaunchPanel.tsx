/**
 * FlowLaunchPanel.tsx - Minimal choose / draft-diff / plan / approve / start
 * controls for Deck Flows Slice 3.
 *
 * Pure UI component: zero .server or Node imports.
 * ASCII only - no em-dashes.
 */

import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { useLocation, useNavigate, useRevalidator } from "react-router";
import { AlertTriangle, FileDiff, Play, Plus, ShieldCheck } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { Select } from "./ui/select";
import type {
  FlowCardStreamView,
  FlowLaunchCatalog,
  FlowLaunchCatalogEntry,
  FlowLaunchDraftEntry,
} from "~/lib/flows/card-stream";
import { computeUnifiedDiff } from "~/lib/flows/diff";
import { cn } from "~/lib/utils";

function sourceBadgeVariant(
  source: "project" | "library" | "builtin" | "draft",
): "default" | "secondary" | "outline" | "success" | "warning" {
  if (source === "draft") return "warning";
  if (source === "project") return "success";
  if (source === "library") return "default";
  return "outline";
}

function renderDiffLines(diffText: string) {
  const lines = diffText.split("\n");
  return lines.map((line, index) => {
    let cls = "text-muted-foreground";
    if (line.startsWith("+") && !line.startsWith("+++")) {
      cls = "text-primary";
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      cls = "text-destructive";
    } else if (line.startsWith("@@")) {
      cls = "text-accent";
    }
    return (
      <span key={`${index}-${line.slice(0, 16)}`} className={cn("block whitespace-pre", cls)}>
        {line || " "}
      </span>
    );
  });
}

type CatalogSelection =
  | { kind: "flow"; item: FlowLaunchCatalogEntry }
  | { kind: "draft"; item: FlowLaunchDraftEntry };

export interface FlowLaunchPanelProps {
  catalog: FlowLaunchCatalog;
  selectedProject: string | null;
}

export function FlowLaunchPanel({ catalog, selectedProject }: FlowLaunchPanelProps) {
  const navigate = useNavigate();
  const revalidator = useRevalidator();

  const allFlows = catalog.flows;
  const allDrafts = catalog.drafts;

  const defaultSelectionKey = useMemo(() => {
    if (allFlows.length > 0) return `flow:${allFlows[0]!.flowRef}`;
    if (allDrafts.length > 0) return `draft:${allDrafts[0]!.draftName}`;
    return "";
  }, [allFlows, allDrafts]);

  const [projectId, setProjectId] = useState<string>(selectedProject ?? "default-project");
  const [projectTouched, setProjectTouched] = useState(false);
  const [runIdInput, setRunIdInput] = useState<string>("");
  const [selectionKey, setSelectionKey] = useState<string>(defaultSelectionKey);

  const [draftMode, setDraftMode] = useState<boolean>(false);
  const [baseTemplateRef, setBaseTemplateRef] = useState<string>(allFlows[0]?.flowRef ?? "");
  const [draftName, setDraftName] = useState<string>("");
  const [draftYaml, setDraftYaml] = useState<string>(
    allFlows[0]?.yaml ?? allDrafts[0]?.yaml ?? "",
  );
  const [submitting, setSubmitting] = useState<boolean>(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!projectTouched && selectedProject) {
      setProjectId(selectedProject);
    }
  }, [selectedProject, projectTouched]);

  useEffect(() => {
    if (!selectionKey && defaultSelectionKey) {
      setSelectionKey(defaultSelectionKey);
    }
  }, [selectionKey, defaultSelectionKey]);

  const currentSelection: CatalogSelection | null = useMemo(() => {
    if (selectionKey.startsWith("flow:")) {
      const ref = selectionKey.slice("flow:".length);
      const found = allFlows.find((f) => f.flowRef === ref);
      return found ? { kind: "flow", item: found } : null;
    }
    if (selectionKey.startsWith("draft:")) {
      const name = selectionKey.slice("draft:".length);
      const found = allDrafts.find((d) => d.draftName === name);
      return found ? { kind: "draft", item: found } : null;
    }
    return null;
  }, [selectionKey, allFlows, allDrafts]);

  const baseTemplate = useMemo(
    () => allFlows.find((f) => f.flowRef === baseTemplateRef) ?? null,
    [allFlows, baseTemplateRef],
  );

  function comparisonTemplateRef(flowRef: string): string {
    return allFlows.some((flow) => flow.flowRef === flowRef) ? flowRef : "";
  }

  const liveDiff = useMemo(() => {
    if (!draftMode || !baseTemplate) return null;
    const labelName = draftName.trim() || "custom";
    return computeUnifiedDiff(
      baseTemplate.yaml,
      draftYaml,
      `${baseTemplate.source}/${baseTemplate.flowRef}.yaml`,
      `drafts/${labelName}.yaml`,
    );
  }, [draftMode, baseTemplate, draftYaml, draftName]);

  function handleSelectionChange(nextKey: string) {
    setSelectionKey(nextKey);
    setError(null);
    if (nextKey.startsWith("flow:")) {
      const ref = nextKey.slice("flow:".length);
      const found = allFlows.find((f) => f.flowRef === ref);
      if (found) {
        setBaseTemplateRef(found.flowRef);
        setDraftName("");
        if (draftMode) {
          setDraftYaml(found.yaml);
        }
      }
    } else if (nextKey.startsWith("draft:")) {
      const name = nextKey.slice("draft:".length);
      const found = allDrafts.find((d) => d.draftName === name);
      if (found) {
        setBaseTemplateRef(comparisonTemplateRef(found.flowRef));
        setDraftName(found.draftName);
        if (draftMode) {
          setDraftYaml(found.yaml);
        }
      }
    }
  }

  function handleToggleDraftMode() {
    const next = !draftMode;
    setDraftMode(next);
    setError(null);
    if (next) {
      if (currentSelection?.kind === "draft") {
        setBaseTemplateRef(comparisonTemplateRef(currentSelection.item.flowRef));
        setDraftName(currentSelection.item.draftName);
        setDraftYaml(currentSelection.item.yaml);
      } else if (currentSelection?.kind === "flow") {
        setBaseTemplateRef(currentSelection.item.flowRef);
        setDraftName("");
        setDraftYaml(currentSelection.item.yaml);
      } else if (allFlows[0]) {
        setBaseTemplateRef(allFlows[0].flowRef);
        setDraftYaml(allFlows[0].yaml);
      }
    }
  }

  function handleTemplateChange(nextRef: string) {
    setBaseTemplateRef(nextRef);
    const found = allFlows.find((f) => f.flowRef === nextRef);
    if (found) {
      setDraftYaml(found.yaml);
      setDraftName("");
    }
  }

  async function handlePlanSubmit(e: FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);

    const targetProject = projectId.trim();
    if (!targetProject) {
      setError("Project ID is required.");
      return;
    }

    const resolvedRunId = runIdInput.trim() || `run-${Date.now().toString(36)}`;

    const payload: Record<string, string> = {
      intent: "plan",
      projectId: targetProject,
      runId: resolvedRunId,
    };

    if (draftMode) {
      payload["draftYaml"] = draftYaml;
      if (draftName.trim()) {
        payload["draftName"] = draftName.trim();
      }
      if (baseTemplateRef.trim()) {
        payload["baseTemplateRef"] = baseTemplateRef.trim();
      }
    } else if (currentSelection?.kind === "draft") {
      payload["draftName"] = currentSelection.item.draftName;
      const templateRef = comparisonTemplateRef(currentSelection.item.flowRef);
      if (templateRef) {
        payload["baseTemplateRef"] = templateRef;
      }
    } else if (currentSelection?.kind === "flow") {
      payload["flowRef"] = currentSelection.item.flowRef;
    } else {
      setError("Select a flow or provide draft YAML.");
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(payload),
      });
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        details?: Array<{ path: string; message: string }>;
        runId?: string;
        diffFromTemplate?: string;
        warning?: string;
      };

      if (!res.ok || !data.ok || !data.runId) {
        const detailText =
          data.details && data.details.length > 0
            ? ` (${data.details.map((d) => `${d.path || "flow"}: ${d.message}`).join("; ")})`
            : "";
        setError((data.error ?? "Could not plan flow run.") + detailText);
        return;
      }

      setRunIdInput("");
      navigate(
        `/flows?project=${encodeURIComponent(targetProject)}&run=${encodeURIComponent(data.runId)}`,
        {
          state: {
            diffFromTemplate: data.diffFromTemplate ?? null,
            plannedRunId: data.runId,
            planWarning: data.warning,
          },
        },
      );
      revalidator.revalidate();
    } catch {
      setError("Network error while planning flow run.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Card data-testid="flow-launch-panel" className="mb-6">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide">
            <Plus className="size-4 text-primary" aria-hidden="true" />
            <span>Launch Flow Run</span>
          </CardTitle>
          <Button
            type="button"
            variant="outline"
            size="sm"
            data-testid="launch-draft-toggle"
            aria-expanded={draftMode}
            onClick={handleToggleDraftMode}
          >
            <FileDiff className="size-3.5" aria-hidden="true" />
            <span>{draftMode ? "Use Catalog Flow" : "Draft custom YAML"}</span>
          </Button>
        </div>
      </CardHeader>

      <CardContent>
        <form onSubmit={handlePlanSubmit} className="space-y-3">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <label className="flex flex-col gap-1 text-xs">
              <span className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Project ID
              </span>
              <input
                type="text"
                data-testid="launch-project-input"
                value={projectId}
                onChange={(e) => {
                  setProjectTouched(true);
                  setProjectId(e.target.value);
                }}
                placeholder="default-project"
                className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>

            <label className="flex flex-col gap-1 text-xs">
              <span className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Run ID
              </span>
              <input
                type="text"
                data-testid="launch-run-input"
                value={runIdInput}
                onChange={(e) => setRunIdInput(e.target.value)}
                placeholder="auto if blank"
                className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              />
            </label>

            <div className="flex flex-col gap-1 text-xs">
              <div className="flex items-center justify-between gap-2">
                <label
                  htmlFor="launch-flow-select"
                  className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground"
                >
                  Flow Definition
                </label>
                {currentSelection ? (
                  <Badge
                    data-testid="launch-selected-source"
                    variant={sourceBadgeVariant(currentSelection.item.source)}
                    className="px-1.5 py-0 text-[10px]"
                  >
                    {currentSelection.item.source}
                  </Badge>
                ) : null}
              </div>
              <select
                id="launch-flow-select"
                data-testid="launch-flow-select"
                value={selectionKey}
                onChange={(e) => handleSelectionChange(e.target.value)}
                disabled={draftMode}
                className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
              >
                {allFlows.map((flow) => (
                  <option key={`flow:${flow.flowRef}`} value={`flow:${flow.flowRef}`}>
                    {flow.flowRef} ({flow.source})
                    {flow.title ? ` - ${flow.title}` : ""}
                  </option>
                ))}
                {allDrafts.map((draft) => (
                  <option key={`draft:${draft.draftName}`} value={`draft:${draft.draftName}`}>
                    {draft.draftName} (draft)
                    {draft.title ? ` - ${draft.title}` : ""}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {draftMode ? (
            <div
              data-testid="launch-draft-editor"
              className="space-y-3 rounded-md border border-border/80 bg-background/70 p-3"
            >
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <label className="flex flex-col gap-1 text-xs">
                  <span className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Base Template
                  </span>
                  <select
                    data-testid="launch-template-select"
                    value={baseTemplateRef}
                    onChange={(e) => handleTemplateChange(e.target.value)}
                    className="h-8 rounded-md border border-border bg-background px-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <option value="">None</option>
                    {allFlows.map((flow) => (
                      <option key={flow.flowRef} value={flow.flowRef}>
                        {flow.flowRef} ({flow.source})
                      </option>
                    ))}
                  </select>
                </label>

                <label className="flex flex-col gap-1 text-xs">
                  <span className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                    Draft Name (optional)
                  </span>
                  <input
                    type="text"
                    data-testid="launch-draft-name"
                    value={draftName}
                    onChange={(e) => setDraftName(e.target.value)}
                    placeholder="uses flow id if blank"
                    className="h-8 rounded-md border border-border bg-background px-2.5 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  />
                </label>
              </div>

              <label className="flex flex-col gap-1 text-xs">
                <span className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                  Flow YAML
                </span>
                <textarea
                  data-testid="launch-draft-yaml"
                  value={draftYaml}
                  onChange={(e) => setDraftYaml(e.target.value)}
                  rows={8}
                  spellCheck={false}
                  className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                />
              </label>

              {liveDiff ? (
                <div>
                  <div className="label-mono mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                    Unified Diff vs Base Template
                  </div>
                  <pre
                    data-testid="launch-diff-preview"
                    className="max-h-52 overflow-auto rounded-md border border-border bg-card p-2 font-mono text-[11px] leading-relaxed"
                  >
                    {renderDiffLines(liveDiff)}
                  </pre>
                </div>
              ) : null}
            </div>
          ) : null}

          {error ? (
            <p
              data-testid="launch-error"
              role="alert"
              className="flex items-center gap-1.5 font-mono text-xs text-destructive"
            >
              <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
              <span>{error}</span>
            </p>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            <Button
              type="submit"
              size="sm"
              data-testid="launch-plan-button"
              disabled={submitting}
            >
              {submitting ? "Planning..." : "Plan Run"}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

export interface FlowRunApprovalBarProps {
  stream: FlowCardStreamView;
  catalog?: FlowLaunchCatalog;
}

export function FlowRunApprovalBar({ stream, catalog }: FlowRunApprovalBarProps) {
  const location = useLocation();
  const revalidator = useRevalidator();
  const [busyAction, setBusyAction] = useState<"approve" | "preanswer" | "start" | null>(null);
  const actionInFlight = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const navState = (location.state ?? null) as {
    diffFromTemplate?: string | null;
    plannedRunId?: string;
    planWarning?: string;
  } | null;

  const matchedDraftDiff = useMemo(() => {
    if (navState?.plannedRunId === stream.runId && navState.diffFromTemplate) {
      return navState.diffFromTemplate;
    }
    const matchedDraft = catalog?.drafts.find(
      (d) => d.hash === stream.planningCard.flowHash && d.diffFromTemplate,
    );
    return matchedDraft?.diffFromTemplate ?? null;
  }, [navState, stream.runId, stream.planningCard.flowHash, catalog]);

  if (stream.readOnly || (stream.runStatus !== "planned" && stream.runStatus !== "approved")) {
    return null;
  }
  const canStart = stream.runStatus === "approved" && stream.planningCard.approved;
  const preanswerableQuestions = stream.planningDecisions?.filter((question) => !question.liveOnly) ?? [];

  async function submitAction(
    action: { intent: "approve" | "start" } | { intent: "preanswer"; stepId: string; choiceKey: string },
  ) {
    if (actionInFlight.current) return;
    actionInFlight.current = true;
    setActionError(null);
    setBusyAction(action.intent);
    const failureMessage = {
      approve: "Could not approve flow run.",
      preanswer: "Could not save pre-answer.",
      start: "Could not start flow run.",
    }[action.intent];
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          ...action,
          projectId: stream.projectId,
          runId: stream.runId,
          ...(action.intent === "start" ? {} : { flowHash: stream.planningCard.flowHash }),
        }),
      });
      const data = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !data.ok) {
        setActionError(data.error ?? failureMessage);
        return;
      }
      await revalidator.revalidate();
    } catch {
      setActionError(failureMessage);
    } finally {
      actionInFlight.current = false;
      setBusyAction(null);
    }
  }

  return (
    <Card
      data-testid={stream.runStatus === "planned" ? "flow-approve-bar" : "flow-start-bar"}
      className="mb-4 border-primary/40 bg-card"
    >
      <CardContent className="space-y-3 p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-2 font-mono text-xs">
            <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
            <span className="font-semibold text-foreground">
              {stream.runStatus === "planned"
                ? "Awaiting Approval"
                : "Approved and Ready to Start"}
            </span>
            <Badge variant="outline" data-testid="flow-pinned-hash" className="font-mono text-[11px]">
              hash: {stream.planningCard.flowHash.slice(0, 12)}
            </Badge>
          </div>

          {stream.runStatus === "planned" ? (
            <Button
              type="button"
              size="sm"
              data-testid="flow-approve-button"
              disabled={busyAction !== null}
              onClick={() => submitAction({ intent: "approve" })}
            >
              {busyAction === "approve" ? "Approving..." : "Approve Flow"}
            </Button>
          ) : null}
        </div>

        {canStart && preanswerableQuestions.length > 0 ? (
          <fieldset className="space-y-2" disabled={busyAction !== null}>
            <legend className="mb-1 text-xs text-muted-foreground">Optional pre-answers</legend>
            {preanswerableQuestions.map((question) => (
              <form
                key={`${stream.projectId}:${stream.runId}:${question.stepId}:${question.saved?.seq ?? 0}`}
                className="flex flex-wrap items-end gap-2"
                onSubmit={(event) => {
                  event.preventDefault();
                  const select = event.currentTarget.elements.namedItem("choiceKey");
                  if (select instanceof HTMLSelectElement && select.value) {
                    void submitAction({ intent: "preanswer", stepId: question.stepId, choiceKey: select.value });
                  }
                }}
              >
                <label className="flex min-w-44 flex-col gap-1 text-xs">
                  <span>{question.title}</span>
                  <Select name="choiceKey" required defaultValue={question.saved?.choiceKey ?? ""}>
                    <option value="" disabled>Choose an answer</option>
                    {question.options.map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </Select>
                </label>
                <Button type="submit" size="sm" variant="outline">Save pre-answer</Button>
              </form>
            ))}
          </fieldset>
        ) : null}

        {canStart ? (
          <div className="flex justify-end">
            <Button
              type="button"
              size="sm"
              data-testid="flow-start-button"
              disabled={busyAction !== null}
              onClick={() => submitAction({ intent: "start" })}
            >
              <Play className="size-3.5" aria-hidden="true" />
              <span>{busyAction === "start" ? "Starting..." : "Start Run"}</span>
            </Button>
          </div>
        ) : null}

        {matchedDraftDiff ? (
          <div>
            <div className="label-mono mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
              Draft Diff
            </div>
            <pre
              data-testid="flow-planned-diff"
              className="max-h-48 overflow-auto rounded-md border border-border bg-background p-2 font-mono text-[11px] leading-relaxed"
            >
              {renderDiffLines(matchedDraftDiff)}
            </pre>
          </div>
        ) : null}

        {navState?.plannedRunId === stream.runId && navState.planWarning ? (
          <p role="status" className="font-mono text-xs">{navState.planWarning}</p>
        ) : null}

        {actionError ? (
          <p
            data-testid="flow-action-error"
            role="alert"
            className="flex items-center gap-1.5 font-mono text-xs text-destructive"
          >
            <AlertTriangle className="size-3.5 shrink-0" aria-hidden="true" />
            <span>{actionError}</span>
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
