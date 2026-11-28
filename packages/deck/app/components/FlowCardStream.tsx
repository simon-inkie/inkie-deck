/**
 * FlowCardStream.tsx - Flow card stream and operator decisions.
 *
 * Pure UI component: zero .server or Node imports. Polls /api/flows every 1500ms
 * while the run is in an active status and stops cleanly when terminal or unmounted.
 *
 * ASCII only - no em-dashes.
 */

import { useEffect, useState } from "react";
import { AlertTriangle, CheckCircle2, Clock, Lock, ShieldCheck } from "lucide-react";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "./ui/card";
import { cn } from "~/lib/utils";
import type {
  FlowCardStreamView,
  FlowStepCard,
  FlowStepCardState,
} from "~/lib/flows/card-stream";

const ACTIVE_RUN_STATUSES = new Set([
  "planned",
  "approved",
  "running",
  "waiting_decision",
]);

function runStatusVariant(
  status: string,
): "default" | "secondary" | "outline" | "success" | "warning" | "destructive" {
  if (status === "finished") return "success";
  if (status === "stopped" || status === "corrupted") return "destructive";
  if (status === "waiting_decision" || status === "planned") return "warning";
  return "default";
}

function stepBadgeVariant(
  cardState: FlowStepCardState,
): "default" | "secondary" | "outline" | "success" | "warning" | "destructive" {
  if (cardState === "done") return "success";
  if (cardState === "failed") return "destructive";
  if (cardState === "current") return "default";
  return "outline";
}

function stepCardClassName(cardState: FlowStepCardState): string {
  if (cardState === "current") {
    return "border-blue-500/70 bg-blue-500/5 ring-1 ring-blue-500/30";
  }
  if (cardState === "failed") {
    return "border-destructive/70 bg-destructive/5";
  }
  if (cardState === "pending") {
    return "border-border/60 bg-muted/30 opacity-75";
  }
  return "border-border bg-card";
}

function StepEvidenceDetails({ step }: { step: FlowStepCard }) {
  const { artefacts, outputs, lastJudgement } = step.evidence;
  const outputEntries = Object.entries(outputs);
  const hasAny =
    artefacts.length > 0 || outputEntries.length > 0 || Boolean(lastJudgement);

  return (
    <details
      data-testid={`flow-step-evidence-${step.stepId}`}
      className="mt-2 rounded-md border border-border/70 bg-background/60 px-3 py-2 text-xs"
    >
      <summary className="label-mono cursor-pointer select-none font-medium text-muted-foreground hover:text-foreground">
        Evidence
      </summary>
      {!hasAny ? (
        <p className="mt-2 text-muted-foreground">No recorded evidence.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {artefacts.length > 0 ? (
            <div>
              <div className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Verified artefacts
              </div>
              <ul className="mt-1 space-y-1 font-mono text-[11px]">
                {artefacts.map((art) => (
                  <li key={`${art.artefactId}-${art.sha256}`} className="flex flex-wrap gap-2">
                    <span className="font-semibold text-foreground">{art.artefactId}</span>
                    <span className="text-muted-foreground">{art.sha256.slice(0, 12)}</span>
                    <span className="text-muted-foreground">{art.sizeBytes} B</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          {outputEntries.length > 0 ? (
            <div>
              <div className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Public outputs
              </div>
              <dl className="mt-1 grid grid-cols-1 gap-1 font-mono text-[11px] sm:grid-cols-2">
                {outputEntries.map(([key, value]) => (
                  <div key={key} className="flex gap-1.5">
                    <dt className="text-muted-foreground">{key}:</dt>
                    <dd className="truncate font-semibold text-foreground">{value}</dd>
                  </div>
                ))}
              </dl>
            </div>
          ) : null}

          {lastJudgement ? (
            <div>
              <div className="label-mono text-[10px] uppercase tracking-wider text-muted-foreground">
                Last judgement
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-2 font-mono text-[11px]">
                <span className="font-semibold text-foreground">{lastJudgement.final}</span>
                {lastJudgement.reasonCodes.length > 0 ? (
                  <span className="text-muted-foreground">
                    [{lastJudgement.reasonCodes.join(", ")}]
                  </span>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      )}
    </details>
  );
}

export interface FlowCardStreamProps {
  stream: FlowCardStreamView;
}

export function FlowCardStream({ stream: initialStream }: FlowCardStreamProps) {
  const [stream, setStream] = useState<FlowCardStreamView>(initialStream);
  const [pollError, setPollError] = useState<string | null>(null);
  const [submittingDecision, setSubmittingDecision] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);

  useEffect(() => {
    setStream(initialStream);
    setPollError(null);
    setDecisionError(null);
  }, [initialStream]);

  useEffect(() => {
    if (!ACTIVE_RUN_STATUSES.has(stream.runStatus)) {
      return;
    }

    let cancelled = false;
    let inFlight = false;
    let activeController: AbortController | null = null;
    const projectId = stream.projectId;
    const runId = stream.runId;

    const timer = window.setInterval(async () => {
      if (cancelled || inFlight) return;
      inFlight = true;
      const controller = new AbortController();
      activeController = controller;

      try {
        const res = await fetch(
          `/api/flows?project=${encodeURIComponent(projectId)}&run=${encodeURIComponent(runId)}`,
          {
            method: "GET",
            headers: { Accept: "application/json" },
            signal: controller.signal,
          },
        );
        const payload = (await res.json()) as {
          ok?: boolean;
          stream?: FlowCardStreamView;
          error?: string;
        };
        if (cancelled) return;

        if (res.ok && payload.ok && payload.stream) {
          const updated = payload.stream;
          setStream((current) =>
            current.runId === updated.runId && current.headSeq > updated.headSeq ? current : updated,
          );
          setPollError(null);
        } else if (res.status === 422 || res.status === 404 || res.status === 400) {
          setPollError(payload.error ?? "Flow stream stopped due to an error.");
          window.clearInterval(timer);
        } else {
          setPollError(payload.error ?? "Live refresh paused; retrying...");
        }
      } catch (err) {
        if (cancelled) return;
        if (err instanceof DOMException && err.name === "AbortError") return;
        setPollError("Live refresh paused; retrying...");
      } finally {
        inFlight = false;
        if (activeController === controller) {
          activeController = null;
        }
      }
    }, 1500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
      activeController?.abort();
    };
  }, [stream.projectId, stream.runId, stream.runStatus]);

  async function handleDecision(handoffId: string, choiceKey: string) {
    if (submittingDecision) return;
    const { projectId, runId } = stream;
    setSubmittingDecision(true);
    setDecisionError(null);
    try {
      const res = await fetch("/api/flows", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ intent: "decide", projectId, runId, handoffId, choiceKey }),
      });
      const payload = (await res.json()) as { ok?: boolean; error?: string; stream?: FlowCardStreamView };
      if (!res.ok || !payload.ok || !payload.stream) {
        setDecisionError(payload.error ?? "Could not submit the decision.");
        return;
      }
      const updated = payload.stream;
      setStream((current) =>
        current.projectId === projectId && current.runId === runId && current.headSeq <= updated.headSeq
          ? updated
          : current,
      );
    } catch {
      setDecisionError("Could not submit the decision.");
    } finally {
      setSubmittingDecision(false);
    }
  }

  const handoffId = stream.readOnly ? undefined : stream.activeDecision?.handoffId;

  return (
    <div className="space-y-4">
      <header className="rounded-lg border border-border bg-card p-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="font-display text-2xl font-black uppercase tracking-tight text-foreground">
              {stream.flowName}
            </h1>
            <Badge
              data-testid="flow-run-status"
              variant={runStatusVariant(stream.runStatus)}
            >
              {stream.runStatus}
            </Badge>
            {stream.waitingOn ? (
              <Badge data-testid="flow-waiting-on" variant="warning">
                Waiting on: {stream.waitingOn}
              </Badge>
            ) : null}
          </div>
          <Badge variant="outline" className="gap-1">
            <Lock className="size-3" aria-hidden="true" />
            SQLite stream
          </Badge>
        </div>

        <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 font-mono text-xs text-muted-foreground">
          <span>Project: {stream.projectId}</span>
          <span>Run: {stream.runId}</span>
          <span>Events: {stream.eventCount}</span>
          <span>Seq: {stream.headSeq}</span>
          <span data-testid="flow-budget-summary" className="font-semibold text-foreground">
            Steps: {stream.budget.stepsUsed} / {stream.budget.stepsTotal} | Tokens:{" "}
            {stream.budget.tokensUsed} / {stream.budget.tokensTotal}
          </span>
        </div>

        {stream.terminalReason === "runtime_adapter_missing" ? (
          <p role="status" className="mt-2 text-xs text-destructive">
            No runtime adapter is configured. Live runtimes arrive in slice 3b. For fixture mode, run{" "}
            <code>pnpm -C packages/deck exec vitest run test/flows/slice-3-e2e.test.ts</code>.
          </p>
        ) : null}
        {stream.terminalReason === "unanswered_expired" ? (
          <p role="status" className="mt-2 text-xs text-destructive">
            The decision expired. The run has stopped.
          </p>
        ) : null}
        {pollError ? (
          <p
            data-testid="flows-poll-error"
            role="status"
            className="mt-2 text-xs text-destructive"
          >
            {pollError}
          </p>
        ) : null}
      </header>

      <Card data-testid="flow-card-planning">
        <CardHeader className="pb-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide">
              <ShieldCheck className="size-4 text-primary" aria-hidden="true" />
              <span>Planning &amp; Pin</span>
            </CardTitle>
            <Badge
              data-testid="flow-planning-approval"
              variant={stream.planningCard.approved ? "success" : "warning"}
            >
              {stream.planningCard.approved ? "Approved" : "Awaiting approval"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-2 font-mono text-xs sm:grid-cols-2">
          <div>
            <span className="text-muted-foreground">Flow: </span>
            <span className="font-semibold text-foreground">
              {stream.planningCard.flowRef} v{stream.flowVersion}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Source: </span>
            <span className="font-semibold text-foreground">
              {stream.planningCard.source}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Hash: </span>
            <span className="font-semibold text-foreground">
              {stream.planningCard.flowHash.slice(0, 12)}
            </span>
          </div>
          <div>
            <span className="text-muted-foreground">Expected decisions: </span>
            <span className="font-semibold text-foreground">
              {stream.planningCard.expectedDecisions.length > 0
                ? stream.planningCard.expectedDecisions.join(", ")
                : "none"}
            </span>
          </div>
        </CardContent>
      </Card>

      {stream.activeDecision ? (
        <Card
          data-testid="flow-card-decision"
          className="border-accent bg-accent/5 shadow-retro"
        >
          <CardHeader className="pb-2">
            <CardTitle className="flex items-center gap-2 text-sm uppercase tracking-wide text-accent">
              <AlertTriangle className="size-4" aria-hidden="true" />
              <span>Decision Required ({stream.activeDecision.stepId})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            <div className="font-mono">
              <span className="text-muted-foreground">Reason: </span>
              <span className="font-semibold text-foreground">
                {stream.activeDecision.reasonCode}
              </span>
            </div>
            <div className="flex flex-wrap gap-2">
              {stream.activeDecision.options.map((opt) =>
                handoffId ? (
                  <Button
                    key={opt.key}
                    type="button"
                    variant="outline"
                    size="sm"
                    disabled={submittingDecision}
                    onClick={() => handleDecision(handoffId, opt.key)}
                  >
                    {opt.label}
                  </Button>
                ) : (
                  <span key={opt.key} className="font-mono text-xs">{opt.label}</span>
                ),
              )}
            </div>
            {decisionError ? <p role="alert" className="text-destructive">{decisionError}</p> : null}
          </CardContent>
        </Card>
      ) : null}

      <section aria-label="Flow steps" data-testid="flow-steps-list" className="space-y-3">
        {stream.stepCards.map((step) => {
          const reasonCodes = step.evidence.lastJudgement?.reasonCodes ?? [];
          return (
            <Card
              key={step.stepId}
              data-testid={`flow-step-card-${step.stepId}`}
              data-card-state={step.cardState}
              className={cn(stepCardClassName(step.cardState))}
            >
              <CardHeader className="py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-mono text-sm font-bold text-foreground">
                      {step.stepId}
                    </span>
                    <Badge variant="outline" className="font-mono text-[10px]">
                      {step.stepType}
                    </Badge>
                    <Badge
                      data-testid={`flow-step-badge-${step.stepId}`}
                      variant={stepBadgeVariant(step.cardState)}
                    >
                      {step.cardState}
                    </Badge>
                    {step.rewindLabel ? (
                      <Badge
                        data-testid={`flow-step-rewind-${step.stepId}`}
                        variant="warning"
                      >
                        {step.rewindLabel}
                      </Badge>
                    ) : null}
                  </div>
                  <span className="font-mono text-xs text-muted-foreground">
                    {step.stepStatus} | {step.tokensUsed} tokens | {step.wallTimeMs} ms
                  </span>
                </div>
              </CardHeader>
              <CardContent className="pt-0 pb-3 text-xs">
                <div className="flex items-center gap-2 text-muted-foreground">
                  {step.cardState === "done" ? (
                    <CheckCircle2 className="size-3.5 shrink-0 text-primary" aria-hidden="true" />
                  ) : step.cardState === "failed" ? (
                    <AlertTriangle className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
                  ) : (
                    <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  )}
                  <span className="font-mono text-foreground">{step.summary}</span>
                </div>

                {step.cardState === "failed" && reasonCodes.length > 0 ? (
                  <p className="mt-1.5 font-mono text-[11px] text-destructive">
                    Reasons: {reasonCodes.join(", ")}
                  </p>
                ) : null}

                {step.cardState === "done" ||
                step.cardState === "failed" ||
                step.evidence.artefacts.length > 0 ||
                Object.keys(step.evidence.outputs).length > 0 ||
                step.evidence.lastJudgement ? (
                  <StepEvidenceDetails step={step} />
                ) : null}
              </CardContent>
            </Card>
          );
        })}
      </section>

      {stream.terminalOutcome ? (
        <div
          data-testid="flow-terminal-banner"
          role="status"
          className={cn(
            "rounded-lg border p-4 font-mono text-xs",
            stream.terminalOutcome === "done"
              ? "border-primary/40 bg-primary/10 text-foreground"
              : "border-destructive/40 bg-destructive/10 text-foreground",
          )}
        >
          <span className="font-bold uppercase">Terminal: {stream.terminalOutcome}</span>
          {stream.terminalReason ? (
            <span className="ml-2 text-muted-foreground">
              ({stream.terminalReason})
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
