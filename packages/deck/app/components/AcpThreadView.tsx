import { useCallback, useEffect, useMemo, useState } from "react";
import type { DeckEvent } from "~/lib/deck-event";
import type { UsageReading } from "~/lib/runner/acp-manifest";

export interface AcpThreadStatus {
  state: "starting" | "running" | "stopping" | "cleanup-pending" | "stopped" | "locked" | "unavailable";
  capabilities?: Record<string, unknown>;
  supportsResume?: boolean;
  queuedCount?: number;
  authRequired?: boolean;
  contextUsage?: { used: number; size: number };
  reason?: string;
}

export interface AcpThreadViewProps {
  agent: string;
  initialStatus: AcpThreadStatus;
  initialEvents: DeckEvent[];
  initialLastSessionId: string | null;
  initialUsageReading: UsageReading;
  canWrite: boolean;
}

/**
 * Derive deduplicated renderable cards from raw ACP DeckEvents.
 * Tool updates are upserted in place by dedupeKey.
 * Reasoning chunks never reach DeckEvent and are never displayed.
 */
export function deriveAcpCards(events: DeckEvent[]): {
  cards: DeckEvent[];
  answeredIds: Set<string>;
} {
  const answeredIds = new Set<string>();
  for (const ev of events) {
    if (ev.type === "permission.answered" && ev.answers) {
      answeredIds.add(ev.answers);
    }
  }

  const cards: DeckEvent[] = [];
  const toolIndex = new Map<string, number>();

  for (const ev of events) {
    if (ev.type === "permission.answered") continue;
    if (ev.type === "tool.updated" && ev.dedupeKey) {
      const existing = toolIndex.get(ev.dedupeKey);
      if (existing !== undefined) {
        cards[existing] = ev;
      } else {
        toolIndex.set(ev.dedupeKey, cards.length);
        cards.push(ev);
      }
    } else {
      cards.push(ev);
    }
  }

  return { cards, answeredIds };
}

export function AcpThreadView({
  agent,
  initialStatus,
  initialEvents,
  initialLastSessionId,
  initialUsageReading,
  canWrite,
}: AcpThreadViewProps) {
  const [status, setStatus] = useState<AcpThreadStatus>(initialStatus);
  const [events, setEvents] = useState<DeckEvent[]>(initialEvents);
  const [lastSessionId, setLastSessionId] = useState<string | null>(initialLastSessionId);
  const [usageReading, setUsageReading] = useState<UsageReading>(initialUsageReading);
  const [promptText, setPromptText] = useState("");
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [busyOp, setBusyOp] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/acp?agent=${encodeURIComponent(agent)}`);
      if (!res.ok) return;
      const payload = await res.json();
      if (payload.ok) {
        setStatus(payload.status);
        setEvents(payload.events ?? []);
        setLastSessionId(payload.lastSessionId ?? null);
        if (payload.usageReading) setUsageReading(payload.usageReading);
      }
    } catch {
      // Ignore transient poll failures.
    }
  }, [agent]);

  useEffect(() => {
    if (status.state !== "starting" && status.state !== "running" && status.state !== "stopping") return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [status.state, refresh]);

  const postOp = useCallback(async (body: Record<string, unknown>) => {
    setErrorBanner(null);
    setBusyOp(true);
    try {
      const res = await fetch("/api/acp", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agent, ...body }),
      });
      const payload = await res.json().catch(() => ({ ok: false, error: "Request failed." }));
      if (!res.ok || !payload.ok) {
        setErrorBanner(payload.error ?? "ACP operation failed.");
      }
      await refresh();
    } catch {
      setErrorBanner("Network error while calling ACP endpoint.");
    } finally {
      setBusyOp(false);
    }
  }, [agent, refresh]);

  const { cards, answeredIds } = useMemo(() => deriveAcpCards(events), [events]);
  const isActive = status.state === "running" || status.state === "starting";
  const canStop = isActive || status.state === "cleanup-pending";
  // Major 3: Registry persists lastSessionId ONLY for agents advertising resume/load capability
  const showResume = Boolean(lastSessionId && !isActive && status.state !== "cleanup-pending");
  const advertisedCapNames = useMemo(() => {
    if (!status.capabilities) return [];
    const caps: string[] = [];
    if (status.capabilities.loadSession) caps.push("loadSession");
    const sc = status.capabilities.sessionCapabilities as Record<string, unknown> | undefined;
    if (sc && typeof sc === "object") {
      for (const k of Object.keys(sc)) {
        if (sc[k]) caps.push(`session.${k}`);
      }
    }
    return caps;
  }, [status.capabilities]);

  return (
    <section data-testid="acp-thread-view" className="flex flex-col gap-4 p-4">
      <header className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <span>ACP Runner</span>
            <span data-testid="acp-status-badge" className="rounded bg-muted px-2 py-0.5 text-xs uppercase">
              {status.state}
            </span>
          </div>
          {status.contextUsage && (
            <div data-testid="acp-context-usage" className="text-xs text-muted-foreground">
              Context: {status.contextUsage.used} / {status.contextUsage.size} tokens
            </div>
          )}
          <div data-testid="acp-quota-reading" className="text-xs text-muted-foreground">
            Quota ({usageReading.source}): {usageReading.state}
          </div>
          {advertisedCapNames.length > 0 && (
            <div data-testid="acp-capabilities" className="text-xs text-muted-foreground">
              Capabilities: {advertisedCapNames.join(", ")}
            </div>
          )}
        </div>

        {canWrite && (
          <div className="flex flex-wrap items-center gap-2">
            {!isActive && status.state !== "cleanup-pending" && (
              <button
                type="button"
                disabled={busyOp}
                onClick={() => void postOp({ op: "start", resume: false })}
                className="rounded border px-3 py-1 text-xs font-medium"
              >
                Start
              </button>
            )}
            {showResume && (
              <button
                type="button"
                disabled={busyOp}
                onClick={() => void postOp({ op: "start", resume: true })}
                className="rounded border px-3 py-1 text-xs font-medium"
              >
                Resume last session
              </button>
            )}
            {status.state === "running" && (
              <button
                type="button"
                disabled={busyOp}
                onClick={() => void postOp({ op: "cancel" })}
                className="rounded border px-3 py-1 text-xs font-medium"
              >
                Interrupt
              </button>
            )}
            {canStop && (
              <button
                type="button"
                disabled={busyOp}
                onClick={() => void postOp({ op: "stop" })}
                className="rounded border px-3 py-1 text-xs font-medium"
              >
                {status.state === "cleanup-pending" ? "Retry cleanup" : "Stop"}
              </button>
            )}
          </div>
        )}
      </header>

      {errorBanner && (
        <div role="alert" data-testid="acp-error-banner" className="rounded border border-destructive p-3 text-xs">
          {errorBanner}
        </div>
      )}

      <div data-testid="acp-cards-list" className="flex flex-col gap-3">
        {cards.length === 0 && (
          <p className="text-xs text-muted-foreground">No ACP events yet.</p>
        )}
        {cards.map((ev) => {
          const isAnswered = answeredIds.has(ev.id);
          return (
            <article
              key={ev.dedupeKey ?? ev.id}
              data-testid={`acp-card-${ev.type}`}
              className="rounded-lg border p-3 text-sm"
            >
              <div className="flex items-center justify-between gap-2 text-xs font-medium text-muted-foreground">
                <span>{ev.title}</span>
                <span>{ev.type}</span>
              </div>

              {ev.view.kind === "text" && (
                <p className="mt-1 whitespace-pre-wrap text-sm">{ev.view.excerpt}</p>
              )}

              {ev.view.kind === "tool" && (
                <div className="mt-1 text-xs">
                  <div>
                    {ev.view.name} ({ev.view.toolKind}) - {ev.view.status}
                  </div>
                  {ev.view.paths.length > 0 && (
                    <div className="mt-1 text-muted-foreground">{ev.view.paths.join(", ")}</div>
                  )}
                </div>
              )}

              {ev.view.kind === "turn" && (
                <div className="mt-1 text-xs">
                  Outcome: {ev.view.outcome} ({ev.view.reason})
                </div>
              )}

              {ev.view.kind === "permission" && (
                <div className="mt-2 flex flex-col gap-2">
                  <div className="text-xs">Tool: {ev.view.tool}</div>
                  {isAnswered || status.state !== "running" ? (
                    <div data-testid="acp-permission-resolved" className="text-xs text-muted-foreground">
                      {isAnswered ? "Resolved" : "Closed"}
                    </div>
                  ) : (
                    <div className="flex flex-wrap gap-2">
                      {ev.view.options.map((opt) => (
                        <button
                          key={opt.id}
                          type="button"
                          disabled={!canWrite || busyOp}
                          onClick={() => void postOp({ op: "answer-permission", eventId: ev.id, optionId: opt.id })}
                          className="rounded border px-2 py-1 text-xs"
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </article>
          );
        })}
      </div>

      {canWrite && status.state === "running" && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const text = promptText.trim();
            if (!text) return;
            setPromptText("");
            void postOp({ op: "prompt", text });
          }}
          className="flex flex-col gap-2"
        >
          {(status.queuedCount ?? 0) > 0 && (
            <div data-testid="acp-queued-indicator" className="text-xs text-muted-foreground">
              Queued: {status.queuedCount}
            </div>
          )}
          <div className="flex gap-2">
            <input
              type="text"
              value={promptText}
              onChange={(e) => setPromptText(e.target.value)}
              placeholder="Send a prompt to the ACP agent..."
              className="flex-1 rounded border px-3 py-1.5 text-sm"
            />
            <button type="submit" disabled={busyOp || !promptText.trim()} className="rounded border px-3 py-1.5 text-sm">
              Send
            </button>
          </div>
        </form>
      )}
    </section>
  );
}
