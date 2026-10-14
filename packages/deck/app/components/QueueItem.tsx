/**
 * QueueItem.tsx - Single row in the Needs you panel.
 *
 * Renders an agent name, preview text, and ageing string.
 * Overdue items carry a distinct red border and background.
 * A fetcher.Form posts the markHandled intent to the home route action (/).
 *
 * No .server imports - all data arrives via props.
 * ASCII only - no em-dashes.
 */
import { useFetcher, Link } from "react-router";
import type { QueueViewItem } from "~/lib/queue-derive";
import { Avatar } from "./ui/avatar";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

interface QueueItemProps {
  item: QueueViewItem;
}

/**
 * A single action-queue row.
 *
 * When overdue, applies a red border and background so the item stands out.
 * The Handled button posts intent=markHandled + itemId to the home action.
 * After the action resolves, RR7 auto-revalidates the home loader so the
 * item leaves the panel without a full page reload.
 *
 * Preview text is rendered as a plain JSX text node (auto-escaped by React).
 * No dangerouslySetInnerHTML is used.
 */
export function QueueItemRow({ item }: QueueItemProps) {
  const fetcher = useFetcher();
  const busy = fetcher.state !== "idle";

  return (
    <div
      data-testid="queue-item"
      className={cn(
        "mb-2 rounded-lg border bg-card p-3 transition-colors",
        item.overdue
          ? "border-destructive/40 bg-destructive/5"
          : "border-border"
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <Link
          to={`/threads/${item.agentName}`}
          prefetch="intent"
          className="flex min-w-0 flex-1 items-start gap-3 group"
        >
          <Avatar name={item.agentName} className="h-8 w-8 text-xs" />
          <div className="min-w-0 flex-1">
            {/* Agent name */}
            <p className="font-display text-xs font-bold uppercase tracking-tight text-foreground">
              {item.agentName}
            </p>

            {/* Preview */}
            <p className="truncate text-sm text-foreground/80 group-hover:text-foreground">
              {item.preview}
            </p>

            {/* Ageing string with overdue label */}
            <p
              className={cn(
                "mt-1.5 font-mono text-xs",
                item.overdue
                  ? "font-medium text-destructive"
                  : "text-muted-foreground"
              )}
            >
              {item.overdue ? "Overdue: " : ""}
              {item.ageDisplay}
            </p>
          </div>
        </Link>

        {/* Handled button */}
        {/* No explicit action: submits to the current route (routes/home index). */}
        {/* action="/" was submitting to the root layout route, not the index route. */}
        <fetcher.Form method="post">
          <input type="hidden" name="intent" value="markHandled" />
          <input type="hidden" name="itemId" value={item.id} />
          <Button
            type="submit"
            variant="outline"
            size="sm"
            disabled={busy}
            className="shrink-0"
          >
            {busy ? "Handling..." : "Handled"}
          </Button>
        </fetcher.Form>
      </div>
    </div>
  );
}
