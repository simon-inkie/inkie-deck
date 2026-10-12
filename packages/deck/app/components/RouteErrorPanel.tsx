/**
 * RouteErrorPanel - the shared error surface for route-level ErrorBoundaries.
 *
 * MC must stay usable when a route fails, so an error must never be a dead
 * end. Two principles:
 *
 * 1. SCOPED BLAST RADIUS: every content route under the shell exports an
 *    ErrorBoundary rendering this panel, so a loader/render failure in one
 *    pane (a thread, the board, the queue) shows IN that pane while the
 *    sidebar + nav keep working. Only a failure in the shell/root itself
 *    falls back to the full-page root boundary.
 *
 * 2. HONEST MESSAGING: MC is a tailnet-only internal tool - showing the real
 *    error message in production is a feature, not a leak. The operator (or the
 *    agent they paste it to) needs the actual failure text, not "Oops".
 *
 * Pure presentational: no fs, no env.
 * ASCII only - no em-dashes.
 */
import { isRouteErrorResponse, Link } from "react-router";
import { AlertTriangle, RefreshCw, Home } from "lucide-react";
import { Button, buttonVariants } from "./ui/button";
import { cn } from "~/lib/utils";

interface RouteErrorPanelProps {
  /** The error from Route.ErrorBoundaryProps. */
  error: unknown;
  /** What broke, in the operator's terms: "this thread", "the project board", ... */
  scope: string;
  /** Optional extra hint line for this surface. */
  hint?: string;
}

/** Extract the most useful human-readable detail from an unknown error. */
export function errorDetail(error: unknown): { title: string; detail: string; stack?: string } {
  if (isRouteErrorResponse(error)) {
    return {
      title: error.status === 404 ? "Not found" : `Error ${error.status}`,
      detail:
        error.status === 404
          ? "This page does not exist."
          : error.statusText || "The server returned an error for this request.",
    };
  }
  if (error instanceof Error) {
    return {
      title: error.name === "Error" ? "Something broke" : error.name,
      detail: error.message || "An error with no message was thrown.",
      stack: error.stack,
    };
  }
  return {
    title: "Something broke",
    detail: typeof error === "string" && error ? error : "An unknown error was thrown.",
  };
}

export function RouteErrorPanel({ error, scope, hint }: RouteErrorPanelProps) {
  const { title, detail, stack } = errorDetail(error);

  return (
    <div
      data-testid="route-error-panel"
      className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-4 p-6 text-center"
    >
      <AlertTriangle className="h-10 w-10 text-destructive" aria-hidden />
      <div>
        <h2 className="text-lg font-bold">{title} loading {scope}</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          The rest of Inkie Deck is still running - use the sidebar or the
          buttons below.
        </p>
      </div>
      <p
        data-testid="route-error-detail"
        className="w-full overflow-x-auto rounded-md border-2 border-destructive/30 bg-card p-3 text-left font-mono text-xs"
      >
        {detail}
      </p>
      {hint ? <p className="text-xs text-muted-foreground">{hint}</p> : null}
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={() => window.location.reload()}>
          <RefreshCw className="mr-1 h-4 w-4" aria-hidden /> Try again
        </Button>
        <Link to="/" className={cn(buttonVariants({ variant: "outline", size: "sm" }))}>
          <Home className="mr-1 h-4 w-4" aria-hidden /> Home
        </Link>
      </div>
      {stack ? (
        <details className="w-full text-left">
          <summary className="cursor-pointer text-xs text-muted-foreground">
            Stack trace
          </summary>
          <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-muted p-2 text-[10px] leading-tight">
            <code>{stack}</code>
          </pre>
        </details>
      ) : null}
    </div>
  );
}
