/**
 * QueuePanel.tsx - The "Needs you" panel on the home route.
 *
 * Renders a ranked list of unhandled action-queue items (overdue first, then
 * soonest deadline). When no items remain, renders the positive empty state.
 *
 * No .server imports - all data arrives via props from loaderData.
 * ASCII only - no em-dashes.
 */
import { CheckCircle2 } from "lucide-react";
import type { QueueViewItem } from "~/lib/queue-derive";
import { QueueItemRow } from "./QueueItem";
import { EmptyState } from "./EmptyState";

interface QueuePanelProps {
  /** All unhandled queue items for display, pre-sorted by the loader. */
  items: QueueViewItem[];
}

/**
 * Needs you panel.
 *
 * When items is empty, renders the positive empty state.
 * Otherwise renders a keyed list of QueueItemRow components.
 * The item.id key is stable (it comes from deriveItemId).
 */
export function QueuePanel({ items }: QueuePanelProps) {
  if (items.length === 0) {
    return (
      <div data-testid="queue-empty-state">
        <EmptyState
          icon={CheckCircle2}
          title="Nothing needs you"
          body="Items that need a decision will collect here."
        />
      </div>
    );
  }

  return (
    <div>
      {items.map((item) => (
        <QueueItemRow key={item.id} item={item} />
      ))}
    </div>
  );
}
