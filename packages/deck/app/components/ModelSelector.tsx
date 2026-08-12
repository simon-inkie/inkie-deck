/**
 * ModelSelector.tsx - per-agent model chip + dropdown for the top bar (M5/M6).
 *
 * Renders the active thread agent's CONFIGURED model (the .model file via the
 * shell loader; "default" when absent = inherit the global default) as a chip
 * that opens a dropdown of the catalog options for that agent's runtime.
 * Picking one POSTs to /api/agent-model (persist-only v1) and the footer note
 * flips to "applies on restart" - no live pane switch happens.
 *
 * DISPLAY HONESTY (M6): the chip is the configured model, not the running
 * one. A manual in-session /model can diverge until restart; the chip tooltip
 * says exactly that. No live polling of the actual running model in v1.
 *
 * GATING: this component only mounts when the shell loader passed data, which
 * it only does on operator instances (modelSelectorEnabled) for agents whose
 * runtime has catalog options - absence is structural, like TmuxPane's
 * read-only fallback. The api route re-checks the gate server-side.
 *
 * No .server imports - FND-02 (the useFetcher POST does the server work).
 * ASCII only - no em-dashes (FND-05).
 */
import { useFetcher } from "react-router";
import { Check, Cpu } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "./ui/dropdown-menu";

/** Mirrors agent-model.server's CatalogOption (structural - no .server import). */
export interface ModelOption {
  id: string;
  label: string;
}

/** The shell loader's view-model for the active thread's selector. */
export interface ModelSelectorData {
  agent: string;
  /** Configured model id from .model; null = inherit the global default. */
  model: string | null;
  options: ModelOption[];
}

type PostData =
  | { persisted: true; liveSwitched: false }
  | { error: string };

export function ModelSelector({ data }: { data: ModelSelectorData }) {
  const fetcher = useFetcher<PostData>();
  const busy = fetcher.state !== "idle";

  // Optimistic chip: while a pick is in flight, show the submitted id; the
  // loader revalidation lands the on-disk truth right behind it.
  const pendingId = busy ? fetcher.formData?.get("model")?.toString() : undefined;
  const currentId = pendingId ?? data.model;
  const current = data.options.find((o) => o.id === currentId);
  const chipLabel =
    currentId === null || currentId === undefined
      ? "default"
      : current?.label ?? currentId;

  const saved =
    fetcher.data !== undefined && "persisted" in fetcher.data && !busy;
  const error =
    fetcher.data !== undefined && "error" in fetcher.data
      ? fetcher.data.error
      : undefined;

  function pick(id: string) {
    if (busy || id === data.model) return;
    fetcher.submit(
      { agent: data.agent, model: id },
      { method: "post", action: "/api/agent-model" }
    );
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        {/* Configured-model chip - desktop only (the mobile top bar is full;
            Alex's 2026-06-11 mobile pass moved nav OUT of it, so this
            operator control stays md+). */}
        <button
          type="button"
          data-testid="model-selector-chip"
          title="Configured model; a manual in-session /model switch may differ until restart"
          aria-label={`${data.agent}'s model: ${chipLabel}`}
          className="label-mono ml-1 hidden min-h-9 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring md:inline-flex"
        >
          <Cpu className="size-3.5" />
          <span data-testid="model-selector-current">{chipLabel}</span>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuLabel>{data.agent}'s model</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {data.options.map((option) => (
          <DropdownMenuItem
            key={option.id}
            data-testid={`model-option-${option.id}`}
            onSelect={() => pick(option.id)}
          >
            <span className="flex w-full items-center gap-2">
              <span className="text-sm text-foreground">{option.label}</span>
              <span className="label-mono ml-auto text-[10px] text-muted-foreground">
                {option.id}
              </span>
              {option.id === currentId ? (
                <Check className="size-4 shrink-0 text-primary" aria-hidden="true" />
              ) : null}
            </span>
          </DropdownMenuItem>
        ))}
        <DropdownMenuSeparator />
        {error !== undefined ? (
          <p
            data-testid="model-selector-error"
            className="label-mono px-2 py-1 text-[10px] text-destructive"
          >
            {error}
          </p>
        ) : null}
        {/* Persist-only honesty: the pick survives restart, it does not hot-
            swap the running session. */}
        <p
          data-testid="model-selector-note"
          className="label-mono px-2 py-1 text-[10px] text-muted-foreground"
        >
          {saved
            ? "Saved - applies on the agent's next restart."
            : "Persists to boot config - applies on the agent's next restart."}
        </p>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
