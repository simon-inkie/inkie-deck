/**
 * EmptyState.tsx - Reusable positive empty state component.
 *
 * Renders a deliberate, positive empty state with a title and descriptive body.
 * Used for three states in this app:
 *   - No agents: no threads in the inbox root yet.
 *   - Empty thread: no messages in the selected thread.
 *   - Empty queue: no items needing attention.
 *
 * Callers supply the copy via props. ASCII only - no em-dashes.
 * No .server imports.
 */

import type { ComponentType } from "react";

interface EmptyStateProps {
  /** Short heading for the empty state. */
  title: string;
  /** Descriptive body text explaining what to expect or do next. */
  body: string;
  /** Optional decorative icon (e.g. a lucide-react component), rendered muted. */
  icon?: ComponentType<{ className?: string }>;
}

/**
 * Positive empty state panel.
 *
 * Renders a centered card with a title and body. The copy should be
 * encouraging rather than error-like - this is an expected state, not a fault.
 */
export function EmptyState({ title, body, icon: Icon }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-16 text-center">
      <div className="max-w-sm">
        {Icon ? (
          <Icon className="mx-auto mb-3 size-8 text-muted-foreground/40" />
        ) : null}
        <h2 className="mb-2 font-display text-lg font-bold tracking-tight text-foreground">
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{body}</p>
      </div>
    </div>
  );
}
